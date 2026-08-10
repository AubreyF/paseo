import type { Readable, Writable } from "node:stream";

import { createCommandRuntimeAdapter } from "./command/index.js";
import { createLocalRuntime } from "./internal/local-runtime.js";
import { createService } from "./internal/service.js";
import { createWorktreeRuntime } from "./internal/worktree-runtime.js";

export type WorkspaceSource =
  | { kind: "host-directory"; path: string }
  | { kind: "git"; url: string; revision: string; subdirectory?: string };

export type WorkspacePlacement =
  | { kind: "existing"; relativeCwd?: string }
  | {
      kind: "branch";
      branchName: string;
      baseRef: string;
      relativeCwd?: string;
      worktreeSlug?: string;
    }
  | { kind: "checkout"; ref: string; relativeCwd?: string; worktreeSlug?: string };

export type WorkspaceProcessPurpose =
  | { kind: "agent"; agentId: string; provider: string }
  | { kind: "terminal"; terminalId: string }
  | { kind: "git" }
  | { kind: "provider-probe"; provider: string }
  | { kind: "workspace-helper" }
  | { kind: "workspace-script"; script: string }
  | { kind: "setup" }
  | { kind: "archive" };

export interface WorkspaceSetupCommand {
  cwd?: string;
  argv: readonly [string, ...string[]];
  env: Readonly<Record<string, string>>;
}

export interface CreateWorkspaceInput {
  workspaceId: string;
  runtimeId: string;
  project: { id: string; source: WorkspaceSource };
  placement: WorkspacePlacement;
  setup?: readonly WorkspaceSetupCommand[];
}

export interface WorkspaceProcessInput extends WorkspaceSetupCommand {
  workspaceId: string;
  purpose: WorkspaceProcessPurpose;
}

export interface WorkspaceProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface WorkspaceProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<WorkspaceProcessExit>;
  kill(signal?: NodeJS.Signals): void;
}

export interface WorkspaceRuntimeService {
  create(input: CreateWorkspaceInput): Promise<{ workspaceId: string; runtimeId: string }>;
  run(input: WorkspaceProcessInput): Promise<WorkspaceProcess>;
  pause(workspaceId: string): Promise<void>;
  resume(workspaceId: string): Promise<void>;
  destroy(workspaceId: string): Promise<void>;
}

export interface WorkspaceRuntimeRecordStore {
  resolveRuntimeId(workspaceId: string): Promise<string | null>;
  persistRuntimeId(workspaceId: string, runtimeId: string): Promise<void>;
}

export interface ExternalWorkspaceRuntime {
  type: "command";
  command: readonly [string, ...string[]];
  options?: Readonly<Record<string, unknown>>;
}

export interface WorkspaceRuntimeOptions extends WorkspaceRuntimeRecordStore {
  paseoHome: string;
  worktreesRoot?: string;
  externalRuntimes?: Readonly<Record<string, ExternalWorkspaceRuntime>>;
}

export function createWorkspaceRuntimeService(
  options: WorkspaceRuntimeOptions,
): WorkspaceRuntimeService {
  const externalDrivers = Object.entries(options.externalRuntimes ?? {}).map(
    ([runtimeId, config]) => {
      if (runtimeId === "local" || runtimeId === "worktree") {
        throw new Error(`Workspace runtime id is reserved: ${runtimeId}`);
      }
      return createCommandRuntimeAdapter(runtimeId, config);
    },
  );
  return createService(
    [
      createLocalRuntime(options.paseoHome),
      createWorktreeRuntime({
        paseoHome: options.paseoHome,
        worktreesRoot: options.worktreesRoot,
      }),
      ...externalDrivers,
    ],
    options,
  );
}
