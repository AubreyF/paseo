import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { ProviderUsageView } from "@/provider-usage/types";
import { remainingRingValue } from "@/provider-usage/remaining-ring-value";
import { presetNickname } from "./nickname";

interface SelectionInput {
  selectedProfileId?: string;
  selectedProfileName?: string;
  currentProvider?: string;
  selected?: { name: string; provider: string };
  definitions: AgentProfile[] | null;
  vortonMode: boolean;
  compactName?: boolean;
  view: ProviderUsageView;
  now: number;
}
export function selectedPresetPresentation(input: SelectionInput) {
  const fullName = input.selectedProfileName ?? input.selected?.name ?? "Select configuration";
  const definition = input.definitions?.find((row) => row.id === input.selectedProfileId);
  const triggerLabel =
    input.vortonMode && input.compactName !== false && input.selectedProfileId
      ? presetNickname({ name: fullName, nickname: definition?.nickname })
      : fullName;
  const providerId = input.currentProvider ?? input.selected?.provider;
  const usage =
    input.view.kind === "ready"
      ? input.view.payload.providers.find((entry) => entry.providerId === providerId)
      : undefined;
  const showRing =
    input.vortonMode &&
    Boolean(input.selectedProfileId) &&
    Boolean(usage?.windows.some((window) => window.id !== "code_review"));
  const remaining =
    input.view.kind === "ready"
      ? remainingRingValue(usage, input.view.payload.fetchedAt, input.now)
      : null;
  let accessibilityLabel = `Profile (${fullName}, ${triggerLabel})`;
  if (showRing)
    accessibilityLabel +=
      remaining === null ? ", usage unavailable" : `, ${Math.round(remaining)} percent remaining`;
  return { triggerLabel, showRing, remaining, accessibilityLabel };
}
