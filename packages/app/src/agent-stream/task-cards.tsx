import { AgentHistoryTracks } from "@/panels/agent-tracks";
import { useCallback, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GoalBar } from "@/goals/goal-bar";
import { GoalDetails } from "@/goals/goal-details";
import { useAgentGoal } from "@/goals/use-agent-goal";
import { SharedQueueView } from "@/message-queue/queue-view";
import { useMessageQueue } from "@/message-queue/use-message-queue";
import { isQueueGoalError } from "@/message-queue/goal-error";
import { LegacyQueueImport } from "@/message-queue/legacy-import";

const ignoreCreatedDraft = () => {};

export function AgentTaskCards({
  serverId,
  agentId,
  workspaceId,
  cwd,
}: {
  serverId: string;
  agentId: string;
  workspaceId?: string;
  cwd: string;
}) {
  const queue = useMessageQueue(serverId, agentId);
  const goal = useAgentGoal(serverId, agentId);
  const [expanded, setExpanded] = useState(false);
  const open = useCallback(() => setExpanded(true), []);
  const close = useCallback(() => setExpanded(false), []);
  return (
    <View style={styles.cards} testID="agent-history-task-cards">
      {workspaceId ? (
        <AgentHistoryTracks
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          cwd={cwd}
        />
      ) : null}
      <SharedQueueView
        serverId={serverId}
        agentId={agentId}
        control={queue}
        goalErrorHandled={goal.supported}
      />
      <LegacyQueueImport serverId={serverId} agentId={agentId} cwd={cwd} />
      <GoalBar
        control={goal}
        onExpand={open}
        queueError={
          isQueueGoalError(queue.snapshot?.deliveryError)
            ? queue.snapshot?.deliveryError
            : undefined
        }
      />
      {expanded && goal.supported ? (
        <GoalDetails control={goal} draft="" onClose={close} onCreated={ignoreCreatedDraft} />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  cards: { gap: theme.spacing[2] },
}));
