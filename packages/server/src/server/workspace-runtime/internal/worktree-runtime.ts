import { stat } from "node:fs/promises";
import path from "node:path";

import {
  createWorktree,
  deletePaseoWorktree,
  getGitCommonDir,
  type WorktreeSource,
} from "../../../utils/worktree.js";
import type {
  WorkspaceDriverCreateInput,
  WorkspaceDriverInspection,
  WorkspaceDriverSpawnInput,
  WorkspaceDriverState,
  WorkspaceRuntimeDriver,
} from "../drivers/index.js";
import { resolveRuntimeCwd, spawnHostProcess } from "./host-process.js";
import { createRuntimeStateStore } from "./runtime-state.js";

interface WorktreeRuntimeState extends WorkspaceDriverState {
  sourceRoot: string;
  worktreeRoot: string;
}

export function createWorktreeRuntime(options: {
  paseoHome: string;
  worktreesRoot?: string;
}): WorkspaceRuntimeDriver {
  const states = createRuntimeStateStore(options.paseoHome, "worktree");

  async function inspect(workspaceId: string): Promise<WorkspaceDriverInspection> {
    const state = await states.read(workspaceId);
    if (!state) return { status: "missing" };
    try {
      if (!(await stat(state.root)).isDirectory()) return { status: "missing" };
      return { status: state.lifecycle, state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "error", message: String(error) };
    }
  }

  async function requireReady(workspaceId: string): Promise<WorkspaceDriverState> {
    const inspection = await inspect(workspaceId);
    if (inspection.status !== "ready") {
      throw new Error(`Workspace runtime worktree is ${inspection.status}: ${workspaceId}`);
    }
    return inspection.state;
  }

  return {
    id: "worktree",
    async create(input: WorkspaceDriverCreateInput) {
      const existing = await inspect(input.workspaceId);
      if (existing.status === "ready" || existing.status === "paused") return existing.state;
      if (input.project.source.kind !== "host-directory") {
        throw new Error("The worktree runtime requires a host Git checkout");
      }
      if (input.placement.kind === "existing") {
        throw new Error("The worktree runtime creates and owns its worktree");
      }
      const sourceRoot = path.resolve(input.project.source.path);
      const worktree = await createWorktree({
        cwd: sourceRoot,
        source: toWorktreeSource(input.placement),
        worktreeSlug: input.placement.worktreeSlug ?? input.workspaceId,
        runSetup: false,
        paseoHome: options.paseoHome,
        worktreesRoot: options.worktreesRoot,
      });
      try {
        const root = await resolveRuntimeCwd(worktree.worktreePath, input.placement.relativeCwd);
        if (!(await stat(root)).isDirectory()) {
          throw new Error(`Selected project directory is missing from the worktree: ${root}`);
        }
        const state: WorktreeRuntimeState = {
          workspaceId: input.workspaceId,
          root,
          worktreeRoot: worktree.worktreePath,
          sourceRoot,
          revision: `worktree:${Date.now()}`,
          executionDomainId: "host",
          lifecycle: "ready",
        };
        await states.write(state);
        return state;
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
      return spawnHostProcess((await requireReady(input.workspaceId)).root, input);
    },
    async pause(workspaceId) {
      const inspection = await inspect(workspaceId);
      if (inspection.status === "paused") return;
      if (inspection.status !== "ready") {
        throw new Error(`Workspace runtime worktree is ${inspection.status}: ${workspaceId}`);
      }
      await states.write({ ...inspection.state, lifecycle: "paused" });
    },
    async resume(workspaceId) {
      const inspection = await inspect(workspaceId);
      if (inspection.status === "missing" || inspection.status === "error") {
        throw new Error(`Workspace runtime worktree is ${inspection.status}: ${workspaceId}`);
      }
      const state = { ...inspection.state, lifecycle: "ready" as const };
      await states.write(state);
      return state;
    },
    async destroy(workspaceId) {
      const state = (await states.read(workspaceId)) as WorktreeRuntimeState | null;
      if (!state) return;
      const sourceRoot =
        typeof state.sourceRoot === "string"
          ? state.sourceRoot
          : path.dirname(await getGitCommonDir(state.root));
      const worktreeRoot = typeof state.worktreeRoot === "string" ? state.worktreeRoot : state.root;
      await deletePaseoWorktree({
        cwd: sourceRoot,
        worktreePath: worktreeRoot,
        teardownCwds: [],
        paseoHome: options.paseoHome,
        worktreesBaseRoot: options.worktreesRoot,
      });
      await states.remove(workspaceId);
    },
  };
}

function toWorktreeSource(
  placement: Exclude<WorkspaceDriverCreateInput["placement"], { kind: "existing" }>,
): WorktreeSource {
  if (placement.kind === "branch") {
    return {
      kind: "branch-off",
      baseBranch: placement.baseRef,
      branchName: placement.branchName,
    };
  }
  return { kind: "checkout-branch", branchName: placement.ref };
}
