import { expect, it } from "vitest";
import {
  advanceQuotaPacing,
  reserveQuotaPacing,
  settleQuotaPacing,
  type PacingAccounting,
  type PacingState,
} from "./governor-pacing.js";

const now = Date.parse("2026-09-14T08:00:00Z");
const accounting: PacingAccounting = {
  identity: {
    issuer: "provider",
    accountId: "account",
    bucketId: "coding",
    meterId: "weekly-consumption",
    revision: "definition-one",
    unit: "weekly_quota_points",
  },
  counterOrigin: "persistent-origin",
  observedAt: now,
  cumulativeUnits: 100,
};
const configuration = { maximumUnitsPerHour: 2, burstUnits: 2, initialUnits: 0 };
function advance(state: PacingState | null, hours = 0, consumed = 0) {
  return advanceQuotaPacing({
    state,
    configuration,
    accounting: {
      ...accounting,
      observedAt: now + hours * 3_600_000,
      cumulativeUnits: 100 + consumed,
    },
    nowMs: now + hours * 3_600_000,
    maxObservationAgeMs: 120_000,
    envelopes: [
      {
        identity: accounting.identity,
        availableUnits: 40,
        horizon: { kind: "fixed_rate", unitsPerHour: 1 },
      },
    ],
  });
}

it("starts empty and preserves earned allowance through a serialized restart", () => {
  const initial = advance(null);
  expect(reserveQuotaPacing({ state: initial, reservationId: "slice", units: 1 }).kind).toBe(
    "held",
  );
  const earned = advance(initial, 1);
  const restored = JSON.parse(JSON.stringify(earned));
  expect(advance(restored, 1)).toEqual(earned);
  const first = reserveQuotaPacing({ state: restored, reservationId: "slice", units: 1 });
  expect(first.kind).toBe("reserved");
  expect(reserveQuotaPacing({ state: first.state, reservationId: "slice", units: 1 })).toEqual(
    first,
  );
  expect(reserveQuotaPacing({ state: first.state, reservationId: "second", units: 1 }).kind).toBe(
    "held",
  );
});

it("retains overspending as debt and waits for earnings to repay it", () => {
  const spent = advance(advance(null), 1, 4);
  expect(spent.balanceUnits).toBe(-3);
  expect(advance(spent, 3, 4).balanceUnits).toBe(-1);
  const repaid = advance(spent, 5, 4);
  expect(repaid.balanceUnits).toBe(1);
  expect(reserveQuotaPacing({ state: repaid, reservationId: "next", units: 1 }).kind).toBe(
    "reserved",
  );
});

it("does not forgive spending by applying the burst cap after the charge", () => {
  expect(advance(advance(null), 24, 3).balanceUnits).toBe(-1);
});

it("retains estimates until accounting settles and never reserves a settled slice again", () => {
  const earned = advance(advance(null), 1);
  const reserved = reserveQuotaPacing({ state: earned, reservationId: "slice", units: 1 }).state;
  const charged = advance(reserved, 2, 0.5);
  expect(charged.reservations).toHaveLength(1);
  const settled = settleQuotaPacing({
    state: charged,
    reservationId: "slice",
    accountedAt: now + 2 * 3_600_000,
  });
  expect(settled.balanceUnits).toBe(1.5);
  expect(settled.reservations).toEqual([]);
  expect(reserveQuotaPacing({ state: settled, reservationId: "slice", units: 1 }).kind).toBe(
    "settled",
  );
});

it("bounds reset-aware drawdown by compatible daily and hourly envelopes", () => {
  const state = advanceQuotaPacing({
    state: null,
    configuration,
    accounting,
    nowMs: now,
    maxObservationAgeMs: 120_000,
    envelopes: [
      {
        identity: accounting.identity,
        availableUnits: 45,
        horizon: { kind: "fixed_reset", resetsAt: now + 5 * 24 * 3_600_000 },
      },
      {
        identity: accounting.identity,
        availableUnits: 3,
        horizon: { kind: "fixed_reset", resetsAt: now + 12 * 3_600_000 },
      },
      {
        identity: accounting.identity,
        availableUnits: 1,
        horizon: { kind: "fixed_rate", unitsPerHour: 0.2 },
      },
    ],
  });
  expect(state.unitsPerHour).toBe(0.2);
  expect(state.balanceUnits).toBe(0);
});

it("caps the rate near reset and does not create reset credit", () => {
  const state = advanceQuotaPacing({
    state: null,
    configuration,
    accounting,
    nowMs: now,
    maxObservationAgeMs: 120_000,
    envelopes: [
      {
        identity: accounting.identity,
        availableUnits: 40,
        horizon: { kind: "fixed_reset", resetsAt: now + 1 },
      },
    ],
  });
  expect(state.unitsPerHour).toBe(2);
  expect(state.balanceUnits).toBe(0);
});

