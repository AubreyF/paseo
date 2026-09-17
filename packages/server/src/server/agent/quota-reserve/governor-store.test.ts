import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QuotaGovernorPolicy, QuotaObservation } from "@getpaseo/protocol/quota-governor";
import { QuotaGovernorStore } from "./governor-store.js";

const directories: string[] = [];
const linuxIt = it.skipIf(process.platform !== "linux");
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const nowMs = Date.parse("2026-09-14T08:00:00Z");
let clockNow = nowMs;
beforeEach(() => {
  clockNow = nowMs;
});
const clock = { nowMs: () => clockNow };

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
  const first = await new QuotaGovernorStore(dir, clock).reserve(input);
  expect(first.kind).toBe("admitted");
  expect(await new QuotaGovernorStore(dir, clock).reserve(input)).toEqual(first);
  expect(
    await new QuotaGovernorStore(dir, clock).reserve({
      ...input,
      scheduleId: "schedule-two",
      providerId: "same-account-alias",
    }),
  ).toEqual({
    kind: "deferred",
    reason: "account_busy",
  });
});

linuxIt(
  "startup recovery preserves journal bytes and requires explicit reconciliation even without a lock",
  async () => {
    const store = new QuotaGovernorStore(await directory(), clock);
    const admitted = await store.reserve(input);
    if (admitted.kind !== "admitted") throw new Error("Fixture admission failed");
    await store.observeEstimatedUsage({
      observation: input.observation,
      authenticationGeneration: "auth",
      bucketId: "coding",
      windowId: "primary",
      maxObservationAgeSeconds: 120,
    });
    const path = store.accountPath(policy.account);
    const before = await readFile(path);
    const estimate = await readFile(`${path}.estimate`);
    await mkdir(`${path}.lock`, { mode: 0o700 });
    const reconcileCustody = vi.fn(async () => ({ reconciled: true as const }));
    const recovery = { account: policy.account, assertExclusiveWriter: vi.fn(), reconcileCustody };
    expect(await store.recoverAbandonedAccountLock(recovery)).toBe("recovered");
    expect(reconcileCustody).toHaveBeenCalledWith(
      expect.objectContaining({
        account: policy.account,
        ledger: expect.objectContaining({
          reservationId: admitted.reservation.id,
          released: false,
        }),
      }),
    );
    expect(await readFile(path)).toEqual(before);
    expect(await readFile(`${path}.estimate`)).toEqual(estimate);
    expect(await store.recoverAbandonedAccountLock(recovery)).toBe("absent");
    expect(reconcileCustody).toHaveBeenCalledTimes(2);
    expect(await store.reservationState(policy.account, admitted.reservation.id)).toMatchObject({
      kind: "active",
      scheduleId: input.scheduleId,
    });
    await expect(store.reservationState(policy.account, "unknown")).rejects.toThrow(
      "identity mismatch",
    );
  },
);

linuxIt.each(["unconfirmed", "authority", "replaced", "nonempty"])(
  "startup recovery retains %s lock evidence",
  async (failure) => {
    const store = new QuotaGovernorStore(await directory(), clock);
    await store.reserve(input);
    const lock = `${store.accountPath(policy.account)}.lock`;
    await mkdir(lock, { mode: 0o700 });
    let authorized = true;
    await expect(
      store.recoverAbandonedAccountLock({
        account: policy.account,
        assertExclusiveWriter: () => {
          if (!authorized) throw new Error("Authority lost");
        },
        reconcileCustody: async () => {
          if (failure === "unconfirmed") return undefined as never;
          if (failure === "authority") authorized = false;
          if (failure === "replaced") {
            await rename(lock, `${lock}.old`);
            await mkdir(lock, { mode: 0o700 });
          }
          if (failure === "nonempty") await writeFile(join(lock, "retained"), "evidence");
          return { reconciled: true };
        },
      }),
    ).rejects.toThrow();
    expect((await lstat(lock)).isDirectory()).toBe(true);
  },
);

