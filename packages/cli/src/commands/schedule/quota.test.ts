import { expect, it } from "vitest";
import type { QuotaObservation } from "@getpaseo/protocol/quota-governor";
import { inspectScheduleQuota } from "./quota.js";

it("shows attributable account evidence without labeling missing consumption as zero usage", async () => {
  let closed = 0;
  const providers: string[] = [];
  const observation: QuotaObservation = {
    status: "available",
    account: { issuer: "provider", accountId: "private-account-12345678" },
    observedAt: "2026-09-14T08:00:00Z",
    windows: [
      {
        bucketId: "coding",
        windowId: "weekly",
        durationMinutes: 10080,
        usedPercent: 62,
        resetsAt: null,
        semantics: "unknown",
      },
    ],
    consumptionMeters: [],
  };
  const result = await inspectScheduleQuota({
    providerId: "secondary",
    client: {
      readProviderQuotaObservation: async (providerId) => {
        providers.push(providerId);
        return { requestId: "request", providerId, observation };
      },
      close: async () => {
        closed++;
      },
    },
  });
  expect(providers).toEqual(["secondary"]);
  expect(result.data).toContainEqual({ key: "Authenticated account", value: "...12345678" });
  expect(result.data).toContainEqual({
    key: "coding / weekly",
    value: `38% remaining (${(10080).toLocaleString()} min)`,
  });
  expect(result.data).toContainEqual({ key: "Consumption meters", value: "0" });
  expect(result.data).not.toContainEqual(expect.objectContaining({ key: "Daily usage" }));
  expect(closed).toBe(1);
});

it("prints unavailable instead of a zero balance and closes the connection", async () => {
  let closed = false;
  const result = await inspectScheduleQuota({
    providerId: "secondary",
    client: {
      readProviderQuotaObservation: async (providerId) => ({
        requestId: "r",
        providerId,
        observation: { status: "unavailable", reason: "authentication_required" },
      }),
      close: async () => {
        closed = true;
      },
    },
  });
  expect(result.data).toEqual([
    { key: "Account selection", value: "secondary" },
    { key: "Quota", value: "Unavailable" },
    { key: "Reason", value: "authentication required" },
  ]);
  expect(closed).toBe(true);
});

it("preserves a host upgrade failure and closes the connection", async () => {
  let closed = false;
  await expect(
    inspectScheduleQuota({
      providerId: "secondary",
      client: {
        readProviderQuotaObservation: async () => {
          throw new Error("Update the host to inspect account quota for schedules.");
        },
        close: async () => {
          closed = true;
        },
      },
    }),
  ).rejects.toMatchObject({
    code: "SCHEDULE_QUOTA_FAILED",
    message: expect.stringContaining("Update the host"),
  });
  expect(closed).toBe(true);
});
