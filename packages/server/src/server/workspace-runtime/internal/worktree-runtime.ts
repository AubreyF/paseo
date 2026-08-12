import { stat } from "node:fs/promises";
import path from "node:path";

import {
  createWorktree,
  deletePaseoWorktree,
  seedPaseoConfigFile,
  type WorktreeSource,
} from "../../../utils/worktree.js";
import type {
  WorkspaceDriverCreateInput,
  WorkspaceDriverInspection,
  WorkspaceDriverSpawnInput,
  WorkspaceDriverState,
  WorkspaceRuntimeDriver,
} from "../drivers/index.js";
import { resolveRuntimeCwd, spawnHostProcess, spawnHostPty } from "./host-process.js";
import { hostWorkspaceHelper } from "./host-helper.js";
import type { HostGitObservationOwner } from "./host-git-observation.js";
import { createRuntimeStateStore } from "./runtime-state.js";
import { writePaseoWorktreeFirstAgentBranchAutoNameMetadata } from "../../../utils/worktree-metadata.js";

interface WorktreeRuntimeState {
  workspaceId: string;
  root: string;
  sourceRoot: string;
  worktreeRoot: string;
  lifecycle: "ready" | "paused";
  lifecycleEnvironment: Readonly<Record<string, string>>;
  ownsWorktree?: boolean;
}

export function createWorktreeRuntime(options: {
  paseoHome: string;
  worktreesRoot?: string;
  hostGitObservations: HostGitObservationOwner;
}): WorkspaceRuntimeDriver {
  const states = createRuntimeStateStore(options.paseoHome, "worktree", isWorktreeRuntimeState);

  async function inspect(workspaceId: string): Promise<WorkspaceDriverInspection> {
    const state = await states.read(workspaceId);
    if (!state) return { status: "missing" };
    try {
      if (!(await stat(state.root)).isDirectory()) return { status: "missing" };
      return {
        status: state.lifecycle,
        state: publicState(state),
        placement: hostPlacement(state.root),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "error", message: String(error) };
    }
  }

  async function requireReady(workspaceId: string): Promise<WorktreeRuntimeState> {
    const state = await states.read(workspaceId);
    if (!state || state.lifecycle !== "ready") {
      throw new Error(
        `Workspace runtime worktree is ${state?.lifecycle ?? "missing"}: ${workspaceId}`,
      );
    }
    return state;
  }

  return {
    id: "worktree",
    requiresGitProject: true,
    workspaceHelper: hostWorkspaceHelper,
    scriptTerminal: { kind: "persistent-shell" },
    async create(input: WorkspaceDriverCreateInput) {
      const existing = await inspect(input.workspaceId);
      if (existing.status === "ready" || existing.status === "paused") {
        return { ...existing, materializedFreshContent: false };
      }
      if (input.project.source.kind !== "host-directory") {
        throw new Error("The worktree runtime requires a host Git checkout");
      }
      if (input.purpose === "provider-probe") {
        if (input.placement.kind !== "existing") {
          throw new Error("A worktree provider probe adopts an existing Git checkout");
        }
        const sourceRoot = path.resolve(input.project.source.path);
        const root = await resolveRuntimeCwd(sourceRoot, input.placement.relativeCwd);
        if (!(await stat(root)).isDirectory()) throw new Error(`Directory not found: ${root}`);
        const state: WorktreeRuntimeState = {
          workspaceId: input.workspaceId,
          root,
          worktreeRoot: sourceRoot,
          sourceRoot,
          lifecycle: "ready",
          lifecycleEnvironment: {},
          ownsWorktree: false,
        };
        await states.write(state);
        return {
          state: publicState(state),
          placement: hostPlacement(root),
          materializedFreshContent: false,
        };
      }
      if (input.placement.kind === "existing") {
        throw new Error("The worktree runtime creates and owns its worktree");
      }
      const sourceRoot = path.resolve(input.project.source.path);
      const worktreeSlug =
        input.placement.kind === "resolved-worktree"
          ? input.placement.worktreeSlug
          : (input.placement.worktreeSlug ?? input.workspaceId);
      const worktree = await createWorktree({
        cwd: sourceRoot,
        source: toWorktreeSource(input.placement),
        worktreeSlug,
        runSetup: false,
        paseoHome: options.paseoHome,
        worktreesRoot: options.worktreesRoot,
      });
      try {
        if (
          input.markFirstAgentBranchAutoName &&
          input.placement.kind === "resolved-worktree" &&
          input.placement.source.kind === "branch-off"
        ) {
          writePaseoWorktreeFirstAgentBranchAutoNameMetadata(worktree.worktreePath, {
            placeholderBranchName: worktree.branchName,
          });
        }
        const root = await resolveRuntimeCwd(
          worktree.worktreePath,
          input.placement.relativeCwd,
        ).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error("Selected project directory is missing from the worktree", {
              cause: error,
            });
          }
          throw error;
        });
        if (input.seedPaseoConfigFrom) {
          await seedPaseoConfigFile({ sourceCwd: input.seedPaseoConfigFrom, targetCwd: root });
        }
        if (!(await stat(root)).isDirectory()) {
          throw new Error(`Selected project directory is missing from the worktree: ${root}`);
        }
        const state: WorktreeRuntimeState = {
          workspaceId: input.workspaceId,
          root,
          worktreeRoot: worktree.worktreePath,
          sourceRoot,
          lifecycle: "ready",
          lifecycleEnvironment: {
            PASEO_SOURCE_CHECKOUT_PATH: ".",
            PASEO_ROOT_PATH: ".",
            PASEO_WORKTREE_PATH: ".",
            PASEO_BRANCH_NAME: worktree.branchName,
          },
          ownsWorktree: true,
        };
        await states.write(state);
        return {
          state: publicState(state),
          placement: hostPlacement(root),
          materializedFreshContent: true,
        };
      } catch (error) {
        await deletePaseoWorktree({
          cwd: sourceRoot,
          worktreePath: worktree.worktreePath,
          teardownCwds: [],
          paseoHome: options.paseoHome,
          worktreesBaseRoot: options.worktreesRoot,
        });
        throw error;
      }
    },
    inspect,
    async spawn(input: WorkspaceDriverSpawnInput) {
      const root = (await requireReady(input.workspaceId)).root;
      return input.stdio.kind === "pty" ? spawnHostPty(root, input) : spawnHostProcess(root, input);
    },
    async observeGit(workspaceId, listener) {
      return options.hostGitObservations.observe((await requireReady(workspaceId)).root, listener);
    },
    async pause(workspaceId) {
      const state = await states.read(workspaceId);
      if (state?.lifecycle === "paused") return;
      if (!state) throw new Error(`Workspace runtime worktree is missing: ${workspaceId}`);
      await states.write({ ...state, lifecycle: "paused" });
    },
    async resume(workspaceId) {
      const current = await states.read(workspaceId);
      if (!current) throw new Error(`Workspace runtime worktree is missing: ${workspaceId}`);
      const state = { ...current, lifecycle: "ready" as const };
      await states.write(state);
      return { state: publicState(state), placement: hostPlacement(state.root) };
    },
    async destroy(workspaceId) {
      const state = await states.read(workspaceId);
      if (!state) return;
      if (state.ownsWorktree !== false) {
        await deletePaseoWorktree({
          cwd: state.sourceRoot,
          worktreePath: state.worktreeRoot,
          teardownCwds: [],
          paseoHome: options.paseoHome,
          worktreesBaseRoot: options.worktreesRoot,
        });
      }
      await states.remove(workspaceId);
    },
  };
}

