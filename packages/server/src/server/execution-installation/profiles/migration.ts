import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentProfile,
  MutableDaemonConfig,
  ProviderPreferences,
  SharedProviderPreferences,
} from "@getpaseo/protocol/messages";
import { sharedWorkflowProfileId } from "@getpaseo/protocol/provider-preferences";

export interface ProfileImport {
  serverId: string;
  preferences: SharedProviderPreferences;
}

export interface ImportedProfiles {
  providers: Record<string, ProviderPreferences>;
  workflowIds: Record<string, Record<string, Record<string, string>>>;
}

/** Import each environment without collapsing different behavior or copying account bindings. */
export function importEnvironmentProfiles(sources: ProfileImport[]): ImportedProfiles {
  const result: ImportedProfiles = { providers: {}, workflowIds: {} };
  for (const source of sources) {
    const mappings: Record<string, Record<string, string>> = {};
    result.workflowIds[source.serverId] = mappings;
    for (const [type, group] of Object.entries(source.preferences.providers)) {
      const mapping: Record<string, string> = {};
      mappings[type] = mapping;
      const target = result.providers[type] ?? {
        ...structuredClone(group),
        workflows: [],
        defaultWorkflowId: null,
      };
      result.providers[type] = target;
      target.preferredModels = [...new Set([...target.preferredModels, ...group.preferredModels])];
      target.preferredThinkingOptions = [
        ...new Set([...target.preferredThinkingOptions, ...group.preferredThinkingOptions]),
      ];
      for (const workflow of group.workflows) {
        // Flatten inherited fields when importing distinct environment defaults.
        const effective = {
          ...group.defaults,
          ...workflow,
          featureValues: { ...group.defaults.featureValues, ...workflow.featureValues },
        };
        const { id: _id, ...behavior } = effective;
        const matching = effective.workerProfileId
          ? undefined
          : target.workflows.find((candidate) => {
              const { id: _candidateId, ...candidateBehavior } = {
                ...target.defaults,
                ...candidate,
                featureValues: { ...target.defaults.featureValues, ...candidate.featureValues },
              };
              return isDeepStrictEqual(candidateBehavior, behavior);
            });
        let id = matching?.id ?? workflow.id;
        if (!matching && target.workflows.some((entry) => entry.id === id)) {
          const suffix = createHash("sha256").update(source.serverId).digest("hex").slice(0, 12);
          id = `${workflow.id}-${suffix}`;
        }
        mapping[workflow.id] = id;
        if (!matching) {
          const imported = inheritProviderDefaults({ ...effective, id }, target.defaults);
          target.workflows.push(imported);
        }
        if (target.defaultWorkflowId === null && group.defaultWorkflowId === workflow.id)
          target.defaultWorkflowId = id;
      }
    }
  }
  remapImportedWorkers(sources, result);
  return result;
}

export function projectEnvironmentProfiles(input: {
  config: MutableDaemonConfig;
  providers: Record<string, ProviderPreferences>;
  workflowIds: Record<string, Record<string, string>>;
}): SharedProviderPreferences {
  const preferences = input.config.sharedProviderPreferences;
  if (!preferences) throw new Error("Update the daemon before sharing profiles");
  const legacyProfiles = structuredClone(preferences.legacyProfiles);
  for (const binding of Object.values(legacyProfiles)) {
    const mapped = input.workflowIds[binding.providerType]?.[binding.workflowId];
    if (mapped) binding.workflowId = mapped;
  }
  return { ...preferences, providers: structuredClone(input.providers), legacyProfiles };
}

function remapImportedWorkers(sources: ProfileImport[], result: ImportedProfiles): void {
  const defaultsMapped = new Set<string>();
  for (const source of sources) {
    for (const [type, group] of Object.entries(source.preferences.providers)) {
      const defaultsReference = group.defaults.workerProfileId;
      if (!defaultsMapped.has(type) && defaultsReference) {
        result.providers[type].defaults.workerProfileId = portableWorkerReference(
          defaultsReference,
          source,
          result,
        );
      }
      defaultsMapped.add(type);
      for (const workflow of group.workflows) {
        const reference = workflow.workerProfileId ?? defaultsReference;
        const id = result.workflowIds[source.serverId][type][workflow.id];
        const imported = result.providers[type].workflows.find((entry) => entry.id === id);
        if (!imported || !reference) continue;
        imported.workerProfileId = portableWorkerReference(reference, source, result);
      }
    }
  }
}

function portableWorkerReference(
  reference: string,
  source: ProfileImport,
  result: ImportedProfiles,
): string {
  const parts = reference.split("/");
  const binding = source.preferences.legacyProfiles[reference];
  let type: string;
  let workflowId: string;
  if (binding) {
    type = binding.providerType;
    workflowId = binding.workflowId;
  } else if (parts.length === 3 && parts[0] === "shared-workflow") {
    type = decodeURIComponent(parts[1]);
    workflowId = decodeURIComponent(parts[2]);
  } else {
    throw new Error(`Cannot share worker reference ${reference} without a portable binding`);
  }
  const mapped = result.workflowIds[source.serverId][type]?.[workflowId];
  if (!mapped) throw new Error(`Shared worker ${reference} does not exist`);
  return sharedWorkflowProfileId(type, mapped);
}

function inheritProviderDefaults(
  profile: AgentProfile,
  defaults: ProviderPreferences["defaults"],
): AgentProfile {
  const imported = { ...profile };
  for (const key of [
    "model",
    "thinkingOptionId",
    "modeId",
    "instructions",
    "workerProfileId",
    "maxWorkers",
    "featureValues",
    "quotaReservePolicy",
  ] as const) {
    if (isDeepStrictEqual(imported[key], defaults[key])) delete imported[key];
  }
  return imported;
}
