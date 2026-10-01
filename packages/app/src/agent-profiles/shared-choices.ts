import type { AgentProfile, ProviderPreferences } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

export interface LaunchChoices {
  model?: string;
  thinkingOptionId?: string;
}

interface ChoiceOption {
  id: string;
  value: string;
  label: string;
  available: boolean;
}

function rankedOptions(options: Map<string, ChoiceOption>, preferred: readonly string[]) {
  const ranks = new Map(preferred.map((id, index) => [id, index]));
  return [...options.values()].sort(
    (left, right) =>
      (ranks.get(left.id) ?? preferred.length) - (ranks.get(right.id) ?? preferred.length),
  );
}

function catalogChoices(input: {
  model: string;
  entry: Pick<ProviderSnapshotEntry, "models"> | undefined;
  family: readonly Pick<ProviderSnapshotEntry, "models">[];
  preferences: ProviderPreferences | undefined;
}) {
  const models = input.entry?.models ?? [];
  const current = models.find(
    (candidate) => candidate.id === input.model && candidate.isSelectable !== false,
  );
  const familyModels = input.family.flatMap((entry) => entry.models ?? []);
  const modelOptions = new Map<string, ChoiceOption>();
  const thinkingOptions = new Map<string, ChoiceOption>();
  for (const model of familyModels) {
    if (model.isSelectable === false) continue;
    modelOptions.set(model.id, {
      id: model.id,
      value: model.id,
      label: model.label,
      available: models.some(
        (candidate) => candidate.id === model.id && candidate.isSelectable !== false,
      ),
    });
    if (model.id !== input.model) continue;
    for (const option of model.thinkingOptions ?? []) {
      thinkingOptions.set(option.id, {
        id: option.id,
        value: option.id,
        label: option.label,
        available: Boolean(
          current?.thinkingOptions?.some((candidate) => candidate.id === option.id),
        ),
      });
    }
  }
  return {
    modelOptions: rankedOptions(modelOptions, input.preferences?.preferredModels ?? []),
    thinkingOptions: [
      { id: "provider-default", value: "", label: "Provider default", available: true },
      ...rankedOptions(thinkingOptions, input.preferences?.preferredThinkingOptions ?? []),
    ],
  };
}

export function sharedChoiceState(input: {
  profile: AgentProfile;
  choices: LaunchChoices;
  entry: Pick<ProviderSnapshotEntry, "models"> | undefined;
  family?: readonly Pick<ProviderSnapshotEntry, "models">[];
  preferences?: ProviderPreferences;
}) {
  const model = input.choices.model ?? input.profile.model ?? "";
  const thinkingOptionId = input.choices.thinkingOptionId ?? input.profile.thinkingOptionId ?? "";
  const models = input.entry?.models ?? [];
  const selectedModel = models.find(
    (candidate) => candidate.id === model && candidate.isSelectable !== false,
  );
  const family = input.family ?? [input.entry ?? { models: [] }];
  const { modelOptions, thinkingOptions } = catalogChoices({
    model,
    entry: input.entry,
    family,
    preferences: input.preferences,
  });
  const unavailableModel = Boolean(model) && !selectedModel;
  const unavailableThinking =
    Boolean(thinkingOptionId) &&
    !thinkingOptions.some((option) => option.value === thinkingOptionId && option.available);
  return {
    choices: { model, thinkingOptionId },
    modelOptions,
    thinkingOptions,
    modelDisplay: { label: selectedModel?.label ?? model },
    thinkingDisplay: {
      label:
        thinkingOptions.find((option) => option.value === thinkingOptionId)?.label ??
        thinkingOptionId,
    },
    modelError: unavailableModel
      ? "This model is unavailable on this account. Select another model or account."
      : null,
    thinkingError: unavailableThinking
      ? "This reasoning level is unavailable on this account. Select another level or account."
      : null,
    unavailable: unavailableModel || unavailableThinking,
  };
}
