import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import { suggestPreset } from "./recommendation";

const now = Date.parse("2026-09-09T00:00:00Z");
const presets = [
  { id: "one", provider: "one" },
  { id: "two", provider: "two" },
];
function usage(providerId: string, remainingPct: number | null): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: null,
    fetchedAt: new Date(now).toISOString(),
    windows: [{ id: "weekly", label: "Weekly", remainingPct }],
  };
}
describe("preset suggestions", () => {
  it("suggests fresh spare capacity on a different provider without launching anything", () => {
    expect(suggestPreset(presets, "one", [usage("one", 99), usage("two", 25)], now)).toEqual(
      presets[1],
    );
  });
  it("does not turn unknown, exhausted, or stale quota into spare capacity", () => {
    expect(suggestPreset(presets, "one", [usage("two", null)], now)).toBeUndefined();
    expect(suggestPreset(presets, "one", [usage("two", 0)], now)).toBeUndefined();
    expect(suggestPreset(presets, "one", [usage("two", 50)], now + 360_000)).toBeUndefined();
  });
  it("uses the limiting window rather than the most generous one", () => {
    const account = usage("two", 90);
    account.windows.push({ id: "session", label: "Session", remainingPct: 0 });
    expect(suggestPreset(presets, "one", [account], now)).toBeUndefined();
  });
});