function publicState(state: WorktreeRuntimeState): WorkspaceDriverState {
  return {
    workspaceId: state.workspaceId,
    lifecycle: state.lifecycle,
    lifecycleEnvironment: state.lifecycleEnvironment,
  };
}

function isWorktreeRuntimeState(
  value: unknown,
  workspaceId: string,
): value is WorktreeRuntimeState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<WorktreeRuntimeState>;
  return (
    state.workspaceId === workspaceId &&
    typeof state.root === "string" &&
    typeof state.sourceRoot === "string" &&
    typeof state.worktreeRoot === "string" &&
    (state.lifecycle === "ready" || state.lifecycle === "paused") &&
    !!state.lifecycleEnvironment &&
    typeof state.lifecycleEnvironment === "object" &&
    (state.ownsWorktree === undefined || typeof state.ownsWorktree === "boolean")
  );
}

function hostPlacement(root: string) {
  return { cwd: root, hostVisiblePath: root };
}

function toWorktreeSource(
  placement: Exclude<WorkspaceDriverCreateInput["placement"], { kind: "existing" }>,
): WorktreeSource {
  if (placement.kind === "resolved-worktree") return placement.source as WorktreeSource;
  if (placement.kind === "branch") {
    return {
      kind: "branch-off",
      baseBranch: placement.baseRef,
      branchName: placement.branchName,
    };
  }
  return { kind: "checkout-branch", branchName: placement.ref };
}
