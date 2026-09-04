import { formatAmount, formatPct, formatResetLabel } from "./format";
import type { ProviderUsage } from "./types";

function limitingWindow(usage: ProviderUsage | undefined) {
  if (!usage || usage.status !== "available") return null;
  return (
    usage.windows
      .filter(
        (window): window is typeof window & { remainingPct: number } =>
          typeof window.remainingPct === "number" && Number.isFinite(window.remainingPct),
      )
      .sort((left, right) => left.remainingPct - right.remainingPct)[0] ?? null
  );
}

/** Keep the model picker useful at a glance without recreating the full usage card. */
export function formatProviderUsageSummary(usage: ProviderUsage | undefined): string | null {
  if (!usage || usage.status !== "available") return null;

  const window = limitingWindow(usage);

  if (window) {
    const reset = formatResetLabel(window.resetsAt);
    return [`${formatPct(window.remainingPct)} left`, reset].filter(Boolean).join(" · ");
  }

  const balance = usage.balances?.find(
    (candidate) => typeof candidate.remaining === "number" && Number.isFinite(candidate.remaining),
  );
  if (!balance || balance.remaining === undefined || balance.remaining === null) return null;
  return `${formatAmount(balance.remaining, balance.unit)} ${balance.label.toLowerCase()} left`;
}

/** A fixed-width version for the trailing edge of compact picker rows. */
export function formatProviderUsageCompactSummary(usage: ProviderUsage | undefined): string | null {
  if (!usage || usage.status !== "available") return null;

  const window = limitingWindow(usage);
  if (window) {
    const reset = formatResetLabel(window.resetsAt)?.replace(/^(?:resets |resetting )/, "");
    return [formatPct(window.remainingPct), reset].filter(Boolean).join(" · ");
  }

  const balance = usage.balances?.find(
    (candidate) => typeof candidate.remaining === "number" && Number.isFinite(candidate.remaining),
  );
  if (!balance || balance.remaining === undefined || balance.remaining === null) return null;
  return `${formatAmount(balance.remaining, balance.unit)} left`;
}