it("applies capacity increases only after accrued earnings meet the old burst cap", () => {
  const previous = advance(null);
  const state = advanceQuotaPacing({
    state: previous,
    configuration: { ...configuration, burstUnits: 20, maximumUnitsPerHour: 20 },
    accounting: { ...accounting, observedAt: now + 24 * 3_600_000 },
    nowMs: now + 24 * 3_600_000,
    maxObservationAgeMs: 120_000,
    envelopes: [
      {
        identity: accounting.identity,
        availableUnits: 40,
        horizon: { kind: "fixed_rate", unitsPerHour: 20 },
      },
    ],
  });
  expect(state.balanceUnits).toBe(2);
  expect(state.unitsPerHour).toBe(20);
});

it("rejects accounting resets, identity changes and conflicting observations", () => {
  const state = advance(null);
  const base = {
    state,
    configuration,
    accounting,
    nowMs: now,
    maxObservationAgeMs: 120_000,
    envelopes: [
      {
        identity: accounting.identity,
        availableUnits: 40,
        horizon: { kind: "fixed_rate" as const, unitsPerHour: 1 },
      },
    ],
  };
  expect(() =>
    advanceQuotaPacing({ ...base, accounting: { ...accounting, cumulativeUnits: 99 } }),
  ).toThrow("regressed");
  expect(() =>
    advanceQuotaPacing({ ...base, accounting: { ...accounting, cumulativeUnits: 101 } }),
  ).toThrow("conflicts");
  expect(() =>
    advanceQuotaPacing({ ...base, accounting: { ...accounting, counterOrigin: "reset" } }),
  ).toThrow("identity");
  expect(() =>
    advanceQuotaPacing({
      ...base,
      accounting: { ...accounting, identity: { ...accounting.identity, accountId: "other" } },
    }),
  ).toThrow("identity");
  expect(() => advanceQuotaPacing({ ...base, nowMs: now + 120_001 })).toThrow("fresh accounting");
  expect(() =>
    advanceQuotaPacing({
      ...base,
      envelopes: [{ ...base.envelopes[0], identity: { ...accounting.identity, unit: "tokens" } }],
    }),
  ).toThrow("different accounting identity");
});

it("does not accept settlement from before the reservation", () => {
  const earned = advance(advance(null), 1);
  const reserved = reserveQuotaPacing({ state: earned, reservationId: "slice", units: 1 }).state;
  expect(() =>
    settleQuotaPacing({ state: reserved, reservationId: "slice", accountedAt: now }),
  ).toThrow("unconfirmed");
});

it("does not let settlement inflate headroom that fell below the outstanding estimate", () => {
  const settings = { maximumUnitsPerHour: 1, burstUnits: 10, initialUnits: 10 };
  const initial = advanceQuotaPacing({
    state: null,
    configuration: settings,
    accounting,
    nowMs: now,
    maxObservationAgeMs: 120_000,
    envelopes: [
      {
        identity: accounting.identity,
        availableUnits: 10,
        horizon: { kind: "fixed_rate", unitsPerHour: 1 },
      },
    ],
  });
  const reserved = reserveQuotaPacing({ state: initial, reservationId: "old", units: 8 }).state;
  const reduced = advanceQuotaPacing({
    state: reserved,
    configuration: settings,
    accounting: { ...accounting, observedAt: now + 1 },
    nowMs: now + 1,
    maxObservationAgeMs: 120_000,
    envelopes: [
      {
        identity: accounting.identity,
        availableUnits: 3,
        horizon: { kind: "fixed_rate", unitsPerHour: 1 },
      },
    ],
  });
  const settled = settleQuotaPacing({ state: reduced, reservationId: "old", accountedAt: now + 1 });
  expect(reserveQuotaPacing({ state: reduced, reservationId: "old", units: 8 }).kind).toBe("held");
  expect(settled.balanceUnits).toBe(3);
  expect(reserveQuotaPacing({ state: settled, reservationId: "new", units: 8 }).kind).toBe("held");
});

it("rejects duplicate reservation identities in restored accounting", () => {
  const state = advance(advance(null), 1);
  const reserved = reserveQuotaPacing({ state, reservationId: "slice", units: 1 }).state;
  reserved.reservations.push({ ...reserved.reservations[0]! });
  expect(() => advance(reserved, 1)).toThrow("Invalid retained pacing state");
});
