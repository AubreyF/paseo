import { isDeepStrictEqual } from "node:util";
import type {
  QuotaAccount,
  QuotaGovernorPolicy,
  QuotaObservation,
} from "@getpaseo/protocol/quota-governor";
import type {
  QuotaAdmissionGuard,
  QuotaAdmissionRequest,
  QuotaAdmissionPermit,
} from "../agent-sdk-types.js";
import { evaluateQuotaGovernor } from "./governor-evaluate.js";
import type { GovernorExecution, GovernorExecutionEvent } from "./governor-lifecycle.js";
import { QuotaGovernorStore } from "./governor-store.js";

export interface QuotaExecutionSettlement {
  executionId: string;
  authenticationGeneration: string;
  settlementId: string;
}

export interface QuotaSupervisorOptions {
  store: QuotaGovernorStore;
  account: QuotaAccount;
  reservationId: string;
  executionId: string;
  authenticationGeneration: string;
  /** Read through the captured executing provider connection, not a provider alias lookup. */
  readObservation(): Promise<QuotaObservation>;
  /** Validate the trusted coordinator lease and captured authentication generation synchronously. */
  assertAuthority(): void;
  /** Stop and prove settlement of this exact execution and all its owned work. An interrupt ACK is insufficient. */
  freezeAndSettle(executionId: string): Promise<QuotaExecutionSettlement>;
  onFailure(error: unknown): void;
  nowMs?: () => number;
  pollIntervalMs?: number;
  readTimeoutMs?: number;
}

const supervisors = new Set<string>();

