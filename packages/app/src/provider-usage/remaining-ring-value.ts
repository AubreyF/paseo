import type { ProviderUsage } from "./types";

export function remainingRingValue(
  usage: ProviderUsage | undefined,
  fetchedAt: string,
  now: number,
): number | null {
  if (!usage || usage.status !== "available") return null;
  const age = now - Date.parse(usage.fetchedAt ?? fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age > 5 * 60 * 1000) return null;
  const windows = usage.windows.filter((window) => window.id !== "code_review");
  if (windows.length === 0) return null;
  const values = windows.map((window) => window.remainingPct);
  if (
    values.some(
      (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100,
    )
  )
    return null;
  return Math.min(...values.filter((value): value is number => typeof value === "number"));
}
