import type { ProfileSharingStatus } from "@getpaseo/protocol/execution-installation";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  ProviderPreferencesSchema,
  type MutableDaemonConfig,
  type MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";
import { importEnvironmentProfiles, projectEnvironmentProfiles } from "./migration.js";
import { mergeProfileEdits, ProfileSharingConflict } from "./merge.js";

const ProvidersSchema = z.record(z.string(), ProviderPreferencesSchema);
const SourceSchema = z.object({
  base: ProvidersSchema,
  workflowIds: z.record(z.string(), z.record(z.string(), z.string())),
  error: z.string().nullable(),
  conflicts: z.array(z.string()),
  conflictValues: z.array(
    z.object({ field: z.string(), sharedValue: z.string(), environmentValue: z.string() }),
  ),
  conflictRevision: z.number().int().nonnegative().nullable(),
  retainedWorkflows: z.record(z.string(), z.array(z.string())),
});
export const ProfileSharingStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().positive(),
  providers: ProvidersSchema,
  sources: z.record(z.string(), SourceSchema),
});
export type ProfileSharingState = z.infer<typeof ProfileSharingStateSchema>;

export interface ProfileEnvironment {
  serverId: string;
  read(): Promise<MutableDaemonConfig>;
  patch(patch: MutableDaemonConfigPatch): Promise<MutableDaemonConfig>;
}
export interface ProfileSharingJournal {
  read(): ProfileSharingState | null;
  write(state: ProfileSharingState): void;
  backup(
    configs: Record<
      string,
      Pick<MutableDaemonConfig, "agentProfiles" | "sharedProviderPreferences">
    >,
  ): void;
}

