import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { QuotaGovernorStore } from "./governor-store.js";

const directories: string[] = [];
afterEach(async () => {
  currentTime = now;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const now = Date.parse("2026-09-14T08:00:00Z");
let currentTime = now;
const clock = { nowMs: () => currentTime };
const account = { issuer: "provider", accountId: "account" };
const identity = {
  ...account,
  bucketId: "coding",
  meterId: "weekly",
  revision: "one",
  unit: "weekly_quota_points" as const,
};
const bucket = {
  configuration: { maximumUnitsPerHour: 1, burstUnits: 2, initialUnits: 1 },
  accounting: { identity, counterOrigin: "persistent", observedAt: now, cumulativeUnits: 100 },
  envelopes: [
    { identity, availableUnits: 40, horizon: { kind: "fixed_rate" as const, unitsPerHour: 1 } },
  ],
  reserveUnits: 1,
};
const input = {
  account,
  maxObservationAgeMs: 120_000,
  buckets: [bucket],
  reservationId: "slice",
};
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "quota-pacing-store-"));
  directories.push(path);
  return path;
}

it("serializes competing reservations and preserves their balance across restart", async () => {
  const path = await directory();
  const store = new QuotaGovernorStore(path, clock);
  const outcomes = await Promise.all([
    store.updatePacing(input),
    store.updatePacing({ ...input, reservationId: "other" }),
  ]);
  expect(outcomes.map((result) => result.kind)).toEqual(["reserved", "held"]);
  expect(await new QuotaGovernorStore(path, clock).updatePacing(input)).toEqual(outcomes[0]);
  expect(
    (await new QuotaGovernorStore(path, clock).updatePacing({ ...input, reservationId: "other" }))
      .kind,
  ).toBe("held");
});

it("uses decision time after a queued request acquires the account lock", async () => {
  let reads = 0;
  const store = new QuotaGovernorStore(await directory(), {
    nowMs: () => now + (reads++ === 0 ? 0 : 120_001),
  });
  const results = await Promise.allSettled([
    store.updatePacing(input),
    store.updatePacing({ ...input, reservationId: "queued" }),
  ]);
  expect(results[0]).toMatchObject({ status: "fulfilled", value: { kind: "reserved" } });
  expect(results[1]).toMatchObject({
    status: "rejected",
    reason: new Error("Pacing requires fresh accounting and a bounded allowance envelope."),
  });
  expect(reads).toBe(2);
});

it("reserves a vector atomically and does not grant initial credit again after a hold", async () => {
  const store = new QuotaGovernorStore(await directory(), clock);
  const credits = { ...identity, meterId: "credits", unit: "credits" as const };
  const second = {
    ...bucket,
    configuration: { ...bucket.configuration, initialUnits: 0 },
    accounting: { ...bucket.accounting, identity: credits },
    envelopes: [{ ...bucket.envelopes[0]!, identity: credits }],
  };
  const held = await store.updatePacing({ ...input, buckets: [bucket, second] });
  expect(held).toMatchObject({
    kind: "held",
    buckets: [{ reservations: [] }, { reservations: [] }],
  });
  expect(
    (
      await store.updatePacing({
        ...input,
        buckets: [bucket, { ...second, configuration: bucket.configuration }],
      })
    ).kind,
  ).toBe("held");
  currentTime = now + 3_600_000;
  const later = structuredClone([bucket, second]);
  for (const entry of later) entry.accounting.observedAt = now + 3_600_000;
  expect((await store.updatePacing({ ...input, buckets: later })).kind).toBe("reserved");
});

it("requires fresh accounting and preserves the file on failed reconciliation", async () => {
  const store = new QuotaGovernorStore(await directory(), clock);
  await store.updatePacing(input);
  const path = `${store.accountPath(account)}.pacing`;
  const before = await readFile(path, "utf8");
  currentTime = now + 120_001;
  await expect(store.updatePacing(input)).rejects.toThrow("fresh accounting");
  currentTime = now;
  await expect(
    store.updatePacing({
      ...input,
      buckets: [{ ...bucket, accounting: { ...bucket.accounting, counterOrigin: "new" } }],
    }),
  ).rejects.toThrow("identity");
  await expect(store.updatePacing({ ...input, buckets: [] })).rejects.toThrow("at least one meter");
  expect(await readFile(path, "utf8")).toBe(before);
});

it("rejects a null journal instead of recreating the initial allowance", async () => {
  const store = new QuotaGovernorStore(await directory(), clock);
  await store.updatePacing(input);
  const path = `${store.accountPath(account)}.pacing`;
  await writeFile(path, "null");
  await expect(store.updatePacing(input)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("null");
});

it("persists trusted settlement without permitting the same slice to run again", async () => {
  const path = await directory();
  const store = new QuotaGovernorStore(path, clock);
  await store.updatePacing(input);
  currentTime = now + 1;
  const next = {
    ...input,
    buckets: [
      {
        ...bucket,
        accounting: { ...bucket.accounting, observedAt: now + 1, cumulativeUnits: 101 },
        settlements: [{ reservationId: "slice", accountedAt: now + 1 }],
      },
    ],
  };
  expect((await store.updatePacing(next)).kind).toBe("settled");
  expect((await new QuotaGovernorStore(path, clock).updatePacing(next)).kind).toBe("settled");
});
