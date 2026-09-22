import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { AgentSessionConfig } from "../agent-sdk-types.js";
import {
  DEFAULT_QUOTA_RESERVE_POLICY,
  parseQuotaReservePolicy,
} from "@getpaseo/protocol/quota-reserve";

export class ProfileLaunchError extends Error {
  constructor(
    readonly profileId: string,
    message: string,
  ) {
    super(message);
    this.name = "ProfileLaunchError";
  }
}

function resolveWorkerProfile(profile: AgentProfile, profiles: readonly AgentProfile[]) {
  const workerId = profile.workerProfileId?.trim();
  const worker = workerId ? profiles.find((entry) => entry.id === workerId) : undefined;
  if (workerId && !worker) {
    throw new ProfileLaunchError(workerId, "Worker profile not found.");
  }
  if (worker && (worker.id === profile.id || worker.workerProfileId?.trim())) {
    throw new ProfileLaunchError(worker.id, "A worker profile cannot supervise another team.");
  }
  if (worker && !worker.model?.trim()) {
    throw new ProfileLaunchError(worker.id, "Select an explicit model for the worker profile.");
  }
  return worker;
}

/** Resolve only explicit launches. Resumes already contain their frozen instructions. */
function resolveProfileConfiguration(
  config: AgentSessionConfig,
  profiles: readonly AgentProfile[],
): AgentSessionConfig {
  if (!config.profileId) return config;
  const found = profiles.find((entry) => entry.id === config.profileId);
  if (!found) throw new ProfileLaunchError(config.profileId, "Selected profile not found.");
  const profile = structuredClone(found);
  const worker = resolveWorkerProfile(profile, profiles);
  const instructions = [profile.instructions?.trim(), config.systemPrompt?.trim()];
  if (worker) {
    instructions.push(
      `You supervise local workers using Paseo's create_agent tool. Use profileId ${JSON.stringify(worker.id)} ` +
        `and provider ${JSON.stringify(`${worker.provider}/${worker.model}`)}. ` +
        `Assign bounded tasks with explicit file ownership. Use separate worktrees for concurrent edits. ` +
        `Review each worker's diff and run relevant tests before accepting it. ` +
        `At most ${profile.maxWorkers ?? 2} managed workers may run at once. ` +
        `Worker instructions and tools do not grant permission beyond the user's task. ` +
        `On quota exhaustion stop, preserve progress, and ask the user to select another profile.`,
    );
  }
  const { profileId: _, ...base } = config;
  return {
    ...base,
    provider: profile.provider,
    modeId: config.modeId ?? (profile.modeId?.trim() || undefined),
    model: profile.model?.trim() || config.model,
    thinkingOptionId: profile.thinkingOptionId?.trim() || undefined,
    featureValues: profile.featureValues ?? {},
    systemPrompt: instructions.filter(Boolean).join("\n\n") || undefined,
    profileLaunch: { profile, ...(worker ? { worker: structuredClone(worker) } : {}) },
  };
}

export function resolveProfileLaunch(
  config: AgentSessionConfig,
  profiles: readonly AgentProfile[],
  nowMs = Date.now(),
): AgentSessionConfig {
  const { quotaReservePolicy: requested, ...launchConfig } = config;
  if (!requested) return resolveProfileConfiguration(config, profiles);
  if (config.quotaReserve) throw new Error("Use task controls to change a frozen reserve policy.");
  const resolved = resolveProfileConfiguration(launchConfig, profiles);
  const policy =
    requested.kind === "profile"
      ? (resolved.profileLaunch?.profile.quotaReservePolicy ?? DEFAULT_QUOTA_RESERVE_POLICY)
      : requested;
  return {
    ...resolved,
    quotaReserve: {
      policy: parseQuotaReservePolicy(policy),
      state: { kind: "ready", revision: 0, changedAt: new Date(nowMs).toISOString() },
    },
  };
}
