import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";

/** Metadata comes from provider discovery and may be absent or provider-specific. */
export function piModelFacts(model: AgentModelDefinition): string[] {
  const facts: string[] = [];
  const context = model.contextWindowMaxTokens;
  const output = model.metadata?.maxOutputTokens;
  const input = model.metadata?.inputModalities;
  if (typeof context === "number" && Number.isFinite(context) && context > 0) {
    facts.push(`${context.toLocaleString()} context`);
  }
  if (typeof output === "number" && Number.isFinite(output) && output > 0) {
    facts.push(`${output.toLocaleString()} max output`);
  }
  if (Array.isArray(input)) {
    if (input.includes("text")) facts.push("Text");
    if (input.includes("image")) facts.push("Images");
  }
  if (model.thinkingOptions?.length) facts.push("Reasoning");
  return facts;
}
