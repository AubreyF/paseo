import { isDeepStrictEqual } from "node:util";
import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import type { QuotaObservation } from "@getpaseo/protocol/quota-governor";
import { evaluateQuotaGovernor } from "../agent/quota-reserve/governor-evaluate.js";
import type { ScheduleServiceOptions } from "./service.js";

type QuotaRunner = NonNullable<ScheduleServiceOptions["quotaRunner"]>;
type Preparation = Awaited<ReturnType<QuotaRunner["prepare"]>>;

interface PreflightOptions {
  readObservation(providerId: string): Promise<QuotaObservation>;
  /** The governed driver owns claims, pacing, captured credentials and execution permits. */
  execution?: QuotaRunner & {
    /** Reconcile retained execution custody without launching inference, even when quota holds. */
    reconcile(schedule: StoredSchedule): Promise<void>;
  };
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
      if (now < hold.checkedAt || now - hold.checkedAt >= 300_000) this.holds.delete(id);
    }
  }

  async prepare(schedule: StoredSchedule, scheduledFor: string): Promise<Preparation> {
    if (this.stopped) return { kind: "deferred", reason: "governor_stopped" };
    const target = schedule.target;
    if (this.options.execution) {
      try {
        await this.options.execution.reconcile(schedule);
      } catch {
        return { kind: "deferred", reason: "execution_reconciliation_required" };
      }
    }
    if (this.stopped) return { kind: "deferred", reason: "governor_stopped" };
    if (schedule.expiresAt && Date.parse(schedule.expiresAt) <= this.nowMs())
      return { kind: "deferred", reason: "schedule_expired" };
    if (target.type !== "new-agent" || !target.config.quotaPolicy) {
      return { kind: "deferred", reason: "quota_policy_required" };
    }
    this.expireHolds(this.nowMs());
    const cached = this.holds.get(schedule.id);
    if (
      cached &&
      cached.scheduledFor === scheduledFor &&
      isDeepStrictEqual(cached.target, target)
    ) {
      // The scheduler ticks each second while a due occurrence remains held.
      // Cache refusals only; every possible admission reads fresh account evidence.
      return { kind: "deferred", reason: cached.reason };
    }
    const hold = (reason: string): Preparation => {
      if (this.stopped) return { kind: "deferred", reason: "governor_stopped" };
      this.holds.set(schedule.id, {
        target: structuredClone(target),
        scheduledFor,
        checkedAt: this.nowMs(),
        reason,
      });
      return { kind: "deferred", reason };
    };
    let observation: QuotaObservation;
    try {
      observation = await this.options.readObservation(target.config.provider);
    } catch {
      return hold("telemetry_unavailable");
    }
    if (this.stopped) return { kind: "deferred", reason: "governor_stopped" };
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
    if (this.stopped) return { kind: "deferred", reason: "governor_stopped" };
    if (prepared.kind === "deferred") return hold(prepared.reason);
    return {
      ...prepared,
      run: async (current, runId) => {
        if (this.stopped) return { state: "frozen", reason: "governor_stopped" };
        return prepared.run(current, runId);
      },
    };
  }
}
