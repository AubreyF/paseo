import type { Readable, Writable } from "node:stream";

import type { WorkspaceFiles } from "../workspace-helper/index.js";

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
  | { kind: "checkout"; ref: string; relativeCwd?: string; worktreeSlug?: string }
  | ResolvedWorktreePlacement;

export type ResolvedWorktreeSource =
  | { kind: "branch-off"; baseBranch: string; branchName: string }
  | { kind: "checkout-branch"; branchName: string }
  | {
      kind: "checkout-change-request" | "checkout-github-pr";
      forge?: string;
      changeRequestNumber?: number;
      githubPrNumber?: number;
      headRef: string;
      headRepositoryOwner?: string;
      baseRefName: string;
      checkoutRefs?: readonly {
        remoteName?: string;
        remoteRef: string;
      }[];
      localBranchName?: string;
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    };

export interface ResolvedWorktreePlacement {
  kind: "resolved-worktree";
  source: ResolvedWorktreeSource;
  worktreeSlug: string;
  relativeCwd?: string;
}

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
  setupFromPaseoConfig?: boolean;
  markFirstAgentBranchAutoName?: boolean;
  seedPaseoConfigFrom?: string;
}

export interface WorkspaceProcessInput extends WorkspaceSetupCommand {
  workspaceId: string;
  purpose: WorkspaceProcessPurpose;
}

export interface WorkspaceTerminalInput extends WorkspaceProcessInput {
  rows: number;
  cols: number;
  term?: string;
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

export interface WorkspaceTerminal {
  onData(listener: (data: string) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  readonly exited: Promise<WorkspaceProcessExit>;
  kill(signal?: NodeJS.Signals): void;
}

export interface BoundWorkspaceRuntime {
  run(input: Omit<WorkspaceProcessInput, "workspaceId">): Promise<WorkspaceProcess>;
  resolveCommand(command: string): Promise<string | null>;
  readonly files: WorkspaceFiles;
  readonly homeFiles: WorkspaceFiles;
}

export interface WorkspaceRuntimeService {
  reconcile(): Promise<void>;
  create(input: CreateWorkspaceInput): Promise<WorkspaceRuntimePlacement>;
  run(input: WorkspaceProcessInput): Promise<WorkspaceProcess>;
  openTerminal(input: WorkspaceTerminalInput): Promise<WorkspaceTerminal>;
  bind(workspaceId: string): Promise<BoundWorkspaceRuntime>;
  files(workspaceId: string): WorkspaceFiles;
  inspect(workspaceId: string): Promise<WorkspaceRuntimeInspection>;
  requireHostVisiblePath(workspaceId: string): Promise<string>;
  runSetup(workspaceId: string, signal?: AbortSignal): Promise<void>;
  pause(workspaceId: string): Promise<void>;
  resume(workspaceId: string): Promise<void>;
  archive(workspaceId: string): Promise<void>;
  restore(workspaceId: string): Promise<void>;
  destroy(workspaceId: string): Promise<void>;
}

export interface WorkspaceRuntimePlacement {
  workspaceId: string;
  runtimeId: string;
  cwd: string;
  hostVisiblePath?: string;
}

export type WorkspaceRuntimeInspection =
  | { status: "missing" | "error" }
  | ({ status: "paused" | "ready" } & Omit<WorkspaceRuntimePlacement, "workspaceId" | "runtimeId">);

export interface WorkspaceRuntimeRecordStore {
  resolveRuntimeId(workspaceId: string): Promise<string | null>;
  persistRuntimeId(
    workspaceId: string,
    runtimeId: string,
    placement: { cwd: string; hostVisiblePath?: string },
  ): Promise<void>;
  archiveWorkspaceRecord?(workspaceId: string): Promise<void>;
  restoreWorkspaceRecord?(workspaceId: string): Promise<void>;
  beginWorkspaceDeletion?(workspaceId: string): Promise<void>;
  removeWorkspaceRecord?(workspaceId: string): Promise<void>;
  listRuntimeRecords?(): Promise<
    readonly { workspaceId: string; runtimeId: string; archived: boolean; deleting?: boolean }[]
  >;
}

export interface ExternalWorkspaceRuntime {
  type: "command";
  command: readonly [string, ...string[]];
  options?: Readonly<Record<string, unknown>>;
  helperCommand?: readonly [string, ...string[]];
  /** Explicit provider base environment for an isolated runtime. Host env is never inherited. */
  providerEnvironment?: Readonly<Record<string, string>>;
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
