import type { QuotaReserveConfig, QuotaReserveState } from "@getpaseo/protocol/quota-reserve";
import { evaluateQuotaReserve, type QuotaReserveEvaluationInput } from "./evaluate.js";
import { QuotaReserveControlError } from "./admission.js";

export interface QuotaReserveTransitionInput {
  config: QuotaReserveConfig;
  trigger: "observation" | "resume" | "manual_stop" | "recovery_uncertain";
  observation: Omit<QuotaReserveEvaluationInput, "policy" | "recovering">;
  requireRecovery?: boolean;
  expectedRevision?: number;
}

function replaceState(config: QuotaReserveConfig, state: QuotaReserveState): QuotaReserveConfig {
  const previous = config.state;
  const sameKind = previous.kind === state.kind;
  const previousReason = "reason" in previous ? previous.reason : null;
  const nextReason = "reason" in state ? state.reason : null;
  if (sameKind && previousReason === nextReason) return config;
  return { ...config, state };
}

export function advanceQuotaReserve(input: QuotaReserveTransitionInput): QuotaReserveConfig {
  const { config, trigger, observation } = input;
  if (input.expectedRevision !== undefined && input.expectedRevision !== config.state.revision) {
    throw new QuotaReserveControlError(
      "conflict",
      "Reserve state changed. Refresh before trying again.",
    );
  }
  const next = {
    revision: config.state.revision + 1,
    changedAt: new Date(observation.nowMs).toISOString(),
  };
  if (trigger === "manual_stop") {
    // Each explicit Stop invalidates a resume already waiting on usage.
    return { ...config, state: { ...next, kind: "stopped", reason: "manual" } };
  }
  // Observations and restart reconciliation never release an explicit stop latch.
  if (config.state.kind === "stopped" && trigger !== "resume") return config;
  if (trigger === "recovery_uncertain") {
    return replaceState(config, { ...next, kind: "stopped", reason: "recovery_uncertain" });
  }
  const evaluation = evaluateQuotaReserve({
    ...observation,
    policy: config.policy,
    recovering: config.state.kind !== "ready" || input.requireRecovery === true,
  });
  const recovered = evaluation.kind === "ready" || evaluation.kind === "off";
  if (recovered) return replaceState(config, { ...next, kind: "ready" });
  if (config.state.kind === "stopped") return config;
  if (evaluation.kind === "redline") {
    return replaceState(config, { ...next, kind: "stopped", reason: "redline" });
  }
  const reason = evaluation.kind === "cruise" ? "cruise" : "usage_unavailable";
  return replaceState(config, { ...next, kind: "held", reason });
}
