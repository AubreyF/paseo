import { CountBadge } from "@/components/ui/count-badge";
import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import { useSessionStore } from "@/stores/session-store";
import { isGoalContinuationEnabled } from "./goal-presentation";

export function WorkspaceGoalBadge({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const pending = usePendingArchiveAgentIds(serverId);
  const active = useSessionStore((state) =>
    [...(state.sessions[serverId]?.agents.values() ?? [])].some(
      (agent) =>
        agent.workspaceId === workspaceId &&
        !agent.archivedAt &&
        !pending.has(agent.id) &&
        agent.goalState?.status === "ready" &&
        !!agent.goalState.goal &&
        isGoalContinuationEnabled(agent.goalState),
    ),
  );
  return active ? (
    <CountBadge
      label="G"
      accessibilityLabel="Active goal"
      testID={`workspace-goal-badge-${serverId}-${workspaceId}`}
    />
  ) : null;
}
