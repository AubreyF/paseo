import { expect, test } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ProviderResetResult, ProviderResetView } from "@getpaseo/protocol/provider-reset";
import { prepareResetForView, reconcileResetResult, resetResultNotice } from "./reset-result";

test("late preparation cannot republish an account cleared by configuration change", async () => {
  const cache = new QueryClient();
  const key = ["providerReset", "host", "primary"];
  const view: ProviderResetView = {
    providerId: "primary",
    fetchedAt: "2026-09-09T06:00:00Z",
    canRedeem: true,
    operation: null,
    snapshot: {
      status: "available",
      accountId: "first",
      accountLabel: null,
      availableCount: 2,
      credits: null,
    },
  };
  cache.setQueryData(key, view);
  const observed = cache.getQueryData<ProviderResetView>(key);
  if (!observed) throw new Error("Missing read");
  let complete: (result: { view: ProviderResetView }) => void = () => {
    throw new Error("Not started");
  };
  const delayed = new Promise<{ view: ProviderResetView }>((resolve) => {
    complete = resolve;
  });
  const preparing = prepareResetForView(
    observed,
    () => cache.getQueryData(key),
    () => delayed,
  );
  await cache.resetQueries({ queryKey: ["providerReset", "host"] });
  complete({ view });
  expect(await preparing).toBeNull();
  expect(cache.getQueryData(key)).toBeUndefined();
  cache.setQueryData(key, view);
  const current = cache.getQueryData<ProviderResetView>(key);
  if (!current) throw new Error("Missing refreshed read");
  expect(
    await prepareResetForView(
      current,
      () => cache.getQueryData(key),
      async () => ({ view }),
    ),
  ).toBe(view);
  cache.clear();
});

test.each<ProviderResetResult["outcome"]>([
  "reset",
  "alreadyRedeemed",
  "noCredit",
  "nothingToReset",
])("retains known %s outcome when display refresh fails", async (outcome) => {
  const result: ProviderResetResult = { outcome, view: null, refreshError: null };
  let otherRefreshes = 0;
  const notice = await reconcileResetResult(result, [
    async () => {
      throw new Error("Disconnected");
    },
    async () => {
      otherRefreshes += 1;
    },
  ]);
  expect(notice).toContain(resetResultNotice(result));
  expect(notice).toContain("Display refresh failed");
  expect(notice).not.toContain("could not be verified");
  expect(otherRefreshes).toBe(1);
});

test("successful display refresh preserves a provider refresh warning", async () => {
  const result: ProviderResetResult = {
    outcome: "reset",
    view: null,
    refreshError: "Provider account refresh unavailable.",
  };
  expect(await reconcileResetResult(result, [async () => undefined])).toBe(
    "Reset applied. No task was resumed. Provider account refresh unavailable.",
  );
});

test("a synchronous refresh failure cannot turn confirmed success into uncertainty", async () => {
  const result: ProviderResetResult = { outcome: "reset", view: null, refreshError: null };
  expect(
    await reconcileResetResult(result, [
      () => {
        throw new Error("Cache disposed");
      },
    ]),
  ).toContain("Reset applied. No task was resumed. Display refresh failed.");
});
