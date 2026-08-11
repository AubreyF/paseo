import { stat } from "node:fs/promises";
import path from "node:path";

import type {
  WorkspaceDriverCreateInput,
  WorkspaceDriverInspection,
  WorkspaceDriverSpawnInput,
  WorkspaceDriverState,
  WorkspaceRuntimeDriver,
} from "../drivers/index.js";
import { resolveRuntimeCwd, spawnHostProcess, spawnHostPty } from "./host-process.js";
import { hostWorkspaceHelperCommand } from "./host-helper.js";
import { createRuntimeStateStore } from "./runtime-state.js";

interface LocalRuntimeState extends WorkspaceDriverState {
  compatibilityCwd?: string;
}

export function createLocalRuntime(paseoHome: string): WorkspaceRuntimeDriver {
  const states = createRuntimeStateStore(paseoHome, "local");

  async function inspect(workspaceId: string): Promise<WorkspaceDriverInspection> {
    const state = (await states.read(workspaceId)) as LocalRuntimeState | null;
    if (!state) return { status: "missing" };
    try {
      if (!(await stat(state.root)).isDirectory()) return { status: "missing" };
      return {
        status: state.lifecycle,
        state,
        placement: hostPlacement(state.compatibilityCwd ?? state.root),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "error", message: String(error) };
    }
  }

  async function requireReady(workspaceId: string): Promise<WorkspaceDriverState> {
    const inspection = await inspect(workspaceId);
    if (inspection.status !== "ready") {
      throw new Error(`Workspace runtime local is ${inspection.status}: ${workspaceId}`);
    }
    return inspection.state;
  }

  return {
    id: "local",
    workspaceHelperCommand: hostWorkspaceHelperCommand,
    async create(input: WorkspaceDriverCreateInput) {
      const existing = await inspect(input.workspaceId);
      if (existing.status === "ready" || existing.status === "paused") return existing;
      if (input.project.source.kind !== "host-directory" || input.placement.kind !== "existing") {
        throw new Error("The local runtime adopts an existing host directory");
      }
      const sourceCwd = path.resolve(input.project.source.path);
      const compatibilityCwd = path.resolve(sourceCwd, input.placement.relativeCwd ?? ".");
      const root = await resolveRuntimeCwd(sourceCwd, input.placement.relativeCwd);
      if (!(await stat(root)).isDirectory()) throw new Error(`Directory not found: ${root}`);
      const state: LocalRuntimeState = {
        workspaceId: input.workspaceId,
        root,
        revision: "local:1",
        executionDomainId: "host",
        lifecycle: "ready",
        compatibilityCwd,
      };
      await states.write(state);
      return { state, placement: hostPlacement(compatibilityCwd) };
    },
    inspect,
    async spawn(input: WorkspaceDriverSpawnInput) {
      const root = (await requireReady(input.workspaceId)).root;
      return input.stdio.kind === "pty" ? spawnHostPty(root, input) : spawnHostProcess(root, input);
    },
    async pause(workspaceId) {
      const inspection = await inspect(workspaceId);
      if (inspection.status === "paused") return;
      if (inspection.status !== "ready") {
        throw new Error(`Workspace runtime local is ${inspection.status}: ${workspaceId}`);
      }
      await states.write({ ...inspection.state, lifecycle: "paused" });
    },
    async resume(workspaceId) {
      const inspection = await inspect(workspaceId);
      if (inspection.status === "missing" || inspection.status === "error") {
        throw new Error(`Workspace runtime local is ${inspection.status}: ${workspaceId}`);
      }
      const state = { ...inspection.state, lifecycle: "ready" as const };
      await states.write(state);
      const localState = state as LocalRuntimeState;
      return { state, placement: hostPlacement(localState.compatibilityCwd ?? state.root) };
    },
    async destroy(workspaceId) {
      await states.remove(workspaceId);
    },
  };
}

function hostPlacement(root: string) {
  return { cwd: root, hostVisiblePath: root };
}
