import type { AgentGoalSetInput, AgentGoalState } from "@getpaseo/protocol/agent-goals";
import type { AgentManager } from "./agent-manager.js";

/** Native goal RPCs accept text only. Deliver attachments through the normal
 * prompt path while continuation is paused, then reconcile before activating. */
export async function setAgentGoalWithContext(input: {
  manager: Pick<AgentManager, "setAgentGoal" | "readAgentGoal">;
  agentId: string;
  goal: AgentGoalSetInput;
  clientMessageId?: string;
  sendContext?: () => Promise<void>;
}): Promise<AgentGoalState> {
  const { manager, agentId, goal, sendContext, clientMessageId } = input;
  if (!sendContext) return manager.setAgentGoal(agentId, goal, { clientMessageId });
  if (!goal.objective?.trim()) throw new Error("Goal attachments require an objective");
  const accepted = await manager.setAgentGoal(
    agentId,
    { ...goal, status: "paused" },
    { recordSubmission: false },
  );
  await sendContext();
  const current = await manager.readAgentGoal(agentId);
  if (
    !current.goal ||
    current.goal.objective !== accepted.goal?.objective ||
    current.goal.createdAt !== accepted.goal.createdAt
  ) {
    throw new Error(
      "The goal changed while its context was being sent. Review the current goal before continuing.",
    );
  }
  // A quick turn may already have completed or blocked the goal. Do not resume
  // it merely because the attachment submission has now been acknowledged.
  if (current.goal.status !== "paused") return current;
  return manager.setAgentGoal(agentId, { status: goal.status ?? "active" });
}
