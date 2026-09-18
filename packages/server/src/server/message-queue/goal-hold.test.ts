import { describe, expect, it } from "vitest";
import type { AgentGoal, AgentGoalState } from "@getpaseo/protocol/agent-goals";
import {
  pauseGoalForQueue,
  projectQueueGoalState,
  resumeGoalAfterQueue,
  setGoalWithQueueOwnership,
  type QueueGoalHold,
  type QueueGoalPort,
} from "./goal-hold.js";

function fixture(status: AgentGoal["status"] = "active") {
  let goal: AgentGoal = {
    threadId: "thread",
    objective: "Finish the work",
    status,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  let hold: QueueGoalHold | undefined;
  let allowed = true;
  const calls: string[] = [];
  const state = (): AgentGoalState => ({
    status: "ready",
    goal,
    observedAt: new Date(0).toISOString(),
  });
  const port: QueueGoalPort = {
    hold: () => hold,
    persist: async (value) => {
      hold = value && structuredClone(value);
    },
    read: async () => state(),
    set: async (next) => {
      calls.push(next);
      goal = { ...goal, status: next, updatedAt: goal.updatedAt + 1 };
      return state();
    },
    mayResume: async () => allowed,
    mayRemainActive: async () => allowed,
    canPause: () => allowed,
  };
  return {
    port,
    calls,
    stop: () => {
      allowed = false;
    },
    edit: () => {
      goal = { ...goal, objective: "Changed objective", updatedAt: goal.updatedAt + 1 };
    },
  };
}

describe("queue goal ownership", () => {
  it("keeps Play enabled while messages drain without resuming native continuation early", async () => {
    const { port, calls } = fixture();
    await pauseGoalForQueue(port);
    const set = async () => port.set("active");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await setGoalWithQueueOwnership({ status: "active" }, port, set)).toMatchObject({
        goal: { status: "paused" },
        queueContinuationHeld: true,
      });
    }
    expect(calls).toEqual(["paused"]);
    await resumeGoalAfterQueue(port);
    expect(calls).toEqual(["paused", "active"]);
    expect(port.hold()).toBeUndefined();
  });
  it("honors an explicit Pause while the queue owns continuation", async () => {
    const { port, calls } = fixture();
    await pauseGoalForQueue(port);
    await setGoalWithQueueOwnership({ status: "paused" }, port, () => port.set("paused"));
    await resumeGoalAfterQueue(port);
    expect(port.hold()).toBeUndefined();
    expect(calls).toEqual(["paused", "paused"]);
  });
  it("requires provider confirmation when Play resolves an ambiguous queue hold", async () => {
    const { port, calls } = fixture();
    await pauseGoalForQueue(port);
    await port.persist({ ...port.hold()!, phase: "pausing" });
    await setGoalWithQueueOwnership({ status: "active" }, port, () => port.set("active"));
    expect(calls).toEqual(["paused", "active"]);
    expect(port.hold()).toBeUndefined();
  });
  it("resumes only its own unchanged paused goal", async () => {
    const { port, calls } = fixture();
    await pauseGoalForQueue(port);
    expect(port.hold()?.phase).toBe("held");
    await resumeGoalAfterQueue(port);
    expect(calls).toEqual(["paused", "active"]);
    expect(port.hold()).toBeUndefined();
  });
  it("does not adopt an already paused goal", async () => {
    const { port, calls } = fixture("paused");
    await pauseGoalForQueue(port);
    await resumeGoalAfterQueue(port);
    expect(calls).toEqual([]);
  });
  it("leaves a changed objective alone", async () => {
    const { port, calls, edit } = fixture();
    await pauseGoalForQueue(port);
    edit();
    await resumeGoalAfterQueue(port);
    expect(calls).toEqual(["paused"]);
    expect(port.hold()).toBeUndefined();
  });
  it.each(["pausing", "resuming"] as const)("does not retry ambiguous %s RPCs", async (phase) => {
    const { port, calls } = fixture();
    await pauseGoalForQueue(port);
    await port.persist({ ...port.hold()!, phase });
    await resumeGoalAfterQueue(port);
    expect(calls).toEqual(["paused"]);
    expect(port.hold()?.phase).toBe(phase);
  });
  it("pauses again when stopped during resume", async () => {
    const { port, calls, stop } = fixture();
    await pauseGoalForQueue(port);
    const set = port.set;
    port.set = async (status) => {
      const result = await set(status);
      if (status === "active") stop();
      return result;
    };
    await resumeGoalAfterQueue(port);
    expect(calls).toEqual(["paused", "active", "paused"]);
    expect(port.hold()).toBeUndefined();
  });
  it("retains ambiguous resume intent instead of declaring completion", async () => {
    const { port } = fixture();
    await pauseGoalForQueue(port);
    const set = port.set;
    port.set = async (status) => {
      const result = await set(status);
      return { status: "error", goal: result.goal, message: "Confirmation lost" };
    };
    await expect(resumeGoalAfterQueue(port)).rejects.toThrow("resume could not be confirmed");
    expect(port.hold()?.phase).toBe("resuming");
    // A recovered process must not blindly repeat this native RPC.
    await expect(resumeGoalAfterQueue(port)).resolves.toBeUndefined();
  });
  it("retains recovery intent when the compensating stop is unconfirmed", async () => {
    const { port, stop } = fixture();
    await pauseGoalForQueue(port);
    const set = port.set;
    port.set = async (status) => {
      const result = await set(status);
      if (status === "active") {
        stop();
        return result;
      }
      return { status: "error", goal: result.goal, message: "Confirmation lost" };
    };
    await expect(resumeGoalAfterQueue(port)).rejects.toThrow("stop could not be confirmed");
    expect(port.hold()?.phase).toBe("resuming");
  });
  it("releases ownership when stopped during pause", async () => {
    const { port, calls, stop } = fixture();
    const set = port.set;
    port.set = async (status) => {
      const result = await set(status);
      stop();
      return result;
    };
    await pauseGoalForQueue(port);
    await resumeGoalAfterQueue(port);
    expect(calls).toEqual(["paused"]);
    expect(port.hold()).toBeUndefined();
  });
});

it("projects queue-owned continuation and clears it after drain or explicit pause", async () => {
  const { port } = fixture();
  await pauseGoalForQueue(port);
  const held = projectQueueGoalState(await port.read(), port.hold());
  expect(held).toMatchObject({ goal: { status: "paused" }, queueContinuationHeld: true });
  await resumeGoalAfterQueue(port);
  expect(projectQueueGoalState(await port.read(), port.hold())).toMatchObject({
    goal: { status: "active" },
    queueContinuationHeld: false,
  });
  await pauseGoalForQueue(port);
  await port.persist(undefined); // Explicit user pause abandons queue ownership.
  await port.set("paused");
  await resumeGoalAfterQueue(port);
  expect(projectQueueGoalState(await port.read(), port.hold())).toMatchObject({
    goal: { status: "paused" },
    queueContinuationHeld: false,
  });
});
it("does not present stale or ambiguous ownership as enabled continuation", async () => {
  const { port, edit } = fixture();
  await pauseGoalForQueue(port);
  const held = port.hold()!;
  for (const phase of ["pausing", "resuming"] as const) {
    expect(projectQueueGoalState(await port.read(), { ...held, phase })).toMatchObject({
      queueContinuationHeld: false,
    });
  }
  edit();
  expect(projectQueueGoalState(await port.read(), held)).toMatchObject({
    queueContinuationHeld: false,
  });
});
