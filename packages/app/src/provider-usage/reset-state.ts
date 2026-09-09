import type { ProviderResetView } from "@getpaseo/protocol/provider-reset";

export function resetCountLabel(count: number): string {
  return `${count} ${count === 1 ? "reset" : "resets"}`;
}

export function currentResetPreparation(
  prepared: ProviderResetView | null,
  current: ProviderResetView | undefined,
): ProviderResetView | null {
  if (prepared?.snapshot.status !== "available" || current?.snapshot.status !== "available") {
    return null;
  }
  return prepared.providerId === current.providerId &&
    prepared.snapshot.accountId === current.snapshot.accountId
    ? prepared
    : null;
}

export function resetPresentation(input: {
  supported: boolean;
  connected: boolean;
  open: boolean;
  current?: ProviderResetView;
  displayed?: ProviderResetView;
}) {
  const snapshot = input.current?.snapshot;
  const available = input.displayed?.snapshot;
  const pending = input.displayed?.operation?.state === "pending";
  return {
    visible:
      input.supported && Boolean(snapshot || input.open) && snapshot?.status !== "unsupported",
    badge:
      snapshot?.status === "available"
        ? resetCountLabel(snapshot.availableCount)
        : "Resets unavailable",
    pending,
    enabled:
      input.connected &&
      input.displayed?.canRedeem === true &&
      available?.status === "available" &&
      (available.availableCount > 0 || pending),
  };
}
