import { formatAmount, formatPct, formatResetLabel } from "./format";
import type { ProviderUsage } from "./types";

/** Keep the model picker useful at a glance without recreating the full usage card. */
export function formatProviderUsageSummary(usage: ProviderUsage | undefined): string | null {
  if (!usage || usage.status !== "available") return null;

  const limitingWindow = usage.windows
    .filter(
      (window): window is typeof window & { remainingPct: number } =>
        typeof window.remainingPct === "number" && Number.isFinite(window.remainingPct),
    )
    .sort((left, right) => left.remainingPct - right.remainingPct)[0];

  if (limitingWindow) {
    const reset = formatResetLabel(limitingWindow.resetsAt);
    return [`${formatPct(limitingWindow.remainingPct)} left`, reset].filter(Boolean).join(" · ");
  }

  const balance = usage.balances?.find(
    (candidate) => typeof candidate.remaining === "number" && Number.isFinite(candidate.remaining),
  );
  if (!balance || balance.remaining === undefined || balance.remaining === null) return null;
  return `${formatAmount(balance.remaining, balance.unit)} ${balance.label.toLowerCase()} left`;
}
