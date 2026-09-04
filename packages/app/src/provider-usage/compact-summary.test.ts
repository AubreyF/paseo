import { afterEach, describe, expect, it, vi } from "vitest";
import { formatProviderUsageSummary } from "./compact-summary";
import type { ProviderUsage } from "./types";

function usage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    providerId: "secondary",
    displayName: "Secondary",
    status: "available",
    planLabel: "pro",
    windows: [],
    ...overrides,
  };
}

describe("formatProviderUsageSummary", () => {
  afterEach(() => vi.useRealTimers());

  it("shows the most constrained window and its reset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    expect(
      formatProviderUsageSummary(
        usage({
          windows: [
            { id: "session", label: "Session", remainingPct: 65 },
            {
              id: "weekly",
              label: "Weekly",
              remainingPct: 12,
              resetsAt: "2026-06-04T00:00:00.000Z",
            },
          ],
        }),
      ),
    ).toBe("12% left · resets 3d");
  });

  it("falls back to a remaining balance", () => {
    expect(
      formatProviderUsageSummary(
        usage({
          balances: [{ id: "credits", label: "Credits", remaining: 4.5, unit: "usd" }],
        }),
      ),
    ).toBe("$4.50 credits left");
  });

  it("omits unavailable usage", () => {
    expect(formatProviderUsageSummary(usage({ status: "unavailable" }))).toBeNull();
  });
});
