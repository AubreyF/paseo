import type { AgentProfile, SharedProviderPreferences } from "./messages.js";

export interface ProviderAncestry {
  extends?: string;
}

export function sharedWorkflowProfileId(provider: string, workflowId: string): string {
  return `shared-workflow/${encodeURIComponent(provider)}/${encodeURIComponent(workflowId)}`;
}

export function isSharedWorkflowProfile(id: string): boolean {
  return id.startsWith("shared-workflow/");
}

/** Account rows are views of shared workflows; they are never saved as account copies. */
export function materializeSharedProfiles(input: {
  preferences: SharedProviderPreferences;
  providers: Readonly<Record<string, ProviderAncestry>>;
  providerIds: readonly string[];
}): AgentProfile[] {
  const profiles: AgentProfile[] = [];
  for (const provider of input.providerIds) {
    const providerType = resolveProviderType(provider, input.providers);
    const group = input.preferences.providers[providerType];
    if (!group) continue;
    for (const workflow of group.workflows) {
      profiles.push({
        ...group.defaults,
        ...workflow,
        provider,
        id: sharedWorkflowProfileId(provider, workflow.id),
        isDefault:
          workflow.id === group.defaultWorkflowId &&
          (!input.preferences.defaultProvider || input.preferences.defaultProvider === provider),
        featureValues: { ...group.defaults.featureValues, ...workflow.featureValues },
      });
    }
  }
  return profiles;
}

export function materializeLegacyProfiles(preferences: SharedProviderPreferences): AgentProfile[] {
  const profiles: AgentProfile[] = [];
  for (const [id, binding] of Object.entries(preferences.legacyProfiles)) {
    const group = preferences.providers[binding.providerType];
    const workflow = group?.workflows.find((entry) => entry.id === binding.workflowId);
    if (!workflow) continue;
    profiles.push({
      ...group.defaults,
      ...workflow,
      id,
      provider: binding.provider,
      ...(binding.model !== undefined ? { model: binding.model ?? undefined } : {}),
      ...(binding.thinkingOptionId !== undefined
        ? { thinkingOptionId: binding.thinkingOptionId ?? undefined }
        : {}),
      ...(group.defaults.featureValues || workflow.featureValues
        ? { featureValues: { ...group.defaults.featureValues, ...workflow.featureValues } }
        : {}),
    });
  }
  return profiles;
}

export class ProviderAncestryError extends Error {
  constructor(readonly provider: string) {
    super(`Provider inheritance contains a cycle at ${provider}.`);
    this.name = "ProviderAncestryError";
  }
}

export function resolveProviderType(
  provider: string,
  providers: Readonly<Record<string, ProviderAncestry>>,
): string {
  const visited = new Set<string>();
  let current = provider;
  while (providers[current]?.extends) {
    if (visited.has(current)) throw new ProviderAncestryError(current);
    visited.add(current);
    const parent = providers[current].extends;
    if (!parent || parent === "acp") return current;
    current = parent;
  }
  return current;
}
