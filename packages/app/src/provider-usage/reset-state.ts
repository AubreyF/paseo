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

function hasResetCredits(snapshot: ProviderResetView["snapshot"] | undefined): boolean {
  return snapshot?.status === "available" && snapshot.availableCount > 0;
}

export function resetPresentation(input: {
  supported: boolean;
  connected: boolean;
  open: boolean;
  current?: ProviderResetView;
  displayed?: ProviderResetView;
  readFailed?: boolean;
  positiveOnly?: boolean;
}) {
  const snapshot = input.current?.snapshot;
  const available = input.displayed?.snapshot;
  const pending = input.displayed?.operation?.state === "pending";
  return {
    showBadge: !input.positiveOnly || hasResetCredits(snapshot),
    visible:
      input.supported &&
      Boolean(snapshot || input.open || input.readFailed) &&
      snapshot?.status !== "unsupported",
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

export function selectableResetCredits(view: ProviderResetView | undefined, now = Date.now()) {
  if (view?.snapshot.status !== "available" || !view.canSelectCredit) return [];
  return (view.snapshot.credits ?? [])
    .filter(
      (credit) =>
        credit.status === "available" &&
        (credit.expiresAt === null || credit.expiresAt * 1000 > now),
    )
    .sort(
      (a, b) =>
        (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) ||
        a.grantedAt - b.grantedAt ||
        a.id.localeCompare(b.id),
    );
}