linuxIt(
  "startup recovery with a missing ledger requires explicit custody proof and serializes local writers",
  async () => {
    const store = new QuotaGovernorStore(await directory(), clock);
    const lock = `${store.accountPath(policy.account)}.lock`;
    await mkdir(lock, { mode: 0o700 });
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const recovery = store.recoverAbandonedAccountLock({
      account: policy.account,
      assertExclusiveWriter: () => {},
      reconcileCustody: async (context) => {
        expect(context.ledger).toBeNull();
        entered();
        await waiting;
        return { reconciled: true };
      },
    });
    await ready;
    let finished = false;
    const reservation = store.reserve(input).then((result) => {
      finished = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    release();
    expect(await recovery).toBe("recovered");
    expect((await reservation).kind).toBe("admitted");
  },
);

linuxIt.each(["malformed", "mode", "fifo"])(
  "startup recovery refuses a %s ledger without removing its lock",
  async (kind) => {
    const store = new QuotaGovernorStore(await directory(), clock);
    await store.reserve(input);
    const path = store.accountPath(policy.account);
    await mkdir(`${path}.lock`, { mode: 0o700 });
    if (kind === "malformed") await writeFile(path, "broken");
    if (kind === "mode") await chmod(path, 0o644);
    if (kind === "fifo") {
      await rm(path);
      expect(spawnSync("mkfifo", ["-m", "600", path]).status).toBe(0);
    }
    const reconcileCustody = vi.fn(async () => ({ reconciled: true as const }));
    await expect(
      store.recoverAbandonedAccountLock({
        account: policy.account,
        assertExclusiveWriter: () => {},
        reconcileCustody,
      }),
    ).rejects.toThrow();
    expect(reconcileCustody).not.toHaveBeenCalled();
    expect((await lstat(`${path}.lock`)).isDirectory()).toBe(true);
  },
);

it("serializes competing account admissions before either can start inference", async () => {
  const store = new QuotaGovernorStore(await directory(), clock);
  const results = await Promise.all([
    store.reserve(input),
    store.reserve({ ...input, scheduleId: "schedule-two", occurrenceId: "occurrence-two" }),
  ]);
  expect(results.map((result) => result.kind)).toEqual(["admitted", "deferred"]);
});

it("does not treat missing daily history as a fresh allowance", async () => {
  const store = new QuotaGovernorStore(await directory(), clock);
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
  const store = new QuotaGovernorStore(dir, clock);
  await store.reserve(input);
  const path = store.accountPath(policy.account);
  expect(JSON.parse(await readFile(path, "utf8")).account).toEqual(policy.account);
  await writeFile(path, "broken");
  await expect(new QuotaGovernorStore(dir, clock).reserve(input)).rejects.toThrow();
});

it("fences a changed window contract after restart", async () => {
  const dir = await directory();
  await new QuotaGovernorStore(dir, clock).reserve(input);
  expect(
    await new QuotaGovernorStore(dir, clock).reserve({
      ...input,
      observation: {
        ...observation,
        windows: [{ ...observation.windows[0], durationMinutes: 300 }],
      },
    }),
  ).toEqual({ kind: "deferred", reason: "window_contract_changed" });
});

it("will not reassign a reserved occurrence when its schedule account configuration changes", async () => {
  const store = new QuotaGovernorStore(await directory(), clock);
  await store.reserve(input);
  expect(await store.reserve({ ...input, providerId: "different-provider" })).toEqual({
    kind: "deferred",
    reason: "execution_binding_changed",
  });
});

it("does not reclaim an unresolved filesystem lock based on its age", async () => {
  const store = new QuotaGovernorStore(await directory(), clock);
  await mkdir(`${store.accountPath(policy.account)}.lock`);
  expect(await store.reserve(input)).toEqual({ kind: "deferred", reason: "store_busy" });
});

it("rejects older observations after reopening the account ledger", async () => {
  const dir = await directory();
  await new QuotaGovernorStore(dir, clock).reserve(input);
  expect(
    await new QuotaGovernorStore(dir, clock).reserve({
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
  const store = new QuotaGovernorStore(dir, clock);
  const target = join(dir, "unrelated.json");
  await writeFile(target, "preserve");
  await symlink(target, store.accountPath(policy.account));
  await expect(store.reserve(input)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("preserve");
});

it("persists start intent before launch and prevents another start after a crash", async () => {
  const dir = await directory();
  const store = new QuotaGovernorStore(dir, clock);
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
  const reopened = new QuotaGovernorStore(dir, clock);
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
  const store = new QuotaGovernorStore(await directory(), clock);
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
  clockNow = nowMs + 1;
  const recovery = {
    ...binding,

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
  clockNow = nowMs + 120001;
  expect(
    await store.transition({
      ...binding,
      expectedGeneration: 3,
      event: resume,
    }),
  ).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: { action: "hold" },
  });
  clockNow = nowMs + 1;
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
  const store = new QuotaGovernorStore(await directory(), clock);
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
  clockNow = nowMs + 1;
  const recovery = {
    ...binding,

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
  const store = new QuotaGovernorStore(await directory(), clock);
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
  clockNow = nowMs + 1;
  await expect(
    store.transition({
      ...binding,
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
  const store = new QuotaGovernorStore(dir, clock);
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
  clockNow = nowMs + 1;
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
  const finalization = { ...binding, observation: postCompletion };
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
  const reopened = new QuotaGovernorStore(dir, clock);
  expect(await reopened.finalize(finalization)).toEqual({ kind: "finalized" });
  expect(await reopened.reserve(input)).toEqual({
    kind: "completed",
    reservationId: admitted.reservation.id,
  });
  const next = { ...input, occurrenceId: "next", observation: postCompletion };
  expect((await reopened.reserve(next)).kind).toBe("admitted");
  expect(await reopened.reservationState(policy.account, admitted.reservation.id)).toEqual({
    kind: "finalized",
  });
  expect(await reopened.reserve(input)).toEqual({
    kind: "completed",
    reservationId: admitted.reservation.id,
  });
  const ledger = JSON.parse(await readFile(reopened.accountPath(policy.account), "utf8"));
  expect(ledger.observation.observedAt).toBe(postCompletion.observedAt);
  expect(ledger.completions).toHaveLength(1);
});

it("allows cleanup at the freeze floor but does not admit another run against that allowance", async () => {
  const store = new QuotaGovernorStore(await directory(), clock);
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
  clockNow = nowMs + 1;
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
  expect(await store.finalize({ ...binding, observation: exhausted })).toEqual({
    kind: "finalized",
  });
  expect(
    await store.reserve({
      ...input,
      occurrenceId: "next",
      observation: exhausted,
    }),
  ).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: { action: "freeze" },
  });
});

it("retains unsettled charges from earlier executions when a resumed execution completes", async () => {
  const store = new QuotaGovernorStore(await directory(), clock);
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
  clockNow = nowMs + 1;
  const recovered = { ...observation, observedAt: new Date(nowMs + 1).toISOString() };
  await store.transition({
    ...binding,
    observation: recovered,

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

    expectedGeneration: 4,
    event: { type: "complete", executionId: "second", settlementId: "exit-two" },
  });
  clockNow = nowMs + 3;
  const receipt = {
    executionId: "second",
    authenticationGeneration: "auth",
    accountedAt: new Date(nowMs + 3).toISOString(),
  };
  const charges = { ...observation, observedAt: receipt.accountedAt, settledExecutions: [receipt] };
  expect(await store.finalize({ ...binding, observation: charges })).toEqual({
    kind: "deferred",
    reason: "charge_settlement_unavailable",
  });
  expect(
    await store.finalize({
      ...binding,

      observation: {
        ...charges,
        settledExecutions: [receipt, { ...receipt, executionId: "first" }],
      },
    }),
  ).toEqual({ kind: "finalized" });
});

it("rejects an initial reservation whose telemetry expires while queued", async () => {
  const store = new QuotaGovernorStore(await directory(), clock);
  const pending = store.reserve(input);
  clockNow += 120_001;
  expect(await pending).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: { reasons: [{ code: "telemetry_stale" }] },
  });
  await expect(readFile(store.accountPath(policy.account))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (
      await store.reserve({
        ...input,
        observation: { ...observation, observedAt: new Date(clockNow).toISOString() },
      })
    ).kind,
  ).toBe("admitted");
});

it.each(["start", "resume", "finalize"] as const)(
  "uses the locked store clock for queued %s and preserves custody on stale evidence",
  async (operation) => {
    const store = new QuotaGovernorStore(await directory(), clock);
    const admitted = await store.reserve(input);
    if (admitted.kind !== "admitted") throw new Error("Expected admission");
    const binding = { account: policy.account, reservationId: admitted.reservation.id };
    const start = {
      type: "start" as const,
      executionId: "first",
      authenticationGeneration: "auth",
    };
    if (operation !== "start") {
      await store.transition({ ...binding, observation, expectedGeneration: 0, event: start });
      if (operation === "resume") {
        await store.transition({
          ...binding,
          expectedGeneration: 1,
          event: { type: "freeze", reason: "quota" },
        });
        await store.transition({
          ...binding,
          expectedGeneration: 2,
          event: { type: "settled", executionId: "first", settlementId: "exit" },
        });
      } else {
        await store.transition({
          ...binding,
          expectedGeneration: 1,
          event: { type: "complete", executionId: "first", settlementId: "exit" },
        });
      }
    }
    clockNow += 1;
    const sample = () => ({
      ...observation,
      observedAt: new Date(clockNow).toISOString(),
      settledExecutions: [
        {
          executionId: "first",
          authenticationGeneration: "auth",
          accountedAt: new Date(clockNow).toISOString(),
        },
      ],
    });
    const execute = () =>
      operation === "finalize"
        ? store.finalize({ ...binding, observation: sample() })
        : store.transition({
            ...binding,
            observation: sample(),
            expectedGeneration: operation === "start" ? 0 : 3,
            event:
              operation === "start"
                ? start
                : {
                    type: "resume",
                    executionId: "second",
                    authenticationGeneration: "auth",
                    manual: false,
                  },
          });
    const before = await readFile(store.accountPath(policy.account), "utf8");
    const pending = execute();
    clockNow += 120_001;
    expect(await pending).toMatchObject({
      kind: "deferred",
      reason: "quota",
      decision: { reasons: [{ code: "telemetry_stale" }] },
    });
    expect(await readFile(store.accountPath(policy.account), "utf8")).toBe(before);
    expect((await execute()).kind).toBe(operation === "finalize" ? "finalized" : "transitioned");
    if (operation !== "finalize") {
      const execution = await store.execution(binding.account, binding.reservationId);
      clockNow += 120_001;
      expect(
        (
          await store.transition({
            ...binding,
            expectedGeneration: execution.generation,
            event: { type: "freeze", reason: "quota" },
          })
        ).kind,
      ).toBe("transitioned");
      expect(
        (
          await store.transition({
            ...binding,
            expectedGeneration: execution.generation + 1,
            event: {
              type: "settled",
              executionId: operation === "start" ? "first" : "second",
              settlementId: "cleanup",
            },
          })
        ).kind,
      ).toBe("transitioned");
    }
  },
);

it("rechecks freshness after persisting the accounting contract", async () => {
  const dir = await directory();
  const initial = new QuotaGovernorStore(dir, clock);
  expect((await initial.configureAccountingContract({ policy, expectedRevision: null })).kind).toBe(
    "configured",
  );
  let checks = 0;
  const store = new QuotaGovernorStore(dir, {
    nowMs: () => (++checks === 1 ? nowMs : nowMs + 120_001),
  });
  expect(await store.reserve(input)).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: { reasons: [{ code: "telemetry_stale" }] },
  });
  expect(checks).toBe(2);
  await expect(readFile(store.accountPath(policy.account))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const saved = JSON.parse(await readFile(`${store.accountPath(policy.account)}.contract`, "utf8"));
  expect(saved.account).toEqual(policy.account);
});
