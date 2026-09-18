import { expect, it } from "vitest";
import type { AgentGoal, AgentGoalSetInput, AgentGoalState } from "@getpaseo/protocol/agent-goals";
import { setAgentGoalWithContext } from "./agent-goal.js";

function fixture() {
  let goal: AgentGoal | null = {
    threadId: "thread",
    objective: "Work",
    status: "paused",
    tokenBudget: 1000,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const writes: AgentGoalSetInput[] = [];
  const state = (): AgentGoalState => ({
    status: "ready",
    goal,
    observedAt: new Date().toISOString(),
  });
  const manager = {
    readAgentGoal: async () => state(),
    setAgentGoal: async (_id: string, input: AgentGoalSetInput) => {
      writes.push(input);
      if (goal) goal = { ...goal, ...input };
      return state();
    },
  };
  return {
    manager,
    writes,
    state,
    change: (next: AgentGoal | null) => {
      goal = next;
    },
  };
}

it("delivers context while paused before enabling native continuation", async () => {
  const f = fixture();
  await setAgentGoalWithContext({
    manager: f.manager,
    agentId: "agent",
    goal: { objective: "Work" },
    sendContext: async () => {
      expect(f.state().goal?.status).toBe("paused");
    },
  });
  expect(f.writes).toEqual([{ objective: "Work", status: "paused" }, { status: "active" }]);
});

it("does not reactivate a goal completed during the context turn", async () => {
  const f = fixture();
  const result = await setAgentGoalWithContext({
    manager: f.manager,
    agentId: "agent",
    goal: { objective: "Work" },
    sendContext: async () => {
      f.change({ ...f.state().goal!, status: "complete" });
    },
  });
  expect(result.goal?.status).toBe("complete");
  expect(f.writes).toHaveLength(1);
});

it("does not resume a replacement or cleared goal", async () => {
  const f = fixture();
  await expect(
    setAgentGoalWithContext({
      manager: f.manager,
      agentId: "agent",
      goal: { objective: "Work" },
      sendContext: async () => {
        f.change(null);
      },
    }),
  ).rejects.toThrow("goal changed");
  expect(f.writes).toHaveLength(1);
});

it("leaves continuation paused if context delivery fails", async () => {
  const f = fixture();
  await expect(
    setAgentGoalWithContext({
      manager: f.manager,
      agentId: "agent",
      goal: { objective: "Work" },
      sendContext: async () => {
        throw new Error("attachment rejected");
      },
    }),
  ).rejects.toThrow("attachment rejected");
  expect(f.state().goal?.status).toBe("paused");
});
