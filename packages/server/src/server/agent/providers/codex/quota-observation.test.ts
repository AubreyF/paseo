import { expect, it } from "vitest";
import { CodexQuotaObservationSession } from "./quota-observation.js";

function transport(responses: unknown[]) {
  const calls: string[] = [];
  return {
    calls,
    request: async (method: string) => {
      calls.push(method);
      if (responses.length === 0) throw new Error("Unexpected metadata call");
      return responses.shift();
    },
    dispose: async () => {},
  };
}

const account = { account: { type: "chatgpt" } };
const bucket = {
  limitId: "coding",
  primary: { usedPercent: 51, windowDurationMins: 10080, resetsAt: 1800000000 },
  secondary: null,
};
const limits = { accountId: "account-a", rateLimitsByLimitId: { coding: bucket } };
const emptyUsage = { summary: null, dailyUsageBuckets: null };
const now = () => new Date("2026-09-14T08:00:00Z");

it("keeps account and window identity without inventing a gross consumption meter", async () => {
  const rpc = transport([
    account,
    limits,
    {
      summary: { lifetimeTokens: 42 },
      dailyUsageBuckets: [{ startDate: "2026-09-14", tokens: 9 }],
    },
    limits,
  ]);
  const session = new CodexQuotaObservationSession(rpc, now);
  expect(await session.read()).toEqual({
    status: "available",
    account: { issuer: "openai", accountId: "account-a" },
    observedAt: "2026-09-14T08:00:00.000Z",
    windows: [
      {
        bucketId: "coding",
        windowId: "primary",
        durationMinutes: 10080,
        usedPercent: 51,
        resetsAt: "2027-01-15T08:00:00.000Z",
        semantics: "unknown",
      },
    ],
    consumptionMeters: [],
    tokenActivity: { lifetimeTokens: 42, dailyBuckets: [{ date: "2026-09-14", tokens: 9 }] },
  });
  expect(rpc.calls).toEqual([
    "account/read",
    "account/rateLimits/read",
    "account/usage/read",
    "account/rateLimits/read",
  ]);
});

it("rejects an account change while collecting the observation", async () => {
  const rpc = transport([account, limits, emptyUsage, { ...limits, accountId: "account-b" }]);
  expect(await new CodexQuotaObservationSession(rpc, now).read()).toEqual({
    status: "unavailable",
    reason: "account_changed",
  });
});

it("does not fall back to the legacy bucket when the multi-bucket view is explicitly empty", async () => {
  const noBuckets = { accountId: "account-a", rateLimitsByLimitId: {}, rateLimits: bucket };
  const rpc = transport([account, noBuckets, emptyUsage, noBuckets]);
  expect(await new CodexQuotaObservationSession(rpc, now).read()).toEqual({
    status: "unavailable",
    reason: "windows_unavailable",
  });
});

it("rejects incomplete applicable windows instead of treating them as absent", async () => {
  const incomplete = { ...limits, rateLimitsByLimitId: { coding: { ...bucket, secondary: {} } } };
  const rpc = transport([account, incomplete, emptyUsage, incomplete]);
  expect(await new CodexQuotaObservationSession(rpc, now).read()).toEqual({
    status: "unavailable",
    reason: "invalid_observation",
  });
});

it("requires identity from the usage response", async () => {
  const rpc = transport([account, { ...limits, accountId: null }]);
  expect(await new CodexQuotaObservationSession(rpc, now).read()).toEqual({
    status: "unavailable",
    reason: "identity_unavailable",
  });
});
