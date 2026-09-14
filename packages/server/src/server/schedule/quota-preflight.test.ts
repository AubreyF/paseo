import { expect, it } from "vitest";
import type { QuotaObservation } from "@getpaseo/protocol/quota-governor";
import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import { QuotaSchedulePreflight } from "./quota-preflight.js";

const now = Date.parse("2026-09-14T08:00:00Z");
const instant = new Date(now).toISOString();
const account = { issuer: "provider", accountId: "dedicated" };
const schedule: StoredSchedule = {
  id: "schedule",
  name: "Factory",
  prompt: "Approved bounded task",
  cadence: { type: "cron", expression: "*/5 * * * *", timezone: "UTC" },
  target: {
    type: "new-agent",
    config: {
      provider: "secondary",
      cwd: "/workspace",
      quotaPolicy: {
        version: 1,
        account,
        requiredWindows: [{ bucketId: "coding", windowId: "weekly", durationMinutes: 10080 }],
        launchFloorPercent: 30,
        freezeFloorPercent: 25,
        maxObservationAgeSeconds: 120,
        consumptionLimits: [],
        recovery: "automatic_after_reconciliation",
      },
    },
  },
  status: "active",
  createdAt: instant,
  updatedAt: instant,
  nextRunAt: instant,
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
  runs: [],
};
function observation(usedPercent = 20, observedAt = now): QuotaObservation {
  return {
    status: "available",
    account,
    observedAt: new Date(observedAt).toISOString(),
    windows: [
      {
        bucketId: "coding",
        windowId: "weekly",
        durationMinutes: 10080,
        usedPercent,
        resetsAt: null,
        semantics: "unknown",
      },
    ],
    consumptionMeters: [],
  };
}

it("reads the schedule account and holds an authenticated account mismatch", async () => {
  const providers: string[] = [];
  const preflight = new QuotaSchedulePreflight({
    nowMs: () => now,
    readObservation: async (provider) => {
      providers.push(provider);
      return { ...observation(), account: { ...account, accountId: "interactive" } };
    },
  });
  expect(await preflight.prepare(schedule, instant)).toEqual({
    kind: "deferred",
    reason: "account_changed",
  });
  expect(providers).toEqual(["secondary"]);
});

it("reports the required daily meter instead of treating token activity as quota consumption", async () => {
  const strict = structuredClone(schedule);
  if (strict.target.type !== "new-agent" || !strict.target.config.quotaPolicy)
    throw new Error("fixture");
  strict.target.config.quotaPolicy.consumptionLimits.push({
    meterId: "gross-weekly-points",
    bucketId: "coding",
    revision: "one",
    unit: "weekly_quota_points",
    period: { kind: "calendar_day", timezone: "UTC" },
    throttleAt: 25,
    holdAt: 30,
    freezeAt: 35,
  });
  const preflight = new QuotaSchedulePreflight({
    nowMs: () => now,
    readObservation: async () => observation(),
  });
  expect(await preflight.prepare(strict, instant)).toEqual({
    kind: "deferred",
    reason: "meter_unavailable",
  });
});

it("does not launch an ordinary worker when the governed backend is unavailable", async () => {
  const preflight = new QuotaSchedulePreflight({
    nowMs: () => now,
    readObservation: async () => observation(),
  });
  expect(await preflight.prepare(schedule, instant)).toEqual({
    kind: "deferred",
    reason: "governed_execution_unavailable",
  });
});

it("does not reuse admission evidence or run work during backend preparation", async () => {
  let reads = 0;
  let preparations = 0;
  let runs = 0;
  const preflight = new QuotaSchedulePreflight({
    nowMs: () => now,
    readObservation: async () => {
      reads++;
      return observation();
    },
    execution: {
      reconcile: async () => {},
      prepare: async (candidate, scheduledFor) => {
        expect(candidate).toEqual(schedule);
        expect(scheduledFor).toBe(instant);
        preparations++;
        return {
          kind: "ready",
          binding: { account, reservationId: "reservation" },
          run: async () => {
            runs++;
            return { state: "frozen", reason: "fixture" };
          },
        };
      },
    },
  });
  expect((await preflight.prepare(schedule, instant)).kind).toBe("ready");
  expect((await preflight.prepare(schedule, instant)).kind).toBe("ready");
  expect({ reads, preparations, runs }).toEqual({ reads: 2, preparations: 2, runs: 0 });
});

it("paces held metadata reads while allowing an explicit new attempt to refresh", async () => {
  let current = now;
  let reads = 0;
  const preflight = new QuotaSchedulePreflight({
    nowMs: () => current,
    readObservation: async () => {
      reads++;
      return observation(80, current);
    },
  });
  expect(await preflight.prepare(schedule, instant)).toEqual({
    kind: "deferred",
    reason: "freeze_floor",
  });
  current += 1000;
  await preflight.prepare(schedule, instant);
  expect(reads).toBe(1);
  await preflight.prepare(schedule, new Date(current).toISOString());
  expect(reads).toBe(2);
  current += 300_000;
  await preflight.prepare(schedule, instant);
  expect(reads).toBe(3);
});

