import { useCallback, useMemo } from "react";
import { StyleSheet } from "react-native-unistyles";
import { HEADER_CONTROL_HEIGHT } from "@/components/ui/control-geometry";
import { useTranslation } from "react-i18next";
import { DiffStat } from "@/components/diff-stat";
import { Button } from "@/components/ui/button";
import { useVisibleWorkspaceDiffStat } from "@/composer/workspace-diff-stat";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSettings } from "@/hooks/use-settings";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { useVortonMode } from "@/vorton-mode";
import { useVortonTouch } from "@/vorton-touch";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openComposerChanges } from "@/workspace-tabs/open-supporting-view";

export function WorkspaceDiffCounter({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const vortonMode = useVortonMode();
  const touch = useVortonTouch();
  const isCompact = useIsCompactFormFactor();
  const diffStat = useVisibleWorkspaceDiffStat(serverId, workspaceId);
  const cwd = useWorkspaceFields(
    serverId,
    workspaceId,
    (workspace) => workspace.workspaceDirectory,
  );
  const preferences = useSettings((settings) => settings.openInSidePane);
  const handlePress = useCallback(() => {
    if (!cwd) return;
    openComposerChanges({
      isCompact,
      workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
      checkout: { serverId, cwd, isGit: true },
      preferences,
    });
  }, [cwd, isCompact, preferences, serverId, workspaceId]);
  const counter = useMemo(() => {
    if (!diffStat) return null;
    return <DiffStat additions={diffStat.additions} deletions={diffStat.deletions} />;
  }, [diffStat]);
  if (!vortonMode || !diffStat || !cwd) return null;

  return (
    <Button
      testID="workspace-diff-counter"
      variant="outline"
      size={touch ? "md" : "sm"}
      style={touch ? undefined : styles.toolbar}
      accessibilityLabel={t("workspace.git.diff.openChangesTab")}
      onPress={handlePress}
      trailing={counter}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  toolbar: {
    height: HEADER_CONTROL_HEIGHT,
    minHeight: HEADER_CONTROL_HEIGHT,
    paddingVertical: 0,
    borderRadius: theme.borderRadius.md,
  },
}));
