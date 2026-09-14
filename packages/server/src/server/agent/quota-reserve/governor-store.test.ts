import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import type { QuotaGovernorPolicy, QuotaObservation } from "@getpaseo/protocol/quota-governor";
import { QuotaGovernorStore } from "./governor-store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const nowMs = Date.parse("2026-09-14T08:00:00Z");
const policy: QuotaGovernorPolicy = {
  version: 1,
  account: { issuer: "openai", accountId: "account-one" },
  launchFloorPercent: 25,
  freezeFloorPercent: 20,
  maxObservationAgeSeconds: 120,
  requiredWindows: [{ bucketId: "coding", windowId: "primary", durationMinutes: 10080 }],
  consumptionLimits: [],
  recovery: "automatic_after_reconciliation",
};
const observation: QuotaObservation = {
  status: "available",
  account: policy.account,
  observedAt: new Date(nowMs).toISOString(),
  windows: [
    {
      bucketId: "coding",
      windowId: "primary",
      durationMinutes: 10080,
      usedPercent: 20,
      resetsAt: null,
      semantics: "unknown",
    },
  ],
  consumptionMeters: [],
};
const input = {
  policy,
  observation,
  nowMs,
  scheduleId: "schedule-one",
  occurrenceId: "occurrence-one",
  providerId: "codex-secondary",
};
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "quota-governor-store-"));
  directories.push(dir);
  return dir;
}

it("persists one account reservation across aliases and restart", async () => {
  const dir = await directory();
  const first = await new QuotaGovernorStore(dir).reserve(input);
  expect(first.kind).toBe("admitted");
  expect(await new QuotaGovernorStore(dir).reserve(input)).toEqual(first);
  expect(
    await new QuotaGovernorStore(dir).reserve({
      ...input,
      scheduleId: "schedule-two",
      providerId: "same-account-alias",
    }),
  ).toEqual({
    kind: "deferred",
    reason: "account_busy",
  });
});

it("serializes competing account admissions before either can start inference", async () => {
  const store = new QuotaGovernorStore(await directory());
  const results = await Promise.all([
    store.reserve(input),
    store.reserve({ ...input, scheduleId: "schedule-two", occurrenceId: "occurrence-two" }),
  ]);
  expect(results.map((result) => result.kind)).toEqual(["admitted", "deferred"]);
});

it("does not treat missing daily history as a fresh allowance", async () => {
  const store = new QuotaGovernorStore(await directory());
  const result = await store.reserve({
    ...input,
    policy: {
      ...policy,
      consumptionLimits: [
        {
          meterId: "daily-weekly-points",
          bucketId: "coding",
          revision: "1",
          unit: "weekly_quota_points",
          period: { kind: "calendar_day", timezone: "UTC" },
          throttleAt: 25,
          holdAt: 30,
          freezeAt: 35,
        },
      ],
    },
  });
  expect(result).toEqual({
    kind: "deferred",
    reason: "quota",
    decision: {
      action: "hold",
      reasons: [{ code: "meter_unavailable", meterId: "daily-weekly-points" }],
    },
  });
});

it("rejects corrupt account accounting instead of recreating it", async () => {
  const dir = await directory();
  const store = new QuotaGovernorStore(dir);
  await store.reserve(input);
  const path = store.accountPath(policy.account);
  expect(JSON.parse(await readFile(path, "utf8")).account).toEqual(policy.account);
  await writeFile(path, "broken");
  await expect(new QuotaGovernorStore(dir).reserve(input)).rejects.toThrow();
});

it("fences a changed window contract after restart", async () => {
  const dir = await directory();
  await new QuotaGovernorStore(dir).reserve(input);
  expect(
    await new QuotaGovernorStore(dir).reserve({
      ...input,
      observation: {
        ...observation,
        windows: [{ ...observation.windows[0], durationMinutes: 300 }],
      },
    }),
  ).toEqual({ kind: "deferred", reason: "window_contract_changed" });
});

it("will not reassign a reserved occurrence when its schedule account configuration changes", async () => {
  const store = new QuotaGovernorStore(await directory());
  await store.reserve(input);
  expect(await store.reserve({ ...input, providerId: "different-provider" })).toEqual({
    kind: "deferred",
    reason: "execution_binding_changed",
  });
});

