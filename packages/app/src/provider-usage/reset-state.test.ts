import { expect, test } from "vitest";
import type { ProviderResetView } from "@getpaseo/protocol/provider-reset";
import { currentResetPreparation, resetPresentation } from "./reset-state";

const view: ProviderResetView = {
  providerId: "primary",
  fetchedAt: "2026-09-09T00:00:00Z",
  canRedeem: true,
  operation: null,
  snapshot: {
    status: "available",
    accountId: "first",
    accountLabel: null,
    availableCount: 0,
    credits: null,
  },
};

test("prepared confirmation is hidden while account reads reset or change identity", () => {
  expect(currentResetPreparation(view, view)).toBe(view);
  expect(currentResetPreparation(view, undefined)).toBeNull();
  expect(currentResetPreparation(view, { ...view, providerId: "secondary" })).toBeNull();
  expect(
    currentResetPreparation(view, {
      ...view,
      snapshot: {
        status: "available",
        accountId: "second",
        accountLabel: null,
        availableCount: 2,
        credits: null,
      },
    }),
  ).toBeNull();
  expect(
    currentResetPreparation(view, {
      ...view,
      snapshot: { status: "unavailable", reason: "Account changed" },
    }),
  ).toBeNull();
});
test("zero is visible but cannot start a reset; a pending operation can be reconciled", () => {
  const input = { supported: true, connected: true, open: true, current: view, displayed: view };
  expect(resetPresentation(input)).toMatchObject({
    visible: true,
    badge: "0 resets",
    enabled: false,
  });
  const pending = {
    ...view,
    operation: {
      operationId: "00000000-0000-4000-8000-000000000001",
      state: "pending" as const,
      outcome: null,
    },
  };
  expect(resetPresentation({ ...input, displayed: pending }).enabled).toBe(true);
  expect(resetPresentation({ ...input, connected: false, displayed: pending }).enabled).toBe(false);
  expect(resetPresentation({ ...input, displayed: { ...pending, canRedeem: false } }).enabled).toBe(
    false,
  );
});
test("unknown is not zero and old daemons do not expose reset controls", () => {
  const unknown: ProviderResetView = {
    ...view,
    snapshot: { status: "unavailable", reason: "Unavailable" },
  };
  const input = {
    supported: true,
    connected: true,
    open: true,
    current: unknown,
    displayed: unknown,
  };
  expect(resetPresentation(input)).toMatchObject({ badge: "Resets unavailable", enabled: false });
  expect(resetPresentation({ ...input, supported: false }).visible).toBe(false);
});