/** One captured execution. Frozen work resumes through a new supervisor and execution identity. */
export class QuotaExecutionSupervisor {
  private readonly nowMs: () => number;
  private readonly pollIntervalMs: number;
  private readonly readTimeoutMs: number;
  private epoch = 0;
  private freshnessTimer: ReturnType<typeof setTimeout> | undefined;
  private monitoring = false;
  private latestObservation: QuotaObservation;
  private revoked = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;
  private freezing: Promise<GovernorExecution> | undefined;
  private persistence: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly options: QuotaSupervisorOptions,
    private readonly policy: QuotaGovernorPolicy,
    observation: QuotaObservation,
    private readonly key: string,
  ) {
    this.latestObservation = observation;
    this.nowMs = options.nowMs ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.readTimeoutMs = options.readTimeoutMs ?? 10_000;
    if (
      !Number.isFinite(this.pollIntervalMs) ||
      this.pollIntervalMs < 100 ||
      this.pollIntervalMs > 30_000 ||
      !Number.isFinite(this.readTimeoutMs) ||
      this.readTimeoutMs < 100 ||
      this.readTimeoutMs > 10_000
    ) {
      throw new Error("Invalid quota supervision interval.");
    }
  }

  static async attach(options: QuotaSupervisorOptions): Promise<QuotaExecutionSupervisor> {
    const key = JSON.stringify([
      options.store.accountPath(options.account),
      options.reservationId,
      options.executionId,
    ]);
    if (supervisors.has(key)) throw new Error("Quota execution already has a supervisor.");
    supervisors.add(key);
    try {
      const context = await options.store.executionContext(options.account, options.reservationId);
      assertExecution(context.execution, options);
      options.assertAuthority();
      return new QuotaExecutionSupervisor(options, context.policy, context.observation, key);
    } catch (error) {
      supervisors.delete(key);
      throw error;
    }
  }

  readonly guard: QuotaAdmissionGuard = async (request) => this.admit(request);

  /** Calling again cannot create an overlapping telemetry loop. */
  startMonitoring(): void {
    if (this.revoked || this.monitoring) return;
    this.monitoring = true;
    this.armFreshness();
    this.schedulePoll(0);
  }

  private schedulePoll(delay: number): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.checkNow().catch((error) => this.options.onFailure(error));
    }, delay);
    this.pollTimer.unref?.();
  }

  checkNow(): Promise<void> {
    if (this.polling) return this.polling;
    if (this.revoked) return Promise.resolve();
    if (!this.monitoring) {
      this.monitoring = true;
      this.armFreshness();
    }
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.polling = this.checkActive().finally(() => {
      this.polling = undefined;
      if (!this.revoked) this.schedulePoll(this.pollIntervalMs);
    });
    return this.polling;
  }

  private async checkActive(): Promise<void> {
    try {
      this.options.assertAuthority();
      const execution = await this.options.store.execution(
        this.options.account,
        this.options.reservationId,
      );
      if (execution.state === "completed") {
        await this.retireAfterCompletion();
        return;
      }
      assertExecution(execution, this.options);
      const observation = await this.readBounded();
      if (this.revoked) return;
      if (!this.acceptObservation(observation)) return;
      const decision = evaluateQuotaGovernor({
        policy: this.policy,
        observation,
        nowMs: this.nowMs(),
        phase: "active",
      });
      if (decision.action === "freeze") await this.freeze("quota");
    } catch (error) {
      // Loss of authority or telemetry cannot leave active usage ungoverned.
      await this.freeze("quota");
      throw error;
    }
  }

  private async readBounded(): Promise<QuotaObservation> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.options.readObservation()),
        new Promise<QuotaObservation>((resolve) => {
          timer = setTimeout(
            () => resolve({ status: "unavailable", reason: "read_failed" }),
            this.readTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async admit(request: QuotaAdmissionRequest): Promise<QuotaAdmissionPermit> {
    if (this.revoked) throw new Error("Quota execution admission is revoked.");
    this.startMonitoring();
    this.options.assertAuthority();
    const execution = await this.options.store.execution(
      this.options.account,
      this.options.reservationId,
    );
    assertExecution(execution, this.options);
    if (!this.acceptObservation(request.observation))
      throw new Error("Quota observation regressed or conflicts with newer evidence.");
    const active = evaluateQuotaGovernor({
      policy: this.policy,
      observation: request.observation,
      nowMs: this.nowMs(),
      phase: "active",
    });
    if (active.action === "freeze") {
      void this.freeze("quota").catch((error) => this.options.onFailure(error));
      throw new Error("Quota active safety requires freeze.");
    }
    const epoch = this.epoch;
    const admittedAt = this.nowMs();
    const decision = evaluateQuotaGovernor({
      policy: this.policy,
      observation: request.observation,
      nowMs: admittedAt,
      phase: "admission",
    });
    if (decision.action !== "admit") {
      if (decision.action === "freeze") {
        // Do not await our own pending native start. Record/revoke now; settlement runs separately.
        void this.freeze("quota").catch((error) => this.options.onFailure(error));
      }
      throw new Error(`Quota admission ${decision.action}.`);
    }
    if (request.observation.status !== "available")
      throw new Error("Quota observation unavailable.");
    const expiresAt = Math.min(
      admittedAt + 1_000,
      Date.parse(request.observation.observedAt) + this.policy.maxObservationAgeSeconds * 1_000,
    );
    return {
      assertValidForDispatch: () => {
        this.options.assertAuthority();
        const now = this.nowMs();
        if (this.revoked || this.epoch !== epoch || now < admittedAt || now >= expiresAt) {
          throw new Error("Quota admission permit expired or was revoked.");
        }
      },
    };
  }

  /** Revoke synchronously, persist freeze intent, then require an exact custody receipt. */
  freeze(reason: "quota" | "manual"): Promise<GovernorExecution> {
    this.revoked = true;
    this.epoch += 1;
    clearTimeout(this.freshnessTimer);
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (this.freezing) {
      if (reason === "manual") {
        const paused = this.persist({ type: "freeze", reason });
        return Promise.all([paused, this.freezing]).then(() =>
          this.options.store.execution(this.options.account, this.options.reservationId),
        );
      }
      return this.freezing;
    }
    this.freezing = this.freezeExecution(reason);
    return this.freezing;
  }

  private async freezeExecution(reason: "quota" | "manual"): Promise<GovernorExecution> {
    let recorded: GovernorExecution | undefined;
    let recordError: unknown;
    const recording = this.persist({ type: "freeze", reason });
    // The existing durable reservation already blocks new work. Stopping cannot
    // wait for a stalled disk; settlement is still withheld until intent is durable.
    const stopping = Promise.resolve().then(() =>
      this.options.freezeAndSettle(this.options.executionId),
    );
    let recordTimer: ReturnType<typeof setTimeout> | undefined;
    const boundedRecording = Promise.race([
      recording,
      new Promise<never>((_, reject) => {
        recordTimer = setTimeout(
          () => reject(new Error("Quota freeze persistence timed out.")),
          1_000,
        );
      }),
    ]).finally(() => clearTimeout(recordTimer));
    const [recordResult, stopResult] = await Promise.allSettled([boundedRecording, stopping]);
    try {
      if (recordResult.status === "rejected") throw recordResult.reason;
      recorded = recordResult.value;
    } catch (error) {
      recordError = error;
    }
    // Even failed persistence must not prevent stopping the captured execution.
    if (stopResult.status === "rejected") throw stopResult.reason;
    const settlement = stopResult.value;
    if (
      settlement.executionId !== this.options.executionId ||
      settlement.authenticationGeneration !== this.options.authenticationGeneration ||
      !settlement.settlementId.trim()
    ) {
      throw new Error("Quota execution settlement identity mismatch.");
    }
    if (!recorded) throw recordError ?? new Error("Quota freeze intent is unconfirmed.");
    const frozen = await this.persist({
      type: "settled",
      executionId: this.options.executionId,
      settlementId: settlement.settlementId,
    });
    supervisors.delete(this.key);
    return frozen;
  }

  private acceptObservation(observation: QuotaObservation): boolean {
    if (observation.status === "available" && this.latestObservation.status === "available") {
      const next = Date.parse(observation.observedAt);
      const previous = Date.parse(this.latestObservation.observedAt);
      if (next < previous) return false;
      if (next === previous && !isDeepStrictEqual(observation, this.latestObservation)) {
        // Millisecond timestamps do not order conflicting account observations.
        void this.freeze("quota").catch((error) => this.options.onFailure(error));
        return false;
      }
    }
    if (!isDeepStrictEqual(observation, this.latestObservation)) {
      this.epoch += 1;
      this.latestObservation = observation;
      if (this.monitoring) this.armFreshness();
    }
    return true;
  }

  private armFreshness(): void {
    clearTimeout(this.freshnessTimer);
    const observedAt =
      this.latestObservation.status === "available"
        ? Date.parse(this.latestObservation.observedAt)
        : -Infinity;
    const now = this.nowMs();
    const remaining =
      observedAt > now ? 0 : observedAt + this.policy.maxObservationAgeSeconds * 1_000 - now;
    this.freshnessTimer = setTimeout(
      () => {
        void this.freeze("quota").catch((error) => this.options.onFailure(error));
      },
      Math.max(0, Number.isFinite(remaining) ? remaining : 0),
    );
    this.freshnessTimer.unref?.();
  }

  async retireAfterCompletion(): Promise<void> {
    const current = await this.options.store.execution(
      this.options.account,
      this.options.reservationId,
    );
    if (
      current.state !== "completed" ||
      current.executionId !== this.options.executionId ||
      current.authenticationGeneration !== this.options.authenticationGeneration ||
      !current.settlementId
    ) {
      throw new Error("Quota completion settlement is unconfirmed.");
    }
    this.revoked = true;
    this.epoch += 1;
    clearTimeout(this.pollTimer);
    clearTimeout(this.freshnessTimer);
    supervisors.delete(this.key);
  }

  private persist(event: GovernorExecutionEvent): Promise<GovernorExecution> {
    const operation = this.persistence
      .catch(() => undefined)
      .then(async () => {
        const current = await this.options.store.execution(
          this.options.account,
          this.options.reservationId,
        );
        assertExecution(current, this.options, true);
        const result = await this.options.store.transition({
          account: this.options.account,
          reservationId: this.options.reservationId,
          expectedGeneration: current.generation,
          event,
          nowMs: this.nowMs(),
        });
        if (result.kind !== "transitioned")
          throw new Error(`Quota state persistence deferred: ${result.reason}.`);
        return result.execution;
      });
    this.persistence = operation;
    return operation;
  }
}

function assertExecution(
  execution: GovernorExecution,
  options: QuotaSupervisorOptions,
  allowFreezing = false,
): void {
  const states = allowFreezing
    ? ["starting", "running", "freezing", "frozen"]
    : ["starting", "running"];
  if (
    execution.executionId !== options.executionId ||
    execution.authenticationGeneration !== options.authenticationGeneration ||
    !states.includes(execution.state)
  ) {
    throw new Error("Quota execution ownership requires reconciliation.");
  }
}
