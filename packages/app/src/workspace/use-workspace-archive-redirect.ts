import { useEffect, useRef } from "react";
import { useRouter } from "expo-router";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";

interface WorkspaceArchiveRedirectInput {
  serverId: string;
  workspaceId: string;
  workspace: WorkspaceDescriptor | null;
  isRouteFocused: boolean;
  isConnected: boolean;
  hasHydratedWorkspaces: boolean;
}

export function useWorkspaceArchiveRedirect(input: WorkspaceArchiveRedirectInput): void {
  const router = useRouter();
  const previous = useRef<{ serverId: string; workspace: WorkspaceDescriptor } | null>(null);
  const { serverId, workspaceId, workspace, isRouteFocused, isConnected, hasHydratedWorkspaces } =
    input;

  useEffect(() => {
    if (workspace) {
      previous.current = { serverId, workspace };
      return;
    }
    const last = previous.current;
    const removedWhileOpen = last?.serverId === serverId && last.workspace.id === workspaceId;
    const canRedirect = isRouteFocused && isConnected && hasHydratedWorkspaces;
    if (!removedWhileOpen || !canRedirect) return;

    previous.current = null;
    // Agent and CLI archives arrive through the replica, without a UI archive callback.
    router.replace(
      buildWorkspaceArchiveRedirectRoute({
        serverId,
        archivedWorkspaceId: workspaceId,
        workspaces: [last.workspace],
      }),
    );
  }, [
    serverId,
    workspaceId,
    workspace,
    isRouteFocused,
    isConnected,
    hasHydratedWorkspaces,
    router,
  ]);
}
