import type { SubmitModifier } from "./submit-modifier";
import type { ComposerInputMode } from "@/composer/input-mode";

export function supportsSubmitModifiers(input: {
  vortonMode: boolean;
  isWeb: boolean;
  inputMode: ComposerInputMode;
  readOnly: boolean;
  isSubmitLoading: boolean;
}): boolean {
  return (
    input.vortonMode &&
    input.isWeb &&
    input.inputMode === "chat" &&
    !input.readOnly &&
    !input.isSubmitLoading
  );
}

export function resolveSubmitAction(input: {
  enabled: boolean;
  modifier: SubmitModifier;
  isCompact: boolean;
  isAgentRunning: boolean;
  canQueue: boolean;
  defaultActionQueues: boolean;
}) {
  if (!input.enabled) return { action: "default", queues: false } as const;
  if (input.modifier === "newline") return { action: "newline", queues: false } as const;
  const alternate =
    input.modifier === "alternate" && !input.isCompact && input.isAgentRunning && input.canQueue;
  if (alternate) return { action: "alternate", queues: !input.defaultActionQueues } as const;
  return { action: "default", queues: input.defaultActionQueues && input.canQueue } as const;
}
