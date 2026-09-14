import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  QuotaAccountSchema,
  QuotaGovernorPolicySchema,
  QuotaObservationSchema,
  type QuotaAccount,
  type QuotaGovernorPolicy,
  type QuotaObservation,
} from "@getpaseo/protocol/quota-governor";
import { evaluateQuotaGovernor, type QuotaGovernorDecision } from "./governor-evaluate.js";
import {
  advanceGovernorExecution,
  GovernorExecutionSchema,
  type GovernorExecution,
  type GovernorExecutionEvent,
} from "./governor-lifecycle.js";

const ReservationSchema = z
  .object({
    id: z.string().uuid(),
    scheduleId: z.string().min(1),
    occurrenceId: z.string().min(1),
    providerId: z.string().min(1),
    policy: QuotaGovernorPolicySchema,
    createdAt: z.string().datetime(),
  })
  .strict();
const LedgerSchema = z
  .object({
    version: z.literal(1),
    account: QuotaAccountSchema,
    windowContract: z.string(),
    observation: QuotaObservationSchema,
    reservation: ReservationSchema,
    execution: GovernorExecutionSchema,
    lastFreezeAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    executionBindings: z.array(
      z
        .object({
          executionId: z.string().min(1),
          authenticationGeneration: z.string().min(1),
          startedAt: z.string().datetime(),
          endedAt: z.string().datetime().nullable(),
        })
        .strict(),
    ),
    released: z.boolean(),
    completions: z.array(
      z
        .object({
          scheduleId: z.string().min(1),
          occurrenceId: z.string().min(1),
          reservationId: z.string().uuid(),
          finalizedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();
type Ledger = z.infer<typeof LedgerSchema>;

interface ReserveInput {
  policy: QuotaGovernorPolicy;
  observation: QuotaObservation;
  nowMs: number;
  scheduleId: string;
  occurrenceId: string;
  providerId: string;
}
type ReserveResult =
  | { kind: "admitted"; reservation: z.infer<typeof ReservationSchema> }
  | { kind: "completed"; reservationId: string }
  | {
      kind: "deferred";
      reason:
        | "account_busy"
        | "store_busy"
        | "window_contract_changed"
        | "execution_binding_changed"
        | "observation_regressed"
        | "charge_settlement_unavailable";
    }
  | { kind: "deferred"; reason: "quota"; decision: QuotaGovernorDecision };

/** Durable execution reservation, not a task queue or a spending estimate. */
export class QuotaGovernorStore {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  accountPath(account: QuotaAccount): string {
    const key = createHash("sha256")
      .update(JSON.stringify([account.issuer, account.accountId]))
      .digest("hex");
    return resolve(this.directory, `${key}.json`);
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const path = this.accountPath(input.policy.account);
    return this.withAccountLock(path, () => this.reserveUnderLock(path, input));
  }

  async execution(account: QuotaAccount, reservationId: string): Promise<GovernorExecution> {
    return (await this.executionContext(account, reservationId)).execution;
  }

  async executionContext(
    account: QuotaAccount,
    reservationId: string,
  ): Promise<{
    execution: GovernorExecution;
    policy: QuotaGovernorPolicy;
    providerId: string;
    observation: QuotaObservation;
  }> {
    const ledger = await readLedger(this.accountPath(account));
    if (
      !ledger ||
      ledger.reservation.id !== reservationId ||
      !isDeepStrictEqual(ledger.account, account)
    ) {
      throw new Error("Quota reservation identity mismatch.");
    }
    return {
      execution: ledger.execution,
      policy: ledger.reservation.policy,
      providerId: ledger.reservation.providerId,
      observation: ledger.observation,
    };
  }

  async transition(input: {
    account: QuotaAccount;
    reservationId: string;
    expectedGeneration: number;
    event: GovernorExecutionEvent;
    observation?: QuotaObservation;
    nowMs: number;
  }): Promise<
    | { kind: "transitioned"; execution: GovernorExecution }
    | Extract<ReserveResult, { kind: "deferred" }>
  > {
    const path = this.accountPath(input.account);
    return this.withAccountLock(path, async () => {
      const ledger = await readLedger(path);
      if (
        !ledger ||
        ledger.reservation.id !== input.reservationId ||
        !isDeepStrictEqual(ledger.account, input.account)
      ) {
        throw new Error("Quota reservation identity mismatch.");
      }
      if (input.event.type === "start" || input.event.type === "resume") {
        const observation = input.observation ?? { status: "unavailable", reason: "read_failed" };
        const decision = evaluateQuotaGovernor({
          policy: ledger.reservation.policy,
          observation,
          nowMs: input.nowMs,
          phase: "admission",
        });
        if (decision.action !== "admit") return { kind: "deferred", reason: "quota", decision };
        if (observation.status !== "available" || ledger.observation.status !== "available")
          throw new Error("Missing quota observation.");
        if (windowContract(observation) !== ledger.windowContract)
          return { kind: "deferred", reason: "window_contract_changed" };
        if (Date.parse(observation.observedAt) < Date.parse(ledger.observation.observedAt))
          return { kind: "deferred", reason: "observation_regressed" };
        if (
          input.event.type === "resume" &&
          (!ledger.lastFreezeAt ||
            Date.parse(observation.observedAt) <= Date.parse(ledger.lastFreezeAt))
        ) {
          return { kind: "deferred", reason: "observation_regressed" };
        }
        ledger.observation = observation;
      }
      if (input.event.type === "freeze") {
        const previous = ledger.lastFreezeAt ? Date.parse(ledger.lastFreezeAt) : -Infinity;
        ledger.lastFreezeAt = new Date(Math.max(previous, input.nowMs)).toISOString();
      }
      ledger.execution = advanceGovernorExecution(
        ledger.execution,
        input.expectedGeneration,
        input.event,
      );
      recordExecutionAccounting(ledger, input.event, input.nowMs);
      await writeLedger(path, ledger);
      return { kind: "transitioned", execution: ledger.execution };
    });
  }

  /** Release execution capacity only after post-completion accounting is observed. */
  async finalize(input: {
    account: QuotaAccount;
    reservationId: string;
    observation: QuotaObservation;
    nowMs: number;
  }): Promise<{ kind: "finalized" } | Extract<ReserveResult, { kind: "deferred" }>> {
    const path = this.accountPath(input.account);
    return this.withAccountLock(path, async () => {
      const ledger = await readLedger(path);
      if (!ledger || !isDeepStrictEqual(ledger.account, input.account))
        throw new Error("Quota ledger account identity mismatch.");
      if (ledger.completions.some((item) => item.reservationId === input.reservationId))
        return { kind: "finalized" };
      if (
        ledger.reservation.id !== input.reservationId ||
        ledger.execution.state !== "completed" ||
        !ledger.execution.settlementId ||
        !ledger.completedAt
      )
        throw new Error("Execution completion is unconfirmed.");
      const observation = QuotaObservationSchema.parse(input.observation);
      const decision = evaluateQuotaGovernor({
        policy: ledger.reservation.policy,
        observation,
        nowMs: input.nowMs,
        phase: "admission",
      });
      // Being out of allowance must not prevent cleanup. Missing or invalid
      // accounting must: it cannot release capacity as if outstanding usage were zero.
      const expenditureReasons = new Set([
        "launch_floor",
        "freeze_floor",
        "consumption_throttle",
        "consumption_hold",
        "consumption_freeze",
      ]);
      if (decision.reasons.some((reason) => !expenditureReasons.has(reason.code)))
        return { kind: "deferred", reason: "quota", decision };
      if (observation.status !== "available" || ledger.observation.status !== "available")
        throw new Error("Missing completion accounting.");
      if (windowContract(observation) !== ledger.windowContract)
        return { kind: "deferred", reason: "window_contract_changed" };
      if (
        Date.parse(observation.observedAt) <= Date.parse(ledger.completedAt) ||
        Date.parse(observation.observedAt) < Date.parse(ledger.observation.observedAt)
      )
        return { kind: "deferred", reason: "observation_regressed" };
      if (!chargesAccountedFor(ledger, observation))
        return { kind: "deferred", reason: "charge_settlement_unavailable" };
      ledger.observation = observation;
      ledger.released = true;
      ledger.completions.push({
        scheduleId: ledger.reservation.scheduleId,
        occurrenceId: ledger.reservation.occurrenceId,
        reservationId: ledger.reservation.id,
        finalizedAt: new Date(input.nowMs).toISOString(),
      });
      await writeLedger(path, ledger);
      return { kind: "finalized" };
    });
  }

  private async withAccountLock<T>(
    path: string,
    operation: () => Promise<T>,
  ): Promise<T | { kind: "deferred"; reason: "store_busy" }> {
    const previous = this.pending.get(path) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.lockedOperation(path, operation));
    this.pending.set(path, work);
    try {
      return await work;
    } finally {
      if (this.pending.get(path) === work) this.pending.delete(path);
    }
  }

  private async lockedOperation<T>(
    path: string,
    operation: () => Promise<T>,
  ): Promise<T | { kind: "deferred"; reason: "store_busy" }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = `${path}.lock`;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (hasCode(error, "EEXIST")) return { kind: "deferred", reason: "store_busy" };
      throw error;
    }
    // A crash leaves this lock in place. Never infer that an old timestamp means
    // an owner stopped; recovery must prove custody before removing it.
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true });
    }
  }

  private async reserveUnderLock(path: string, input: ReserveInput): Promise<ReserveResult> {
    const ledger = await readLedger(path);
    if (ledger && !isDeepStrictEqual(ledger.account, input.policy.account))
      throw new Error("Quota ledger account identity mismatch.");
    const completed = ledger?.completions.find(
      (item) => item.scheduleId === input.scheduleId && item.occurrenceId === input.occurrenceId,
    );
    if (completed) return { kind: "completed", reservationId: completed.reservationId };
    if (ledger && input.observation.status === "available") {
      const conflict = reconcile(ledger, input, windowContract(input.observation));
      if (conflict) return conflict;
    }
    const decision = evaluateQuotaGovernor({ ...input, phase: "admission" });
    if (decision.action !== "admit") return { kind: "deferred", reason: "quota", decision };
    const observation = QuotaObservationSchema.parse(input.observation);
    if (observation.status !== "available")
      throw new Error("Admission requires available telemetry.");
    const contract = windowContract(observation);
    if (ledger && !ledger.released) {
      if (ledger.execution.state === "completed")
        return { kind: "completed", reservationId: ledger.reservation.id };
      await writeLedger(path, { ...ledger, observation });
      return { kind: "admitted", reservation: ledger.reservation };
    }
    const reservation = ReservationSchema.parse({
      id: randomUUID(),
      scheduleId: input.scheduleId,
      occurrenceId: input.occurrenceId,
      providerId: input.providerId,
      policy: input.policy,
      createdAt: new Date(input.nowMs).toISOString(),
    });
    await writeLedger(path, {
      version: 1,
      account: input.policy.account,
      windowContract: contract,
      observation,
      reservation,
      lastFreezeAt: null,
      completedAt: null,
      executionBindings: [],
      released: false,
      completions: ledger?.completions ?? [],
      execution: {
        generation: 0,
        state: "reserved",
        executionId: null,
        authenticationGeneration: null,
        pauseReason: null,
        settlementId: null,
      },
    });
    return { kind: "admitted", reservation };
  }
}

