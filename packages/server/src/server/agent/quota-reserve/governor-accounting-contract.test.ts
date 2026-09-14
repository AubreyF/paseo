import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { QuotaGovernorPolicy, QuotaObservation } from "@getpaseo/protocol/quota-governor";
import { QuotaGovernorStore } from "./governor-store.js";
import {
  createAccountingContract,
  satisfiesAccountingContract,
} from "./governor-accounting-contract.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const nowMs = Date.parse("2026-09-14T12:00:00Z");
const policy: QuotaGovernorPolicy = {
  version: 1,
  account: { issuer: "test", accountId: "account" },
  requiredWindows: [{ bucketId: "coding", windowId: "weekly", durationMinutes: 10080 }],
  launchFloorPercent: 30,
  freezeFloorPercent: 25,
  maxObservationAgeSeconds: 120,
  consumptionLimits: [
    {
      meterId: "gross",
      bucketId: "coding",
      revision: "original",
      unit: "weekly_quota_points",
      period: { kind: "calendar_day", timezone: "UTC" },
      throttleAt: 25,
      holdAt: 30,
      freezeAt: 35,
    },
  ],
  recovery: "automatic_after_reconciliation",
};
const observation: QuotaObservation = {
  status: "available",
  account: policy.account,
  observedAt: new Date(nowMs).toISOString(),
  windows: [
    { ...policy.requiredWindows[0]!, usedPercent: 10, resetsAt: null, semantics: "unknown" },
  ],
  consumptionMeters: [
    {
      meterId: "gross",
      bucketId: "coding",
      revision: "original",
      unit: "weekly_quota_points",
      quality: "authoritative",
      coverageStart: "2026-09-12T00:00:00Z",
      coverageEnd: new Date(nowMs).toISOString(),
      intervals: [],
    },
  ],
};
const input = {
  policy,
  observation,
  nowMs,
  scheduleId: "first",
  occurrenceId: "first",
  providerId: "alias",
};
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "account-contract-"));
  dirs.push(dir);
  return { dir, store: new QuotaGovernorStore(dir) };
}

it("canonicalizes timezone aliases while preserving meter definition and account identity", () => {
  const contract = createAccountingContract(policy);
  const changed = structuredClone(policy);
  changed.consumptionLimits[0]!.period = { kind: "calendar_day", timezone: "Etc/UTC" };
  changed.consumptionLimits[0]!.holdAt = 29;
  expect(satisfiesAccountingContract(contract, changed)).toBe(true);
  changed.consumptionLimits[0]!.revision = "new-denominator";
  expect(satisfiesAccountingContract(contract, changed)).toBe(false);
  expect(satisfiesAccountingContract(contract, { ...policy, consumptionLimits: [] })).toBe(false);
  expect(
    satisfiesAccountingContract(contract, {
      ...policy,
      account: { ...policy.account, accountId: "other" },
    }),
  ).toBe(false);
});

it("requires explicit initial configuration and compare-and-swap without granting missing usage", async () => {
  const { store } = await setup();
  expect(await store.reserve(input)).toEqual({
    kind: "deferred",
    reason: "accounting_contract_missing",
  });
  const configured = await store.configureAccountingContract({ policy, expectedRevision: null });
  expect(configured.kind).toBe("configured");
  await expect(
    store.configureAccountingContract({ policy, expectedRevision: null }),
  ).rejects.toThrow("contract changed");
  const contract = await store.accountingContract(policy.account);
  expect(contract).not.toBeNull();
  const changed = structuredClone(policy);
  changed.consumptionLimits[0]!.holdAt = 29;
  expect(
    await store.configureAccountingContract({
      policy: changed,
      expectedRevision: contract!.revision,
    }),
  ).toEqual({ kind: "configured", contract });
  expect(
    await store.reserve({ ...input, observation: { ...observation, consumptionMeters: [] } }),
  ).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: { reasons: [{ code: "meter_unavailable" }] },
  });
});

