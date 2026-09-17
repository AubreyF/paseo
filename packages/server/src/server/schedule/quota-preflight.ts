import { isDeepStrictEqual } from "node:util";
import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import type { QuotaObservation } from "@getpaseo/protocol/quota-governor";
import { evaluateQuotaGovernor } from "../agent/quota-reserve/governor-evaluate.js";
import type { ScheduleServiceOptions } from "./service.js";

type QuotaRunner = NonNullable<ScheduleServiceOptions["quotaRunner"]>;
type Preparation = Awaited<ReturnType<QuotaRunner["prepare"]>>;

export interface QuotaScheduleExecution extends QuotaRunner {
  /** Reconcile retained custody without inference, including during quota holds. */
  reconcile(schedule: StoredSchedule): Promise<void>;
}

interface PreflightOptions {
  readObservation(providerId: string): Promise<QuotaObservation>;
  /** The governed driver owns claims, pacing, captured credentials and execution permits. */
  execution?: QuotaScheduleExecution;
  nowMs?: () => number;
}

/** Metadata-only admission checks. No fallback to the ordinary coding runner. */
export class QuotaSchedulePreflight implements QuotaRunner {
  private readonly nowMs: () => number;
  private readonly holds = new Map<
    string,
    {
      target: StoredSchedule["target"];
      scheduledFor: string;
      checkedAt: number;
      retryAt: number;
      reason: string;
    }
  >();
  private stopped = false;

  constructor(private readonly options: PreflightOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  stop(): void {
    this.stopped = true;
    this.holds.clear();
  }

  private expireHolds(now: number): void {
    for (const [id, hold] of this.holds) {
      if (now < hold.checkedAt || now >= hold.retryAt) this.holds.delete(id);
    }
  }

  private backendDeferral(
    prepared: Extract<Preparation, { kind: "deferred" }>,
    hold: (reason: string) => Preparation,
  ): Preparation {
    return prepared.custody === "none" ? hold(prepared.reason) : prepared;
  }

  async reconcilePreparation(schedule: StoredSchedule): Promise<"clear" | "resume" | "held"> {
    // A missing backend cannot prove that a previous backend left no resources.
    return (await this.options.execution?.reconcilePreparation?.(schedule)) ?? "held";
  }

  async prepare(schedule: StoredSchedule, scheduledFor: string): Promise<Preparation> {
    if (this.stopped) return { kind: "deferred", reason: "governor_stopped", custody: "none" };
    const target = schedule.target;
    if (this.options.execution) {
      try {
        await this.options.execution.reconcile(schedule);
      } catch {
        return { kind: "deferred", reason: "execution_reconciliation_required" };
      }
    }
    if (this.stopped) return { kind: "deferred", reason: "governor_stopped", custody: "none" };
    if (schedule.expiresAt && Date.parse(schedule.expiresAt) <= this.nowMs())
      return { kind: "deferred", reason: "schedule_expired", custody: "none" };
    if (target.type !== "new-agent" || !target.config.quotaPolicy) {
      return { kind: "deferred", reason: "quota_policy_required", custody: "none" };
    }
    const policy = target.config.quotaPolicy;
    this.expireHolds(this.nowMs());
    const cached = this.holds.get(schedule.id);
    if (
      cached &&
      cached.scheduledFor === scheduledFor &&
      isDeepStrictEqual(cached.target, target)
    ) {
      // The scheduler ticks each second while a due occurrence remains held.
      // Cache refusals only; every possible admission reads fresh account evidence.
      return { kind: "deferred", reason: cached.reason, custody: "none" };
    }
    const hold = (reason: string): Preparation => {
      if (this.stopped) return { kind: "deferred", reason: "governor_stopped", custody: "none" };
      const checkedAt = this.nowMs();
      // Estimated accounting must keep sampling during holds. A five-minute
      // refusal cache otherwise prevents the required continuous fresh hour.
      const retryDelay = policy.estimatedHourly
        ? Math.min(60_000, policy.maxObservationAgeSeconds * 500)
        : 300_000;
      this.holds.set(schedule.id, {
        target: structuredClone(target),
        scheduledFor,
        checkedAt,
        retryAt: checkedAt + retryDelay,
        reason,
      });
      return { kind: "deferred", reason, custody: "none" };
    };
    let observation: QuotaObservation;
    try {
      observation = await this.options.readObservation(target.config.provider);
    } catch {
      return hold("telemetry_unavailable");
    }
    if (this.stopped) return { kind: "deferred", reason: "governor_stopped", custody: "none" };
    const decision = evaluateQuotaGovernor({
      policy: target.config.quotaPolicy,
      observation,
      nowMs: this.nowMs(),
      phase: "admission",
    });
    if (decision.action !== "admit") {
      return hold(decision.reasons[0]?.code ?? "quota_admission_held");
    }
    if (!this.options.execution) return hold("governed_execution_unavailable");
    // Preflight does not grant authority. The driver must recheck at dispatch
    // after preparation and obtain a permit from its captured execution supervisor.
    const prepared = await this.options.execution.prepare(schedule, scheduledFor);
    if (prepared.kind === "deferred") {
      // Unknown custody is not a cacheable metadata refusal.
      return this.backendDeferral(prepared, hold);
    }
    let dispatched = false;
    let freezing: Promise<void> | undefined;
    let freezeReason = "dispatch_not_started";
    const freezeBeforeDispatch = (reason: string): Promise<void> => {
      if (dispatched)
        return Promise.reject(new Error("Prepared execution was already dispatched."));
      if (!freezing) {
        freezeReason = reason;
        // Fence dispatch before calling into the driver, including a synchronous throw.
        freezing = Promise.resolve();
        try {
          freezing = Promise.resolve(prepared.freezeBeforeDispatch(reason));
        } catch (error) {
          freezing = Promise.reject(error);
        }
      }
      return freezing;
    };
    if (this.stopped) {
      await freezeBeforeDispatch("governor_stopped");
      return { kind: "deferred", reason: "governor_stopped" };
    }
    return {
      ...prepared,
      freezeBeforeDispatch,
      run: async (current, runId) => {
        if (this.stopped) await freezeBeforeDispatch("governor_stopped");
        if (freezing) {
          await freezing;
          return { state: "frozen", reason: freezeReason };
        }
        if (dispatched) throw new Error("Prepared execution was already dispatched.");
        dispatched = true;
        return prepared.run(current, runId);
      },
    };
  }
}
