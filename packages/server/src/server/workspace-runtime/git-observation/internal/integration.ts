import type { BoundWorkspaceRuntime } from "../../index.js";
import type { WorkspaceRuntimeDriver } from "../../drivers/index.js";
import type { WorkspaceFilesSubscription } from "@getpaseo/workspace-helper";
import { registerGitCommonObservationCapability } from "./capability.js";

interface GitObservation {
  workspaceId: string;
  runtime: BoundWorkspaceRuntime;
  driver: WorkspaceRuntimeDriver;
  listener: () => void;
  physical: { unsubscribe(): Promise<void> } | null;
}

export interface ObservationRebindTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface GitCommonObservationCoordinator {
  bind(runtime: BoundWorkspaceRuntime, workspaceId: string, driver: WorkspaceRuntimeDriver): void;
  pause(workspaceId: string): Promise<void>;
  stageResume(workspaceId: string): Promise<ObservationRebindTransaction>;
  destroy(workspaceId: string): Promise<void>;
}

/** Git invalidation is workspace-bound. Runtime-private observers never disclose placement. */
export function createGitCommonObservationCoordinator(): GitCommonObservationCoordinator {
  const observations = new Set<GitObservation>();

  return {
    bind(runtime, workspaceId, driver) {
      registerGitCommonObservationCapability(runtime, {
        observe: async (listener) => {
          const observation: GitObservation = {
            workspaceId,
            runtime,
            driver,
            listener,
            physical: null,
          };
          observation.physical = await start(observation);
          observations.add(observation);
          let active = true;
          return {
            async unsubscribe() {
              if (!active) return;
              active = false;
              observations.delete(observation);
              const physical = observation.physical;
              observation.physical = null;
              await physical?.unsubscribe();
            },
          };
        },
      });
    },
    async pause(workspaceId) {
      for (const observation of owned(workspaceId)) {
        const physical = observation.physical;
        observation.physical = null;
        await physical?.unsubscribe();
      }
    },
    async stageResume(workspaceId) {
      const staged = new Map<GitObservation, { unsubscribe(): Promise<void> }>();
      try {
        for (const observation of owned(workspaceId)) {
          if (!observation.physical) staged.set(observation, await start(observation));
        }
      } catch (error) {
        await Promise.allSettled([...staged.values()].map((item) => item.unsubscribe()));
        throw error;
      }
      let finished = false;
      return {
        async commit() {
          if (finished) return;
          finished = true;
          for (const [observation, physical] of staged) observation.physical = physical;
        },
        async rollback() {
          if (finished) return;
          finished = true;
          await Promise.allSettled([...staged.values()].map((item) => item.unsubscribe()));
        },
      };
    },
    async destroy(workspaceId) {
      const selected = owned(workspaceId);
      for (const observation of selected) observations.delete(observation);
      await Promise.allSettled(selected.map((observation) => observation.physical?.unsubscribe()));
    },
  };

  function owned(workspaceId: string): GitObservation[] {
    return [...observations].filter((observation) => observation.workspaceId === workspaceId);
  }

  async function start(observation: GitObservation) {
    if (observation.driver.observeGit) {
      return observation.driver.observeGit(observation.workspaceId, observation.listener);
    }
    const ignoredPaths = await readGitIgnoredPaths(observation.runtime);
    const subscription: WorkspaceFilesSubscription = await observation.runtime.files.subscribe(
      { paths: ["."], recursive: true, ignoredPaths },
      (event) => {
        if (event.type !== "error") observation.listener();
      },
    );
    return subscription;
  }
}

async function readGitIgnoredPaths(runtime: BoundWorkspaceRuntime): Promise<string[]> {
  const process = await runtime.run({
    argv: ["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    env: { GIT_OPTIONAL_LOCKS: "0", PATH: "/usr/local/bin:/usr/bin:/bin" },
    purpose: { kind: "git" },
  });
  process.stdin.end();
  const [stdout, , exit] = await Promise.all([
    collect(process.stdout),
    collect(process.stderr),
    process.exited,
  ]);
  if (exit.code !== 0 || exit.signal !== null) return [];
  return [
    ...new Set(
      stdout
        .split("\0")
        .map((entry) => entry.replace(/\/+$/, ""))
        .filter(Boolean),
    ),
  ];
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
