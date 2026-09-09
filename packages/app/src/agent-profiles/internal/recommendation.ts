import type { ProviderUsage } from "@getpaseo/protocol/messages";

/** A suggestion is advisory. Unknown, stale, and exhausted quotas never rank as spare capacity. */
export function suggestPreset<T extends { id: string; provider: string }>(
  presets: readonly T[],
  currentProvider: string | undefined,
  usage: readonly ProviderUsage[],
  now = Date.now(),
): T | undefined {
  let best: T | undefined;
  let bestRemaining = 0;
  for (const preset of presets) {
    if (preset.provider === currentProvider) continue;
    const account = usage.find((entry) => entry.providerId === preset.provider);
    if (account?.status !== "available" || !account.fetchedAt) continue;
    const age = now - Date.parse(account.fetchedAt);
    if (!Number.isFinite(age) || age < 0 || age > 5 * 60_000) continue;
    const windows = account.windows.map((window) => window.remainingPct);
    if (
      !windows.length ||
      windows.some((value) => typeof value !== "number" || !Number.isFinite(value))
    )
      continue;
    const knownWindows = windows.filter((value): value is number => typeof value === "number");
    const remaining = Math.min(...knownWindows);
    if (remaining > bestRemaining) {
      best = preset;
      bestRemaining = remaining;
    }
  }
  return best;
}
