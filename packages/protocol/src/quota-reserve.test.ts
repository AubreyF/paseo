import { expect, it } from "vitest";
import {
  DEFAULT_QUOTA_RESERVE_POLICY,
  InvalidQuotaReservePolicyError,
  parseQuotaReservePolicy,
  QuotaReserveLaunchPolicySchema,
} from "./quota-reserve.js";

it.each([
  { kind: "profile" },
  { kind: "off" },
  { kind: "protected", cruisePct: 15, redlinePct: 10 },
])("accepts the explicit $kind launch selection", (selection) => {
  expect(QuotaReserveLaunchPolicySchema.parse(selection)).toEqual(selection);
});

it("accepts the approved default and explicit Off", () => {
  expect(parseQuotaReservePolicy(DEFAULT_QUOTA_RESERVE_POLICY)).toEqual({
    kind: "protected",
    cruisePct: 15,
    redlinePct: 10,
  });
  expect(parseQuotaReservePolicy({ kind: "off" })).toEqual({ kind: "off" });
});

it.each([10, 9])("rejects Cruise Reserve %s at or below Redline", (cruisePct) => {
  expect(() => parseQuotaReservePolicy({ kind: "protected", cruisePct, redlinePct: 10 })).toThrow(
    InvalidQuotaReservePolicyError,
  );
});

it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid percentage %s",
  (cruisePct) => {
    expect(() =>
      parseQuotaReservePolicy({ kind: "protected", cruisePct, redlinePct: 0 }),
    ).toThrow();
  },
);

it("accepts a zero Redline with a positive Cruise Reserve", () => {
  expect(parseQuotaReservePolicy({ kind: "protected", cruisePct: 50, redlinePct: 0 })).toEqual({
    kind: "protected",
    cruisePct: 50,
    redlinePct: 0,
  });
});
