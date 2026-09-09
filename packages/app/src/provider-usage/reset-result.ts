import type {
  ProviderResetResult,
  ProviderResetOutcome,
  ProviderResetView,
} from "@getpaseo/protocol/provider-reset";

/** A reset/configuration refresh invalidates the read that authorized this review. */
export async function prepareResetForView(
  viewed: ProviderResetView,
  readCurrent: () => ProviderResetView | undefined,
  prepare: () => Promise<{ view: ProviderResetView }>,
): Promise<ProviderResetView | null> {
  const result = await prepare();
  return readCurrent() === viewed ? result.view : null;
}

const outcomeCopy: Record<ProviderResetOutcome, string> = {
  reset: "Reset applied. No task was resumed.",
  alreadyRedeemed: "This operation was already redeemed. No additional credit was spent.",
  noCredit: "The provider reports no available reset credit.",
  nothingToReset: "The provider reports nothing to reset. No reset was applied.",
};

export function resetResultNotice(result: ProviderResetResult): string {
  return [outcomeCopy[result.outcome], result.refreshError].filter(Boolean).join(" ");
}

/** Cache refresh is read-only reconciliation, never evidence that redemption failed. */
export async function reconcileResetResult(
  result: ProviderResetResult,
  refreshers: ReadonlyArray<() => Promise<unknown>>,
): Promise<string> {
  const refreshed = await Promise.allSettled(
    refreshers.map((refresh) => Promise.resolve().then(refresh)),
  );
  const notice = resetResultNotice(result);
  return refreshed.some((entry) => entry.status === "rejected")
    ? `${notice} Display refresh failed. Refresh account details to update the displayed balances.`
    : notice;
}
