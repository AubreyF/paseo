import { z } from "zod";

export const GovernorExecutionSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    state: z.enum(["reserved", "starting", "running", "freezing", "frozen", "completed"]),
    executionId: z.string().min(1).nullable(),
    authenticationGeneration: z.string().min(1).nullable(),
    pauseReason: z.enum(["quota", "manual"]).nullable(),
    settlementId: z.string().min(1).nullable(),
  })
  .strict();
export type GovernorExecution = z.infer<typeof GovernorExecutionSchema>;

export type GovernorExecutionEvent =
  | { type: "start"; executionId: string; authenticationGeneration: string }
  | { type: "started"; executionId: string }
  | { type: "freeze"; reason: "quota" | "manual" }
  | { type: "settled"; executionId: string; settlementId: string }
  | { type: "resume"; executionId: string; authenticationGeneration: string; manual: boolean }
  | { type: "complete"; executionId: string; settlementId: string };

/** A settlement ID must come from trusted execution custody, never an interrupt ACK. */
export function advanceGovernorExecution(
  current: GovernorExecution,
  expectedGeneration: number,
  event: GovernorExecutionEvent,
): GovernorExecution {
  if (current.generation !== expectedGeneration)
    throw new Error("Stale quota execution generation.");
  let next: GovernorExecution;
  switch (event.type) {
    case "start":
      requireState(current, ["reserved"]);
      next = begin(current, event);
      break;
    case "started":
      requireState(current, ["starting"]);
      requireExecution(current, event.executionId);
      next = { ...current, state: "running" };
      break;
    case "freeze":
      requireState(current, ["starting", "running", "freezing", "frozen"]);
      next = {
        ...current,
        state: current.state === "frozen" ? "frozen" : "freezing",
        pauseReason: current.pauseReason === "manual" ? "manual" : event.reason,
      };
      break;
    case "settled":
      requireState(current, ["freezing"]);
      requireExecution(current, event.executionId);
      next = { ...current, state: "frozen", settlementId: event.settlementId };
      break;
    case "resume":
      requireState(current, ["frozen"]);
      if (!current.settlementId) throw new Error("Execution settlement is unconfirmed.");
      if (current.pauseReason === "manual" && !event.manual)
        throw new Error("Manual pause requires explicit resume.");
      if (current.authenticationGeneration !== event.authenticationGeneration)
        throw new Error("Authentication changed; reconciliation required.");
      if (current.executionId === event.executionId)
        throw new Error("Resume requires a new execution identity.");
      next = begin(current, event);
      break;
    case "complete":
      requireState(current, ["starting", "running", "freezing", "frozen"]);
      requireExecution(current, event.executionId);
      next = { ...current, state: "completed", settlementId: event.settlementId };
      break;
  }
  return GovernorExecutionSchema.parse({ ...next, generation: current.generation + 1 });
}

function begin(
  current: GovernorExecution,
  event: { executionId: string; authenticationGeneration: string },
): GovernorExecution {
  return {
    ...current,
    state: "starting",
    executionId: event.executionId,
    authenticationGeneration: event.authenticationGeneration,
    pauseReason: null,
    settlementId: null,
  };
}

function requireState(current: GovernorExecution, states: GovernorExecution["state"][]): void {
  if (!states.includes(current.state))
    throw new Error(`Quota execution cannot transition from ${current.state}.`);
}

function requireExecution(current: GovernorExecution, executionId: string): void {
  if (current.executionId !== executionId) throw new Error("Quota execution identity mismatch.");
}