it("retains the account contract across completion, alias changes and restart", async () => {
  const { store, dir } = await setup();
  await store.configureAccountingContract({ policy, expectedRevision: null });
  const admitted = await store.reserve(input);
  if (admitted.kind !== "admitted") throw Error("Expected admission");
  const binding = {
    account: policy.account,
    reservationId: admitted.reservation.id,
    nowMs,
    observation,
  };
  await store.transition({
    ...binding,
    expectedGeneration: 0,
    event: { type: "start", executionId: "execution", authenticationGeneration: "auth" },
  });
  await store.transition({
    ...binding,
    expectedGeneration: 1,
    event: { type: "complete", executionId: "execution", settlementId: "exit" },
  });
  const at = new Date(nowMs + 1).toISOString();
  const meters = structuredClone(observation.consumptionMeters);
  for (const meter of meters) meter.coverageEnd = at;
  const settled = {
    ...observation,
    observedAt: at,
    consumptionMeters: meters,
    settledExecutions: [
      { executionId: "execution", authenticationGeneration: "auth", accountedAt: at },
    ],
  };
  expect(await store.finalize({ ...binding, observation: settled, nowMs: nowMs + 1 })).toEqual({
    kind: "finalized",
  });
  const reopened = new QuotaGovernorStore(dir);
  const next = {
    ...input,
    observation: settled,
    nowMs: nowMs + 1,
    scheduleId: "other",
    occurrenceId: "other",
    providerId: "other-alias",
  };
  const changed = structuredClone(policy);
  changed.consumptionLimits[0]!.period = { kind: "calendar_day", timezone: "America/Los_Angeles" };
  expect(await reopened.reserve({ ...next, policy: changed })).toEqual({
    kind: "deferred",
    reason: "accounting_migration_required",
  });
  const contract = await reopened.accountingContract(policy.account);
  expect(
    await reopened.configureAccountingContract({
      policy: changed,
      expectedRevision: contract!.revision,
    }),
  ).toEqual({ kind: "deferred", reason: "accounting_migration_required" });
  expect((await reopened.reserve(next)).kind).toBe("admitted");
});

it("fails closed on corrupt saved contract rather than bootstrapping fresh semantics", async () => {
  const { store } = await setup();
  await writeFile(`${store.accountPath(policy.account)}.contract`, "null");
  await expect(store.reserve(input)).rejects.toThrow();
});

it.each([false, true])(
  "does not bootstrap strict configuration from floor-only history (legacy=%s)",
  async (legacy) => {
    const { store, dir } = await setup();
    const admitted = await store.reserve({
      ...input,
      policy: { ...policy, consumptionLimits: [] },
    });
    if (admitted.kind !== "admitted") throw Error("Expected floor admission");
    const binding = {
      account: policy.account,
      reservationId: admitted.reservation.id,
      nowMs,
      observation,
    };
    await store.transition({
      ...binding,
      expectedGeneration: 0,
      event: { type: "start", executionId: "execution", authenticationGeneration: "auth" },
    });
    await store.transition({
      ...binding,
      expectedGeneration: 1,
      event: { type: "complete", executionId: "execution", settlementId: "exit" },
    });
    const at = new Date(nowMs + 1).toISOString();
    const settled = structuredClone(observation);
    settled.observedAt = at;
    for (const meter of settled.consumptionMeters) meter.coverageEnd = at;
    settled.settledExecutions = [
      { executionId: "execution", authenticationGeneration: "auth", accountedAt: at },
    ];
    expect(await store.finalize({ ...binding, observation: settled, nowMs: nowMs + 1 })).toEqual({
      kind: "finalized",
    });
    if (legacy) {
      const path = store.accountPath(policy.account);
      const old = JSON.parse(await readFile(path, "utf8"));
      delete old.accountingContractRevision;
      await writeFile(path, JSON.stringify(old));
    }
    const reopened = new QuotaGovernorStore(dir);
    expect(
      await reopened.reserve({
        ...input,
        observation: settled,
        nowMs: nowMs + 1,
        occurrenceId: "strict",
      }),
    ).toEqual({ kind: "deferred", reason: "accounting_contract_missing" });
    expect(await reopened.configureAccountingContract({ policy, expectedRevision: null })).toEqual({
      kind: "deferred",
      reason: "accounting_migration_required",
    });
  },
);

it("imports actual legacy strict semantics and records migration provenance", async () => {
  const { store } = await setup();
  await store.configureAccountingContract({ policy, expectedRevision: null });
  await store.reserve(input);
  const path = store.accountPath(policy.account);
  const old = JSON.parse(await readFile(path, "utf8"));
  delete old.accountingContractRevision;
  await writeFile(path, JSON.stringify(old));
  await rm(`${path}.contract`);
  await rm(`${path}.contract-required`);
  const legacy = await store.accountingContract(policy.account);
  expect(legacy?.revision).toMatch(/^legacy:/);
  expect(satisfiesAccountingContract(legacy!, policy)).toBe(true);
  expect((await store.reserve(input)).kind).toBe("admitted");
  await rm(`${path}.contract`);
  await expect(store.accountingContract(policy.account)).rejects.toThrow("contract is missing");
});

it("does not recreate a missing configured contract even before first admission", async () => {
  const { store } = await setup();
  await store.configureAccountingContract({ policy, expectedRevision: null });
  await rm(`${store.accountPath(policy.account)}.contract`);
  await expect(store.reserve(input)).rejects.toThrow("contract is missing");
  await expect(
    store.configureAccountingContract({ policy, expectedRevision: null }),
  ).rejects.toThrow("contract is missing");
});
