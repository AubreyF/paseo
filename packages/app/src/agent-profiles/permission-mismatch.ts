import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

/** Missing runtime or catalog information is not evidence of a permission change. */
export function profilePermissionMismatch(
  profile: AgentProfile,
  currentModeId: string | null | undefined,
  entry: ProviderSnapshotEntry | undefined,
) {
  const expectedMode = profile.modeId?.trim() || entry?.defaultModeId;
  if (!currentModeId || !expectedMode || currentModeId === expectedMode) return null;
  return {
    current: entry?.modes?.find((mode) => mode.id === currentModeId)?.label ?? currentModeId,
    expected: entry?.modes?.find((mode) => mode.id === expectedMode)?.label ?? expectedMode,
  };
}
