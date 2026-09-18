import { describe, expect, it } from "vitest";
import { openGoalForm } from "./goal-form-model";

const goal = {
  threadId: "thread",
  objective: "Finish migration",
  status: "paused" as const,
  tokenBudget: 1000,
  tokensUsed: 20,
  timeUsedSeconds: 2,
  createdAt: 1,
  updatedAt: 2,
};

describe("goal editor", () => {
  it("updates a budget without replacing the goal or resuming it", () => {
    const form = openGoalForm({ goal, draft: "unrelated draft" });
    form.setBudget("2000");
    expect(form.getState().input).toEqual({ tokenBudget: 2000 });
    form.setBudget("");
    expect(form.getState().input).toEqual({ tokenBudget: null });
  });

  it("makes objective replacement explicit", () => {
    const form = openGoalForm({ goal, draft: "" });
    form.setObjective("Finish the new task");
    expect(form.getState()).toMatchObject({
      replacesGoal: true,
      input: { objective: "Finish the new task", status: "active", tokenBudget: 1000 },
    });
  });

  it.each(["-1", "0", "NaN", "1.5", "9007199254740992"])("rejects invalid budget %s", (budget) => {
    const form = openGoalForm({ goal: null, draft: "Work" });
    form.setBudget(budget);
    expect(form.getState().input).toBeNull();
  });

  it("does not leak an editor draft into the next opening", () => {
    const first = openGoalForm({ goal, draft: "" });
    first.setObjective("Unsaved");
    first.close();
    const second = openGoalForm({ goal: null, draft: "New goal" });
    expect(second.getState().objective).toBe("New goal");
    expect(second.getState().budget).toBe("");
  });
});