it("does not reclaim an unresolved filesystem lock based on its age", async () => {
  const store = new QuotaGovernorStore(await directory());
  await mkdir(`${store.accountPath(policy.account)}.lock`);
  expect(await store.reserve(input)).toEqual({ kind: "deferred", reason: "store_busy" });
});

it("rejects older observations after reopening the account ledger", async () => {
  const dir = await directory();
  await new QuotaGovernorStore(dir).reserve(input);
  expect(
    await new QuotaGovernorStore(dir).reserve({
      ...input,
      observation: {
        ...observation,
        observedAt: new Date(nowMs - 1000).toISOString(),
      },
    }),
  ).toEqual({ kind: "deferred", reason: "observation_regressed" });
});

it("does not follow a ledger symlink or overwrite its target", async () => {
  const dir = await directory();
  const store = new QuotaGovernorStore(dir);
  const target = join(dir, "unrelated.json");
  await writeFile(target, "preserve");
  await symlink(target, store.accountPath(policy.account));
  await expect(store.reserve(input)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("preserve");
});

it("persists start intent before launch and prevents another start after a crash", async () => {
  const dir = await directory();
  const store = new QuotaGovernorStore(dir);
  const admitted = await store.reserve(input);
  if (admitted.kind !== "admitted") throw new Error("Expected admission");
  const start = {
    account: policy.account,
    reservationId: admitted.reservation.id,
    expectedGeneration: 0,
    event: {
      type: "start" as const,
      executionId: "execution-one",
      authenticationGeneration: "auth-one",
    },
    observation,
    nowMs,
  };
  expect(await store.transition(start)).toMatchObject({
    kind: "transitioned",
    execution: { state: "starting", generation: 1 },
  });
  const reopened = new QuotaGovernorStore(dir);
  expect(await reopened.execution(policy.account, admitted.reservation.id)).toMatchObject({
    state: "starting",
    executionId: "execution-one",
  });
  await expect(reopened.transition(start)).rejects.toThrow("Stale quota execution generation");
  await expect(reopened.transition({ ...start, expectedGeneration: 1 })).rejects.toThrow(
    "cannot transition",
  );
});

it("requires confirmed settlement and fresh quota before resuming the same reservation", async () => {
  const store = new QuotaGovernorStore(await directory());
  const admitted = await store.reserve(input);
  if (admitted.kind !== "admitted") throw new Error("Expected admission");
  const binding = {
    account: policy.account,
    reservationId: admitted.reservation.id,
    nowMs,
    observation,
  };
  await store.transition({
    ...binding,
    expectedGeneration: 0,
    event: { type: "start", executionId: "first", authenticationGeneration: "auth" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 1,
    event: { type: "freeze", reason: "quota" },
  });
  const recovery = {
    ...binding,
    nowMs: nowMs + 1,
    observation: { ...observation, observedAt: new Date(nowMs + 1).toISOString() },
  };
  const resume = {
    type: "resume" as const,
    executionId: "second",
    authenticationGeneration: "auth",
    manual: false,
  };
  await expect(
    store.transition({ ...recovery, expectedGeneration: 2, event: resume }),
  ).rejects.toThrow("cannot transition");
  await store.transition({
    ...binding,
    expectedGeneration: 2,
    event: { type: "settled", executionId: "first", settlementId: "confirmed-process-exit" },
  });
  expect(
    await store.transition({
      ...binding,
      expectedGeneration: 3,
      nowMs: nowMs + 120001,
      event: resume,
    }),
  ).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: { action: "hold" },
  });
  expect(await store.transition({ ...binding, expectedGeneration: 3, event: resume })).toEqual({
    kind: "deferred",
    reason: "observation_regressed",
  });
  expect(
    await store.transition({ ...recovery, expectedGeneration: 3, event: resume }),
  ).toMatchObject({
    kind: "transitioned",
    execution: { state: "starting", generation: 4, executionId: "second" },
  });
});