function reconcile(ledger: Ledger, input: ReserveInput, contract: string): ReserveResult | null {
  if (!isDeepStrictEqual(ledger.account, input.policy.account)) {
    throw new Error("Quota ledger account identity mismatch.");
  }
  if (ledger.windowContract !== contract)
    return { kind: "deferred", reason: "window_contract_changed" };
  if (ledger.observation.status !== "available" || input.observation.status !== "available") {
    throw new Error("Quota ledger has no attributable observation.");
  }
  if (Date.parse(input.observation.observedAt) < Date.parse(ledger.observation.observedAt)) {
    return { kind: "deferred", reason: "observation_regressed" };
  }
  if (ledger.released) return null;
  const reservation = ledger.reservation;
  if (
    reservation.scheduleId !== input.scheduleId ||
    reservation.occurrenceId !== input.occurrenceId
  ) {
    return { kind: "deferred", reason: "account_busy" };
  }
  if (
    reservation.providerId !== input.providerId ||
    !isDeepStrictEqual(reservation.policy, input.policy)
  ) {
    return { kind: "deferred", reason: "execution_binding_changed" };
  }
  return null;
}

function windowContract(observation: Extract<QuotaObservation, { status: "available" }>): string {
  return JSON.stringify(
    observation.windows
      .map((window) =>
        JSON.stringify([
          window.bucketId,
          window.windowId,
          window.durationMinutes,
          window.semantics,
        ]),
      )
      .sort(),
  );
}

