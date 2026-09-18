import { z } from "zod";
import {
  AgentGoalSchema,
  type AgentGoal,
  type AgentGoalState,
} from "@getpaseo/protocol/agent-goals";

export const QueueGoalHoldSchema = z.object({
  phase: z.enum(["pausing", "held", "resuming"]),
  goal: AgentGoalSchema,
});
export type QueueGoalHold = z.infer<typeof QueueGoalHoldSchema>;

export interface QueueGoalPort {
  hold(): QueueGoalHold | undefined;
  persist(hold: QueueGoalHold | undefined): Promise<void>;
  read(): Promise<AgentGoalState>;
  set(status: "paused" | "active"): Promise<AgentGoalState>;
  mayResume(): Promise<boolean>;
  mayRemainActive(): Promise<boolean>;
  canPause(): boolean;
}

function sameGoal(left: AgentGoal, right: AgentGoal): boolean {
  return (
    left.threadId === right.threadId &&
    left.createdAt === right.createdAt &&
    left.objective === right.objective &&
    left.tokenBudget === right.tokenBudget
  );
}

/** Caller serializes this with explicit goal edits. Persist intent first so a
 * crash in the provider RPC leaves a reviewable pause, never a guessed resume. */
export async function pauseGoalForQueue(port: QueueGoalPort): Promise<void> {
  if (!port.canPause()) return;
  const state = await port.read();
  if (state.status !== "ready")
    throw new Error("The goal state must be confirmed before queue delivery.");
  if (!state.goal || state.goal.status !== "active") return;
  const original = state.goal;
  if (!port.canPause()) return;
  await port.persist({ phase: "pausing", goal: original });
  const paused = await port.set("paused");
  if (!port.canPause() || port.hold()?.phase !== "pausing") {
    await port.persist(undefined);
    return;
  }
  if (
    paused.status !== "ready" ||
    !paused.goal ||
    paused.goal.status !== "paused" ||
    !sameGoal(original, paused.goal)
  )
    throw new Error("The goal pause could not be confirmed. Review the goal before continuing.");
  await port.persist({ phase: "held", goal: paused.goal });
}

export async function resumeGoalAfterQueue(port: QueueGoalPort): Promise<void> {
  const hold = port.hold();
  if (!hold || hold.phase !== "held" || !(await port.mayResume())) return;
  const current = await port.read();
  if (current.status !== "ready") return;
  const goal = current.goal;
  if (
    !goal ||
    goal.status !== "paused" ||
    !sameGoal(hold.goal, goal) ||
    goal.updatedAt !== hold.goal.updatedAt
  ) {
    // A new objective, explicit pause or provider-side change owns its state.
    await port.persist(undefined);
    return;
  }
  if (!(await port.mayResume())) return;
  await port.persist({ ...hold, phase: "resuming" });
  if (!(await port.mayResume())) {
    await port.persist(hold);
    return;
  }
  const resumed = await port.set("active");
  if (
    resumed.status !== "ready" ||
    !resumed.goal ||
    !sameGoal(hold.goal, resumed.goal) ||
    resumed.goal.status !== "active"
  )
    throw new Error("The goal resume could not be confirmed. Review the goal before continuing.");
  // A stop received during the provider RPC must also stop goal continuation.
  if (!(await port.mayRemainActive())) {
    const paused = await port.set("paused");
    if (
      paused.status !== "ready" ||
      !paused.goal ||
      !sameGoal(hold.goal, paused.goal) ||
      paused.goal.status !== "paused"
    )
      throw new Error("The goal stop could not be confirmed. Review the goal before continuing.");
  }
  await port.persist(undefined);
}