it("invalidates a held snapshot when the schedule account selection changes", async () => {
  const providers: string[] = [];
  const preflight = new QuotaSchedulePreflight({
    nowMs: () => now,
    readObservation: async (provider) => {
      providers.push(provider);
      return observation(80);
    },
  });
  await preflight.prepare(schedule, instant);
  const edited = structuredClone(schedule);
  if (edited.target.type !== "new-agent") throw new Error("fixture");
  edited.target.config.provider = "another-account";
  await preflight.prepare(edited, instant);
  expect(providers).toEqual(["secondary", "another-account"]);
});

it("checks freshness after metadata collection finishes", async () => {
  let current = now;
  const preflight = new QuotaSchedulePreflight({
    nowMs: () => current,
    readObservation: async () => {
      current += 120_001;
      return observation();
    },
  });
  expect(await preflight.prepare(schedule, instant)).toEqual({
    kind: "deferred",
    reason: "telemetry_stale",
  });
});

it("cannot advance to execution when stopped during metadata collection", async () => {
  let finish!: (value: QuotaObservation) => void;
  const preflight = new QuotaSchedulePreflight({
    nowMs: () => now,
    readObservation: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = preflight.prepare(schedule, instant);
  preflight.stop();
  finish(observation());
  expect(await pending).toEqual({ kind: "deferred", reason: "governor_stopped" });
  expect(await preflight.prepare(schedule, instant)).toEqual({
    kind: "deferred",
    reason: "governor_stopped",
  });
});

it("reconciles retained work even when a backend admission refusal is cached", async () => {
  let reads = 0;
  let reconciliations = 0;
  let preparations = 0;
  const preflight = new QuotaSchedulePreflight({
    nowMs: () => now,
    readObservation: async () => {
      reads++;
      return observation();
    },
    execution: {
      reconcile: async () => {
        reconciliations++;
      },
      prepare: async () => {
        preparations++;
        return { kind: "deferred", reason: "pacing" };
      },
    },
  });
  expect(await preflight.prepare(schedule, instant)).toEqual({
    kind: "deferred",
    reason: "pacing",
  });
  await preflight.prepare(schedule, instant);
  expect({ reads, reconciliations, preparations }).toEqual({
    reads: 1,
    reconciliations: 2,
    preparations: 1,
  });
});

it("refuses a ready backend result when stopped during preparation", async () => {
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const preflight = new QuotaSchedulePreflight({
    nowMs: () => now,
    readObservation: async () => observation(),
    execution: {
      reconcile: async () => {},
      prepare: async () => {
        enter();
        await pending;
        return {
          kind: "ready",
          binding: { account, reservationId: "reservation" },
          run: async () => {
            throw new Error("Must not run");
          },
        };
      },
    },
  });
  const result = preflight.prepare(schedule, instant);
  await entered;
  preflight.stop();
  release();
  expect(await result).toEqual({ kind: "deferred", reason: "governor_stopped" });
});

it("revokes a prepared run when stopped before execution", async () => {
  const preflight = new QuotaSchedulePreflight({
    nowMs: () => now,
    readObservation: async () => observation(),
    execution: {
      reconcile: async () => {},
      prepare: async () => ({
        kind: "ready",
        binding: { account, reservationId: "reservation" },
        run: async () => {
          throw new Error("Must not run");
        },
      }),
    },
  });
  const prepared = await preflight.prepare(schedule, instant);
  if (prepared.kind !== "ready") throw new Error("Expected preparation");
  preflight.stop();
  expect(await prepared.run(schedule, "run")).toEqual({
    state: "frozen",
    reason: "governor_stopped",
  });
});

it.each([false, true])(
  "reconciles retained custody before refusal (expired=%s)",
  async (expired) => {
    let reconciled = 0;
    const inherited = structuredClone(schedule);
    if (inherited.target.type !== "new-agent") throw new Error("Expected fixture target");
    delete inherited.target.config.quotaPolicy;
    if (expired) inherited.expiresAt = instant;
    inherited.runs = [
      {
        id: "retained-run",
        scheduledFor: instant,
        startedAt: instant,
        endedAt: null,
        status: "running",
        agentId: null,
        output: null,
        error: null,
        governorBinding: { account, reservationId: "retained-reservation" },
      },
    ];
    const preflight = new QuotaSchedulePreflight({
      nowMs: () => now,
      readObservation: async () => {
        throw new Error("Must not read for new admission");
      },
      execution: {
        reconcile: async (candidate) => {
          expect(candidate).toEqual(inherited);
          reconciled++;
        },
        prepare: async () => {
          throw new Error("Must not prepare inference");
        },
      },
    });
    expect(await preflight.prepare(inherited, instant)).toEqual({
      kind: "deferred",
      reason: expired ? "schedule_expired" : "quota_policy_required",
    });
    expect(reconciled).toBe(1);
  },
);