it("preserves manual pauses and rejects account authentication changes during resume", async () => {
  const store = new QuotaGovernorStore(await directory());
  const admitted = await store.reserve(input);
  if (admitted.kind !== "admitted") throw new Error("Expected admission");
  const binding = {
    account: policy.account,
    reservationId: admitted.reservation.id,
    nowMs,
    observation,
  };
  await store.transition({
    ...binding,
    expectedGeneration: 0,
    event: { type: "start", executionId: "first", authenticationGeneration: "auth" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 1,
    event: { type: "freeze", reason: "manual" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 2,
    event: { type: "freeze", reason: "quota" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 3,
    event: { type: "settled", executionId: "first", settlementId: "exit" },
  });
  const recovery = {
    ...binding,
    nowMs: nowMs + 1,
    observation: { ...observation, observedAt: new Date(nowMs + 1).toISOString() },
  };
  const event = {
    type: "resume" as const,
    executionId: "second",
    authenticationGeneration: "auth",
    manual: false,
  };
  await expect(store.transition({ ...recovery, expectedGeneration: 4, event })).rejects.toThrow(
    "Manual pause",
  );
  await expect(
    store.transition({
      ...recovery,
      expectedGeneration: 4,
      event: { ...event, manual: true, authenticationGeneration: "changed" },
    }),
  ).rejects.toThrow("Authentication changed");
  expect((await store.execution(policy.account, admitted.reservation.id)).state).toBe("frozen");
});

it("records real completion that races with freeze as terminal, never resumable", async () => {
  const store = new QuotaGovernorStore(await directory());
  const admitted = await store.reserve(input);
  if (admitted.kind !== "admitted") throw new Error("Expected admission");
  const binding = {
    account: policy.account,
    reservationId: admitted.reservation.id,
    nowMs,
    observation,
  };
  await store.transition({
    ...binding,
    expectedGeneration: 0,
    event: { type: "start", executionId: "first", authenticationGeneration: "auth" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 1,
    event: { type: "freeze", reason: "quota" },
  });
  expect(
    await store.transition({
      ...binding,
      expectedGeneration: 2,
      event: {
        type: "complete",
        executionId: "first",
        settlementId: "verified-completion",
      },
    }),
  ).toMatchObject({ kind: "transitioned", execution: { state: "completed", generation: 3 } });
  await expect(
    store.transition({
      ...binding,
      nowMs: nowMs + 1,
      observation: { ...observation, observedAt: new Date(nowMs + 1).toISOString() },
      expectedGeneration: 3,
      event: {
        type: "resume",
        executionId: "second",
        authenticationGeneration: "auth",
        manual: false,
      },
    }),
  ).rejects.toThrow("cannot transition from completed");
});

it("releases completed capacity without forgetting accounting or allowing duplicate publication work", async () => {
  const dir = await directory();
  const store = new QuotaGovernorStore(dir);
  const admitted = await store.reserve(input);
  if (admitted.kind !== "admitted") throw new Error("Expected admission");
  const binding = {
    account: policy.account,
    reservationId: admitted.reservation.id,
    nowMs,
    observation,
  };
  await store.transition({
    ...binding,
    expectedGeneration: 0,
    event: { type: "start", executionId: "first", authenticationGeneration: "auth" },
  });
  await expect(store.finalize(binding)).rejects.toThrow("completion is unconfirmed");
  await store.transition({
    ...binding,
    expectedGeneration: 1,
    event: { type: "complete", executionId: "first", settlementId: "exit" },
  });
  expect(await store.finalize(binding)).toEqual({
    kind: "deferred",
    reason: "observation_regressed",
  });
  const postCompletion = {
    ...observation,
    observedAt: new Date(nowMs + 1).toISOString(),
    settledExecutions: [
      {
        executionId: "first",
        authenticationGeneration: "auth",
        accountedAt: new Date(nowMs + 1).toISOString(),
      },
    ],
  };
  const finalization = { ...binding, observation: postCompletion, nowMs: nowMs + 1 };
  expect(
    await store.finalize({
      ...finalization,
      observation: { ...postCompletion, settledExecutions: undefined },
    }),
  ).toEqual({
    kind: "deferred",
    reason: "charge_settlement_unavailable",
  });
  expect(await store.finalize(finalization)).toEqual({ kind: "finalized" });
  const reopened = new QuotaGovernorStore(dir);
  expect(await reopened.finalize(finalization)).toEqual({ kind: "finalized" });
  expect(await reopened.reserve(input)).toEqual({
    kind: "completed",
    reservationId: admitted.reservation.id,
  });
  const next = { ...input, occurrenceId: "next", observation: postCompletion, nowMs: nowMs + 1 };
  expect((await reopened.reserve(next)).kind).toBe("admitted");
  expect(await reopened.reserve(input)).toEqual({
    kind: "completed",
    reservationId: admitted.reservation.id,
  });
  const ledger = JSON.parse(await readFile(reopened.accountPath(policy.account), "utf8"));
  expect(ledger.observation.observedAt).toBe(postCompletion.observedAt);
  expect(ledger.completions).toHaveLength(1);
});

it("allows cleanup at the freeze floor but does not admit another run against that allowance", async () => {
  const store = new QuotaGovernorStore(await directory());
  const admitted = await store.reserve(input);
  if (admitted.kind !== "admitted") throw new Error("Expected admission");
  const binding = {
    account: policy.account,
    reservationId: admitted.reservation.id,
    nowMs,
    observation,
  };
  await store.transition({
    ...binding,
    expectedGeneration: 0,
    event: { type: "start", executionId: "first", authenticationGeneration: "auth" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 1,
    event: { type: "complete", executionId: "first", settlementId: "exit" },
  });
  const exhausted = {
    ...observation,
    observedAt: new Date(nowMs + 1).toISOString(),
    windows: [{ ...observation.windows[0], usedPercent: 90 }],
    settledExecutions: [
      {
        executionId: "first",
        authenticationGeneration: "auth",
        accountedAt: new Date(nowMs + 1).toISOString(),
      },
    ],
  };
  expect(await store.finalize({ ...binding, observation: exhausted, nowMs: nowMs + 1 })).toEqual({
    kind: "finalized",
  });
  expect(
    await store.reserve({
      ...input,
      occurrenceId: "next",
      observation: exhausted,
      nowMs: nowMs + 1,
    }),
  ).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: { action: "freeze" },
  });
});

it("retains unsettled charges from earlier executions when a resumed execution completes", async () => {
  const store = new QuotaGovernorStore(await directory());
  const admitted = await store.reserve(input);
  if (admitted.kind !== "admitted") throw new Error("Expected admission");
  const binding = {
    account: policy.account,
    reservationId: admitted.reservation.id,
    nowMs,
    observation,
  };
  await store.transition({
    ...binding,
    expectedGeneration: 0,
    event: { type: "start", executionId: "first", authenticationGeneration: "auth" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 1,
    event: { type: "freeze", reason: "quota" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 2,
    event: { type: "settled", executionId: "first", settlementId: "exit-one" },
  });
  const recovered = { ...observation, observedAt: new Date(nowMs + 1).toISOString() };
  await store.transition({
    ...binding,
    observation: recovered,
    nowMs: nowMs + 1,
    expectedGeneration: 3,
    event: {
      type: "resume",
      executionId: "second",
      authenticationGeneration: "auth",
      manual: false,
    },
  });
  await store.transition({
    ...binding,
    nowMs: nowMs + 2,
    expectedGeneration: 4,
    event: { type: "complete", executionId: "second", settlementId: "exit-two" },
  });
  const receipt = {
    executionId: "second",
    authenticationGeneration: "auth",
    accountedAt: new Date(nowMs + 3).toISOString(),
  };
  const charges = { ...observation, observedAt: receipt.accountedAt, settledExecutions: [receipt] };
  expect(await store.finalize({ ...binding, observation: charges, nowMs: nowMs + 3 })).toEqual({
    kind: "deferred",
    reason: "charge_settlement_unavailable",
  });
  expect(
    await store.finalize({
      ...binding,
      nowMs: nowMs + 3,
      observation: {
        ...charges,
        settledExecutions: [receipt, { ...receipt, executionId: "first" }],
      },
    }),
  ).toEqual({ kind: "finalized" });
});
