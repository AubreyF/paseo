import type { AgentGoal, AgentGoalSetInput } from "@getpaseo/protocol/agent-goals";

interface GoalFormSnapshot {
  goal: AgentGoal | null;
  draft: string;
}

interface GoalFormState {
  objective: string;
  budget: string;
  error: string | null;
  input: AgentGoalSetInput | null;
  replacesGoal: boolean;
}

export function openGoalForm(snapshot: GoalFormSnapshot) {
  const initialObjective = snapshot.goal?.objective ?? snapshot.draft;
  const initialBudget = snapshot.goal?.tokenBudget?.toString() ?? "";
  const listeners = new Set<() => void>();
  let state = derive(initialObjective, initialBudget);

  function derive(objective: string, budget: string): GoalFormState {
    const text = objective.trim();
    const budgetText = budget.trim();
    const tokens = budgetText ? Number(budgetText) : null;
    let error: string | null = null;
    if (!text) error = "Enter a goal objective.";
    else if (text.length > 4000) error = "Use at most 4,000 characters.";
    else if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0)) {
      error = "Enter a positive whole-number token budget, or leave it empty.";
    }
    const replacesGoal = snapshot.goal !== null && text !== snapshot.goal.objective;
    // Budget-only edits must not re-submit an objective or reactivate a paused goal.
    const objectiveChanged = snapshot.goal === null || replacesGoal;
    const input: AgentGoalSetInput = { tokenBudget: tokens };
    if (objectiveChanged) {
      input.objective = text;
      input.status = "active";
    }
    return { objective, budget, error, input: error ? null : input, replacesGoal };
  }

  function publish(objective: string, budget: string) {
    state = derive(objective, budget);
    for (const listener of listeners) listener();
  }

  return {
    initialObjective,
    initialBudget,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setObjective: (value: string) => publish(value, state.budget),
    setBudget: (value: string) => publish(state.objective, value),
    close: () => listeners.clear(),
  };
}

export function goalIdentity(goal: AgentGoal | null): string {
  if (!goal) return "none";
  return JSON.stringify([
    goal.threadId,
    goal.createdAt,
    goal.objective,
    goal.tokenBudget,
    goal.status,
  ]);
}