async function readLedger(path: string): Promise<Ledger | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new Error("Invalid quota ledger file.");
    return LedgerSchema.parse(JSON.parse(await file.readFile("utf8")));
  } finally {
    await file.close();
  }
}

async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(ledger));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(resolve(path, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function chargesAccountedFor(
  ledger: Ledger,
  observation: Extract<QuotaObservation, { status: "available" }>,
): boolean {
  if (ledger.executionBindings.length === 0) return false;
  return ledger.executionBindings.every((binding) => {
    const receipts =
      observation.settledExecutions?.filter(
        (receipt) =>
          receipt.executionId === binding.executionId &&
          receipt.authenticationGeneration === binding.authenticationGeneration,
      ) ?? [];
    const receipt = receipts[0];
    if (receipts.length !== 1 || !receipt) return false;
    const accountedAt = Date.parse(receipt.accountedAt);
    const boundary = binding.endedAt;
    return (
      boundary !== null &&
      accountedAt >= Date.parse(boundary) &&
      accountedAt <= Date.parse(observation.observedAt)
    );
  });
}

function recordExecutionAccounting(
  ledger: Ledger,
  event: GovernorExecutionEvent,
  nowMs: number,
): void {
  if (event.type === "start" || event.type === "resume") {
    ledger.executionBindings.push({
      executionId: event.executionId,
      authenticationGeneration: event.authenticationGeneration,
      startedAt: new Date(nowMs).toISOString(),
      endedAt: null,
    });
  }
  if (event.type === "settled" || event.type === "complete") {
    const executionId = event.executionId;
    const binding = ledger.executionBindings.find((item) => item.executionId === executionId);
    if (!binding) throw new Error("Captured execution binding is missing.");
    binding.endedAt = new Date(nowMs).toISOString();
  }
  if (event.type === "complete") ledger.completedAt = new Date(nowMs).toISOString();
}
