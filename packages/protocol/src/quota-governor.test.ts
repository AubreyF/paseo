import { expect, it } from "vitest";
import { parseQuotaGovernorPolicy } from "./quota-governor.js";

const policy = {
  version: 1,
  account: { issuer: "fixture", accountId: "fixture" },
  requiredWindows: [{ bucketId: "codex", windowId: "primary", durationMinutes: 10080 }],
  launchFloorPercent: 0,
  freezeFloorPercent: 0,
  maxObservationAgeSeconds: 120,
  consumptionLimits: [],
  recovery: "automatic_after_reconciliation",
};

it("accepts explicit zero reserves without dropping freshness or account requirements", () => {
  expect(parseQuotaGovernorPolicy(policy)).toEqual(policy);
  expect(() => parseQuotaGovernorPolicy({ ...policy, maxObservationAgeSeconds: 121 })).toThrow();
  expect(() => parseQuotaGovernorPolicy({ ...policy, requiredWindows: [] })).toThrow();
});

it.each([
  [0, 1],
  [25, 25],
  [25, 30],
  [-1, 0],
  [0, -1],
])("rejects invalid launch/freeze floors %s/%s", (launchFloorPercent, freezeFloorPercent) => {
  expect(() =>
    parseQuotaGovernorPolicy({
      ...policy,
      launchFloorPercent,
      freezeFloorPercent,
    }),
  ).toThrow();
});
