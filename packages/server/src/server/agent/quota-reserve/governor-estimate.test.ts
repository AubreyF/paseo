import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { QuotaGovernorPolicy, QuotaObservation } from "@getpaseo/protocol/quota-governor";
import { QuotaGovernorStore } from "./governor-store.js";
import { evaluateQuotaGovernor } from "./governor-evaluate.js";

const origin = Date.parse("2026-09-17T00:00:00Z");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const policy: QuotaGovernorPolicy = {
  version: 1,
  account: { issuer: "openai", accountId: "fixture" },
  requiredWindows: [{ bucketId: "coding", windowId: "weekly", durationMinutes: 10080 }],
  launchFloorPercent: 30,
  freezeFloorPercent: 25,
  maxObservationAgeSeconds: 120,
  consumptionLimits: [],
  recovery: "automatic_after_reconciliation",
  estimatedHourly: { bucketId: "coding", windowId: "weekly", maxConsumedPoints: 10 },
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "hourly-quota-"));
  directories.push(dir);
  let now = origin;
  let store = new QuotaGovernorStore(dir, { nowMs: () => now });
  const raw = (used: number, reset: string | null = null): QuotaObservation => ({
    status: "available",
    account: policy.account,
    observedAt: new Date(now).toISOString(),
    consumptionMeters: [],
    windows: [
      {
        bucketId: "coding",
        windowId: "weekly",
        durationMinutes: 10080,
        usedPercent: used,
        resetsAt: reset,
        semantics: "unknown",
      },
    ],
  });
  return {
    dir,
    raw,
    get store() {
      return store;
    },
    advance(ms: number) {
      now += ms;
    },
    restart() {
      store = new QuotaGovernorStore(dir, { nowMs: () => now });
    },
    async sample(used: number, generation = "auth", reset: string | null = null) {
      return store.observeEstimatedUsage({
        observation: raw(used, reset),
        authenticationGeneration: generation,
        bucketId: "coding",
        windowId: "weekly",
        maxObservationAgeSeconds: 120,
      });
    },
    evaluate(observation: QuotaObservation, phase: "admission" | "active" = "admission") {
      return evaluateQuotaGovernor({ policy, observation, nowMs: now, phase });
    },
  };
}

it("retains account-wide estimates through restart and stops at the exact hourly ceiling", async () => {
  const f = await fixture();
  expect(f.evaluate(await f.sample(20))).toMatchObject({
    action: "hold",
    reasons: [{ code: "estimate_unavailable" }],
  });
  for (let minute = 1; minute <= 60; minute++) {
    f.advance(60_000);
    if (minute === 30) f.restart();
    await f.sample(20 + minute / 6);
  }
  const full = await f.sample(30);
  expect(full).toMatchObject({ estimatedHourlyUsage: { consumedPoints: 10 } });
  expect(f.evaluate(full, "active")).toEqual({
    action: "freeze",
    reasons: [{ code: "estimated_hourly_limit", consumed: 10 }],
  });
  f.advance(60_000);
  expect(f.evaluate(await f.sample(30)).action).toBe("admit");
});

it.each(["gap", "reset", "auth"] as const)(
  "holds again after %s instead of manufacturing zero usage",
  async (event) => {
    const f = await fixture();
    await f.sample(20);
    for (let minute = 0; minute < 60; minute++) {
      f.advance(60_000);
      await f.sample(20);
    }
    expect(f.evaluate(await f.sample(20)).action).toBe("admit");
    f.advance(event === "gap" ? 120_001 : 1000);
    const next = await f.sample(
      event === "reset" ? 0 : 20,
      event === "auth" ? "new-auth" : "auth",
      event === "reset" ? "2026-09-24T00:00:00Z" : null,
    );
    expect(f.evaluate(next, "active")).toMatchObject({
      action: "freeze",
      reasons: [{ code: "estimate_unavailable" }],
    });
  },
);

it("does not reset accounting on corrupt persistence or conflicting timestamps", async () => {
  const f = await fixture();
  await f.sample(20);
  await expect(f.sample(21)).rejects.toThrow("conflict");
  await writeFile(`${f.store.accountPath(policy.account)}.estimate`, "broken");
  f.restart();
  await expect(f.sample(20)).rejects.toThrow();
});

it("releases confirmed execution without a billing receipt, retaining hourly usage for the next admission", async () => {
  const f = await fixture();
  await f.store.configureAccountingContract({ policy, expectedRevision: null });
  await f.sample(20);
  for (let minute = 0; minute < 60; minute++) {
    f.advance(60_000);
    await f.sample(20);
  }
  const observation = await f.sample(20);
  const request = {
    policy,
    observation,
    scheduleId: "factory",
    occurrenceId: "one",
    providerId: "fixture",
  };
  const reservation = await f.store.reserve(request);
  expect(reservation.kind).toBe("admitted");
  if (reservation.kind !== "admitted") throw new Error("Admission failed");
  const binding = { account: policy.account, reservationId: reservation.reservation.id };
  await f.store.transition({
    ...binding,
    expectedGeneration: 0,
    observation,
    event: { type: "start", executionId: "attempt-one", authenticationGeneration: "auth" },
  });
  await expect(f.store.finalize({ ...binding, observation })).rejects.toThrow("unconfirmed");
  await f.store.transition({
    ...binding,
    expectedGeneration: 1,
    event: {
      type: "complete",
      executionId: "attempt-one",
      settlementId: "process-custody-receipt",
    },
  });
  f.advance(1000);
  const after = await f.sample(30);
  expect(await f.store.finalize({ ...binding, observation: after })).toEqual({ kind: "finalized" });
  f.restart();
  expect(
    await f.store.reserve({ ...request, observation: after, occurrenceId: "two" }),
  ).toMatchObject({
    kind: "deferred",
    reason: "quota",
    decision: { action: "freeze", reasons: [{ code: "estimated_hourly_limit", consumed: 10 }] },
  });
});