/** Runs independently of browser sessions. Journal the shared edit before touching a replica. */
export class InstallationProfiles {
  private state: ProfileSharingState | null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly journal: ProfileSharingJournal,
    private readonly environments: ProfileEnvironment[],
  ) {
    this.state = journal.read();
  }

  inspect(): ProfileSharingState | null {
    return structuredClone(this.state);
  }

  status(): ProfileSharingStatus | null {
    if (!this.state) return null;
    const sources: ProfileSharingStatus["sources"] = {};
    for (const [serverId, source] of Object.entries(this.state.sources)) {
      sources[serverId] = {
        error: source.error,
        conflicts: source.conflicts,
        conflictValues: source.conflictValues,
      };
    }
    return structuredClone({ version: this.state.version, revision: this.state.revision, sources });
  }

  synchronize(): Promise<void> {
    const operation = this.queue.then(() => this.reconcile());
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  resolve(input: {
    serverId: string;
    expectedRevision: number;
    choice: "shared" | "environment";
  }): Promise<void> {
    const operation = this.queue.then(() => this.resolveConflict(input));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async resolveConflict(input: {
    serverId: string;
    expectedRevision: number;
    choice: "shared" | "environment";
  }): Promise<void> {
    const state = this.state;
    if (!state || state.revision !== input.expectedRevision)
      throw new ProfileSharingConflict(["revision"]);
    const environment = this.environments.find((item) => item.serverId === input.serverId);
    const source = state.sources[input.serverId];
    if (!environment || !source || !source.conflicts.length)
      throw new Error("No conflicting environment was found");
    const config = await environment.read();
    const preferences = config.sharedProviderPreferences;
    if (!preferences) throw new Error("Update the daemon before sharing profiles");
    if (preferences.revision !== source.conflictRevision)
      throw new ProfileSharingConflict(["environment revision"]);
    const next = structuredClone(state);
    next.providers = ProvidersSchema.parse(
      mergeProfileEdits(source.base, state.providers, preferences.providers, input.choice),
    );
    this.validateRetainedWorkflows(next);
    next.sources[input.serverId].base = structuredClone(preferences.providers);
    next.sources[input.serverId].conflicts = [];
    next.sources[input.serverId].conflictValues = [];
    next.sources[input.serverId].conflictRevision = null;
    next.sources[input.serverId].error = null;
    this.commit(next);
    await this.reconcile();
  }

  private validateRetainedWorkflows(state: ProfileSharingState): void {
    for (const source of Object.values(state.sources)) {
      for (const [type, ids] of Object.entries(source.retainedWorkflows)) {
        for (const id of ids) {
          if (state.providers[type]?.workflows.some((workflow) => workflow.id === id)) continue;
          throw new ProfileSharingConflict(
            [`profiles.${type}.workflows.${id}`],
            [
              {
                field: `profiles.${type}.workflows.${id}`,
                sharedValue: "Retained for legacy launches in another environment",
                environmentValue: "Deleted",
              },
            ],
          );
        }
      }
    }
  }

  private commit(state: ProfileSharingState): void {
    state.revision = (this.state?.revision ?? 0) + 1;
    this.journal.write(state);
    this.state = state;
  }

  private async reconcile(): Promise<void> {
    const observations = await Promise.allSettled(
      this.environments.map((environment) => environment.read()),
    );
    const configs: Record<string, MutableDaemonConfig> = {};
    for (const [index, observation] of observations.entries()) {
      if (observation.status === "fulfilled")
        configs[this.environments[index].serverId] = observation.value;
    }
    if (!this.state) {
      if (Object.keys(configs).length !== this.environments.length)
        throw new Error("Connect every environment before importing shared profiles");
      const imports = this.environments.map(({ serverId }) => {
        const preferences = configs[serverId].sharedProviderPreferences;
        if (!preferences)
          throw new Error(
            "Update every daemon to shared provider preferences before importing profiles",
          );
        return { serverId, preferences };
      });
      const imported = importEnvironmentProfiles(imports);
      const backups: Parameters<ProfileSharingJournal["backup"]>[0] = {};
      const sources: ProfileSharingState["sources"] = {};
      for (const { serverId, preferences } of imports) {
        backups[serverId] = {
          agentProfiles: configs[serverId].agentProfiles,
          sharedProviderPreferences: preferences,
        };
        const retainedWorkflows: Record<string, string[]> = {};
        for (const binding of Object.values(preferences.legacyProfiles)) {
          const id = imported.workflowIds[serverId][binding.providerType][binding.workflowId];
          retainedWorkflows[binding.providerType] ??= [];
          retainedWorkflows[binding.providerType].push(id);
        }
        sources[serverId] = {
          base: preferences.providers,
          workflowIds: imported.workflowIds[serverId],
          error: null,
          conflicts: [],
          conflictValues: [],
          conflictRevision: null,
          retainedWorkflows,
        };
      }
      this.journal.backup(backups);
      this.commit({ version: 1, revision: 1, providers: imported.providers, sources });
    }
    for (const [index, observation] of observations.entries()) {
      await this.reconcileEnvironment(this.environments[index], observation);
    }
  }

  private async reconcileEnvironment(
    environment: ProfileEnvironment,
    observation: PromiseSettledResult<MutableDaemonConfig>,
  ): Promise<void> {
    const state = this.state;
    if (!state) throw new Error("Missing profile sharing journal");
    const next = structuredClone(state);
    const source = next.sources[environment.serverId];
    if (!source)
      throw new Error(
        "Profile sharing environment identity changed; review migration before joining it",
      );
    if (observation.status === "rejected") {
      source.error =
        "Environment is offline. Its saved edits will be reconciled after reconnecting.";
      if (!isDeepStrictEqual(state, next)) this.commit(next);
      return;
    }
    const config = observation.value;
    const preferences = config.sharedProviderPreferences;
    if (!preferences) {
      source.error = "Update this daemon before synchronizing profiles.";
      if (!isDeepStrictEqual(state, next)) this.commit(next);
      return;
    }
    try {
      next.providers = ProvidersSchema.parse(
        mergeProfileEdits(source.base, next.providers, preferences.providers),
      );
      this.validateRetainedWorkflows(next);
      source.base = structuredClone(preferences.providers);
      source.error = null;
      source.conflicts = [];
      source.conflictValues = [];
      source.conflictRevision = null;
      // Persist an imported edit even if the subsequent replica write loses its reply.
      if (!isDeepStrictEqual(state, next)) this.commit(next);
      const target = projectEnvironmentProfiles({
        config,
        providers: next.providers,
        workflowIds: source.workflowIds,
      });
      if (isDeepStrictEqual(target, preferences)) return;
      const saved = await environment.patch({
        sharedProviderPreferences: target,
        expectedProviderPreferencesRevision: preferences.revision,
      });
      if (!saved.sharedProviderPreferences)
        throw new Error("Daemon did not retain shared profiles");
      const acknowledged = structuredClone(this.state);
      if (!acknowledged) throw new Error("Missing profile sharing journal");
      acknowledged.sources[environment.serverId].base = saved.sharedProviderPreferences.providers;
      this.commit(acknowledged);
    } catch (error) {
      const failed = structuredClone(this.state);
      if (!failed) throw error;
      const failedSource = failed.sources[environment.serverId];
      if (error instanceof ProfileSharingConflict) {
        failedSource.conflicts = error.fields;
        failedSource.conflictValues = error.values;
        failedSource.conflictRevision = preferences.revision;
        failedSource.error = error.message;
      } else {
        failedSource.error =
          "Profile synchronization failed. Edits are retained; synchronization will retry with the current daemon revision.";
      }
      if (!isDeepStrictEqual(this.state, failed)) this.commit(failed);
    }
  }
}
