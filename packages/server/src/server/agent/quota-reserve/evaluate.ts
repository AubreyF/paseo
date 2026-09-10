import type { ProviderUsageWindow } from "@getpaseo/protocol/messages";
import type { QuotaReservePolicy } from "@getpaseo/protocol/quota-reserve";

export interface QuotaReserveEvaluationInput {
  policy: QuotaReservePolicy;
  windows: readonly ProviderUsageWindow[];
  requiredWindowIds: readonly string[];
  observedAtMs: number | null;
  nowMs: number;
  maxAgeMs: number;
  recovering: boolean;
}

interface ReserveWindow {
  windowId: string;
  remainingPct: number;
}

interface ThresholdCrossing extends ReserveWindow {
  kind: "cruise" | "redline";
}

export type QuotaReserveEvaluation =
  | { kind: "off" }
  | { kind: "ready" }
  | { kind: "unavailable" }
  | ThresholdCrossing;

function readRemaining(windows: readonly ProviderUsageWindow[], id: string): number | null {
  const matches = windows.filter((window) => window.id === id);
  const remaining = matches[0]?.remainingPct;
  if (typeof remaining !== "number") return null;
  const invalid =
    matches.length !== 1 || !Number.isFinite(remaining) || remaining < 0 || remaining > 100;
  return invalid ? null : remaining;
}

export function evaluateQuotaReserve(input: QuotaReserveEvaluationInput): QuotaReserveEvaluation {
  const { policy, observedAtMs, requiredWindowIds } = input;
  if (policy.kind === "off") return { kind: "off" };
  if (observedAtMs === null) return { kind: "unavailable" };
  const ageMs = input.nowMs - observedAtMs;
  const stale =
    !Number.isFinite(ageMs) ||
    !Number.isFinite(input.maxAgeMs) ||
    input.maxAgeMs < 0 ||
    ageMs < 0 ||
    ageMs > input.maxAgeMs;
  if (stale || requiredWindowIds.length === 0) return { kind: "unavailable" };

  let incomplete = false;
  let lowest: ReserveWindow | null = null;
  for (const id of requiredWindowIds) {
    const remaining = readRemaining(input.windows, id);
    if (remaining === null) {
      incomplete = true;
      continue;
    }
    if (lowest === null || remaining < lowest.remainingPct) {
      lowest = { windowId: id, remainingPct: remaining };
    }
  }

  // A known Redline crossing still requires cancellation when another window is missing.
  if (lowest !== null && lowest.remainingPct <= policy.redlinePct) {
    return { kind: "redline", ...lowest };
  }
  if (incomplete || lowest === null) return { kind: "unavailable" };
  const belowCruise = lowest.remainingPct < policy.cruisePct;
  const heldAtCruise = input.recovering && lowest.remainingPct === policy.cruisePct;
  if (belowCruise || heldAtCruise) return { kind: "cruise", ...lowest };
  return { kind: "ready" };
}
