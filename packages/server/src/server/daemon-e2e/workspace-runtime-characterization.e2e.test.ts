import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileVersion } from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createWorkspaceRuntimeService } from "../workspace-runtime/index.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";

const FIXTURE_PROVIDER = "workspace-runtime-fixture";
const FIXTURE_MODEL = "fixture-model";
const fixtureAgentPath = fileURLToPath(
  new URL("../test-utils/fixtures/workspace-runtime-acp-agent.mjs", import.meta.url),
);
const fixtureRuntimePath = fileURLToPath(
  new URL("../../../../fixture-workspace-runtime/src/index.mjs", import.meta.url),
);
const workspaceHelperPath = fileURLToPath(
  new URL("../workspace-helper/executable.mjs", import.meta.url),
);

interface CharacterizedWorkspace {
  cwd: string;
  id: string;
  projectId: string;
  kind: "local" | "worktree";
}

let daemon: TestPaseoDaemon;
let client: DaemonClient;
const cleanupRoots: string[] = [];

beforeAll(async () => {
  daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    providerOverrides: {
      [FIXTURE_PROVIDER]: {
        extends: "acp",
        label: "Workspace Runtime Fixture",
        command: [process.execPath, fixtureAgentPath],
        models: [{ id: FIXTURE_MODEL, label: "Fixture Model", isDefault: true }],
        params: { supportsMcpServers: false },
        enabled: true,
      },
    },
  });
  client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.3.0-beta.2",
    reconnect: { enabled: false },
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "runtime-characterization-agents" } });
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await daemon?.close();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-runtime-characterization-"));
  cleanupRoots.push(root);
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repo,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repo, stdio: "pipe" });
  writeFileSync(path.join(repo, "characterized.txt"), "before\n");
  writeFileSync(path.join(repo, "binary.bin"), Buffer.alloc(700_000, 0xa5));
  writeFileSync(
    path.join(repo, "paseo.json"),
    JSON.stringify({
      worktree: {
        setup: [
          `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('setup-output.txt', 'setup complete\\n')"`,
        ],
      },
    }),
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "characterization fixture"], {
    cwd: repo,
    stdio: "pipe",
  });
  return repo;
}

async function createCharacterizedWorkspace(kind: "local" | "worktree") {
  const repo = createRepository();
  const result = await client.createWorkspace({
    source:
      kind === "local"
        ? { kind: "directory", path: repo }
        : {
            kind: "worktree",
            cwd: repo,
            action: "branch-off",
            branchName: "characterized-worktree",
            worktreeSlug: "characterized-worktree",
            baseBranch: "main",
          },
  });
  const workspace = result.workspace;
  if (!workspace?.workspaceDirectory) {
    throw new Error(result.error ?? `Failed to create ${kind} workspace`);
  }
  return {
    cwd: workspace.workspaceDirectory,
    id: workspace.id,
    projectId: workspace.projectId,
    kind,
  } satisfies CharacterizedWorkspace;
}

async function waitForTerminalOutput(terminalId: string, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let output = "";
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for terminal output: ${marker}`));
    }, 15_000);
    const unsubscribe = client.onTerminalStreamEvent((event) => {
      if (event.terminalId !== terminalId || event.type !== "output") return;
      output += decoder.decode(event.data, { stream: true });
      if (!output.includes(marker)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(output);
    });
  });
}

async function expectFileEditAndWatch(workspace: CharacterizedWorkspace): Promise<void> {
  const listing = await client.listDirectory(workspace.cwd, ".", undefined, workspace.id);
  expect(listing.entries.map((entry) => entry.name)).toContain("characterized.txt");

  const initialRead = await client.readFile(
    workspace.cwd,
    "characterized.txt",
    undefined,
    workspace.id,
  );
  expect(new TextDecoder().decode(initialRead.bytes)).toBe("before\n");

  let resolveUpdate!: (version: FileVersion) => void;
  const updated = new Promise<FileVersion>((resolve) => {
    resolveUpdate = resolve;
  });
  const fileSubscription = await client.subscribeFile(
    { cwd: workspace.cwd, path: "characterized.txt", workspaceId: workspace.id },
    resolveUpdate,
  );
  expect(fileSubscription.initial).toMatchObject({ status: "ready", size: 7 });
  if (fileSubscription.initial.status !== "ready") {
    throw new Error("Expected characterized.txt to be ready");
  }

  const write = await client.writeFile({
    cwd: workspace.cwd,
    path: "characterized.txt",
    content: "after\n",
    expectedModifiedAt: fileSubscription.initial.modifiedAt,
    expectedRevision: fileSubscription.initial.revision,
    workspaceId: workspace.id,
  });
  expect(write).toMatchObject({ status: "written", size: 6 });
  await expect(updated).resolves.toMatchObject({ status: "ready", size: 6 });
  fileSubscription.unsubscribe();

  const writtenRead = await client.readFile(
    workspace.cwd,
    "characterized.txt",
    undefined,
    workspace.id,
  );
  expect(new TextDecoder().decode(writtenRead.bytes)).toBe("after\n");
  const binaryRead = await client.readFile(workspace.cwd, "binary.bin", undefined, workspace.id);
  expect(binaryRead.bytes).toEqual(new Uint8Array(Buffer.alloc(700_000, 0xa5)));

  const download = await client.requestDownloadToken(
    workspace.cwd,
    "binary.bin",
    undefined,
    workspace.id,
  );
  expect(download.error).toBeNull();
  const response = await fetch(
    `http://127.0.0.1:${daemon.port}/api/files/download?token=${download.token}`,
  );
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(binaryRead.bytes);
}

async function expectGitObservation(workspace: CharacterizedWorkspace): Promise<void> {
  const workspaceGit = client.bindWorkspaceGit({ workspaceId: workspace.id, cwd: workspace.cwd });
  await expect
    .poll(() => workspaceGit.getStatus(), { timeout: 15_000 })
    .toMatchObject({
      isGit: true,
      isDirty: true,
    });
  const diff = await workspaceGit.getDiff({ mode: "uncommitted" });
  expect(diff.error).toBeNull();
  expect(diff.files).toContainEqual(
    expect.objectContaining({ path: "characterized.txt", status: "ok" }),
  );
  await expect(
    workspaceGit.commit({ message: "characterize runtime Git", addAll: true }),
  ).resolves.toMatchObject({ success: true, error: null });
  await expect(workspaceGit.refresh()).resolves.toMatchObject({ success: true, error: null });
  await expect(workspaceGit.getStatus()).resolves.toMatchObject({ isGit: true, isDirty: false });
}

async function expectTerminalCommand(workspace: CharacterizedWorkspace): Promise<void> {
  let resolveFileUpdate!: (version: FileVersion) => void;
  const fileUpdated = new Promise<FileVersion>((resolve) => {
    resolveFileUpdate = resolve;
  });
  const fileSubscription = await client.subscribeFile(
    { cwd: workspace.cwd, path: "terminal-edit.txt", workspaceId: workspace.id },
    resolveFileUpdate,
  );
  expect(fileSubscription.initial).toMatchObject({ status: "missing" });
  const terminal = await client.createTerminal(
    workspace.cwd,
    `${workspace.kind} terminal`,
    undefined,
    {
      workspaceId: workspace.id,
    },
  );
  const terminalId = terminal.terminal?.id;
  if (!terminalId) throw new Error(terminal.error ?? "Failed to create terminal");
  const marker = "runtime-terminal-ok";
  const command = "printf terminal-edit > terminal-edit.txt; printf '%s%s\\n' runtime-terminal- ok";
  expect(command).not.toContain(marker);
  try {
    const terminalOutput = waitForTerminalOutput(terminalId, marker);
    await client.subscribeTerminal(terminalId);
    client.sendTerminalInput(terminalId, { type: "input", data: `${command}\r` });
    await expect(terminalOutput).resolves.toContain(marker);
    await expect(fileUpdated).resolves.toMatchObject({ status: "ready", size: 13 });
    const edit = await client.readFile(workspace.cwd, "terminal-edit.txt", undefined, workspace.id);
    expect(new TextDecoder().decode(edit.bytes)).toBe("terminal-edit");
  } finally {
    fileSubscription.unsubscribe();
    await client.killTerminal(terminalId);
  }
}

async function expectProviderDiscoveryAndAgentExecution(
  workspace: CharacterizedWorkspace,
): Promise<void> {
  await client.refreshProvidersSnapshot({
    cwd: workspace.cwd,
    ...(workspace.kind === "local" ? { workspaceId: workspace.id } : {}),
    providers: [FIXTURE_PROVIDER],
  });
  const providers = await client.getProvidersSnapshot({
    cwd: workspace.cwd,
    ...(workspace.kind === "local" ? { workspaceId: workspace.id } : {}),
  });
  expect(providers.entries).toContainEqual(
    expect.objectContaining({
      provider: FIXTURE_PROVIDER,
      label: "Workspace Runtime Fixture",
      status: "ready",
      models: [expect.objectContaining({ id: FIXTURE_MODEL })],
    }),
  );

  const agent = await client.createAgent({
    provider: FIXTURE_PROVIDER,
    model: FIXTURE_MODEL,
    cwd: workspace.cwd,
    workspaceId: workspace.id,
    title: `${workspace.kind} stdio fixture`,
  });
  await client.sendMessage(agent.id, `characterize ${workspace.kind}`);
  const finished = await client.waitForFinish(agent.id, 30_000);
  expect(finished.status).toBe("idle");
  const agentRead = await client.readFile(
    workspace.cwd,
    "stdio-agent-output.txt",
    undefined,
    workspace.id,
  );
  expect(new TextDecoder().decode(agentRead.bytes)).toBe(`characterize ${workspace.kind}\n`);
}

async function readWorkspaceTextFile(
  workspaceId: string,
  cwd: string,
  filePath: string,
): Promise<string> {
  const file = await client.readFile(cwd, filePath, undefined, workspaceId);
  return new TextDecoder().decode(file.bytes);
}

describe("current workspace runtime journeys", () => {
  test("local workspace uses the public daemon/client behavior", async () => {
    const workspace = await createCharacterizedWorkspace("local");
    try {
      const records = JSON.parse(
        readFileSync(path.join(daemon.paseoHome, "projects", "workspaces.json"), "utf8"),
      ) as Array<{ workspaceId: string; runtime?: { runtimeId: string } }>;
      expect(records.find((record) => record.workspaceId === workspace.id)?.runtime).toEqual({
        runtimeId: "local",
      });
      await expectFileEditAndWatch(workspace);
      await expectGitObservation(workspace);
      await expectTerminalCommand(workspace);
      await expectProviderDiscoveryAndAgentExecution(workspace);
      const archive = await client.archiveWorkspace(workspace.id);
      expect(archive.error).toBeNull();
      expect(existsSync(workspace.cwd)).toBe(true);
      expect(readFileSync(path.join(workspace.cwd, "characterized.txt"), "utf8")).toBe("after\n");
      await client.restoreWorkspace(workspace.id);
      const removal = await client.removeProject(workspace.projectId);
      expect(removal.removedWorkspaceIds).toContain(workspace.id);
      expect(existsSync(workspace.cwd)).toBe(true);
    } finally {
      await client.removeProject(workspace.projectId).catch(() => undefined);
    }
  }, 120_000);

  test("owned worktree runs setup and uses the same public daemon/client behavior", async () => {
    const workspace = await createCharacterizedWorkspace("worktree");
    try {
      const records = JSON.parse(
        readFileSync(path.join(daemon.paseoHome, "projects", "workspaces.json"), "utf8"),
      ) as Array<{ workspaceId: string; runtime?: { runtimeId: string } }>;
      expect(records.find((record) => record.workspaceId === workspace.id)?.runtime).toEqual({
        runtimeId: "worktree",
      });
      await expect
        .poll(() => client.fetchWorkspaceSetupStatus(workspace.id), { timeout: 30_000 })
        .toMatchObject({ snapshot: { status: "completed", error: null } });
      await expect(
        readWorkspaceTextFile(workspace.id, workspace.cwd, "setup-output.txt"),
      ).resolves.toBe("setup complete\n");

      await expectFileEditAndWatch(workspace);
      await expectGitObservation(workspace);
      await expectTerminalCommand(workspace);
      await expectProviderDiscoveryAndAgentExecution(workspace);

      let resolveRestoredObservation!: () => void;
      const restoredObservation = new Promise<void>((resolve) => {
        resolveRestoredObservation = resolve;
      });
      const restoredSubscription = await client.subscribeFile(
        { cwd: workspace.cwd, path: "characterized.txt", workspaceId: workspace.id },
        (version) => {
          if (version.status === "ready") resolveRestoredObservation();
        },
      );
      if (restoredSubscription.initial.status !== "ready") {
        throw new Error("Expected characterized.txt before archive");
      }

      const archive = await client.archiveWorkspace(workspace.id);
      expect(archive.error).toBeNull();
      expect(existsSync(workspace.cwd)).toBe(true);
      expect(readFileSync(path.join(workspace.cwd, "characterized.txt"), "utf8")).toBe("after\n");

      await client.restoreWorkspace(workspace.id);
      const restoredWrite = await client.writeFile({
        cwd: workspace.cwd,
        path: "characterized.txt",
        content: "restored\n",
        expectedModifiedAt: restoredSubscription.initial.modifiedAt,
        expectedRevision: restoredSubscription.initial.revision,
        workspaceId: workspace.id,
      });
      expect(restoredWrite.status).toBe("written");
      await expect(restoredObservation).resolves.toBeUndefined();
      restoredSubscription.unsubscribe();
      expect(readFileSync(path.join(workspace.cwd, "characterized.txt"), "utf8")).toBe(
        "restored\n",
      );

      const removal = await client.removeProject(workspace.projectId);
      expect(removal.removedWorkspaceIds).toContain(workspace.id);
      expect(existsSync(workspace.cwd)).toBe(false);
    } finally {
      if (existsSync(workspace.cwd)) {
        await client.removeProject(workspace.projectId).catch(() => undefined);
      }
    }
  }, 120_000);
});

test("catalog selection creates through a configured runtime while omission remains local", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-runtime-selection-"));
  cleanupRoots.push(root);
  const repo = path.join(root, "repo");
  const stateDirectory = path.join(root, "fixture-state");
  mkdirSync(stateDirectory, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repo });
  writeFileSync(path.join(repo, "selection.txt"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo });
  const selectedDaemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    workspaceRuntimes: {
      fixture: {
        type: "command",
        label: "Fixture",
        command: [process.execPath, fixtureRuntimePath],
        helperCommand: [process.execPath, workspaceHelperPath],
        options: { stateDirectory },
      },
    },
  });
  const selectedClient = new DaemonClient({
    url: `ws://127.0.0.1:${selectedDaemon.port}/ws`,
    reconnect: { enabled: false },
  });
  try {
    await selectedClient.connect();
    await expect(selectedClient.listWorkspaceRuntimes()).resolves.toMatchObject({
      runtimes: [
        { runtimeId: "local", builtin: true, requiresGitProject: false },
        { runtimeId: "worktree", builtin: true, requiresGitProject: true },
        { runtimeId: "docker", builtin: true, requiresGitProject: true },
        {
          runtimeId: "fixture",
          builtin: false,
          label: "Fixture",
          requiresGitProject: true,
        },
      ],
    });
    const explicit = await selectedClient.createWorkspace({
      source: { kind: "directory", path: repo },
      runtimeId: "fixture",
    });
    const omitted = await selectedClient.createWorkspace({
      source: { kind: "directory", path: repo },
    });
    if (!explicit.workspace || !omitted.workspace) {
      throw new Error(explicit.error ?? omitted.error ?? "Workspace creation failed");
    }
    const records = JSON.parse(
      readFileSync(path.join(selectedDaemon.paseoHome, "projects", "workspaces.json"), "utf8"),
    ) as Array<{ workspaceId: string; runtime?: { runtimeId: string } }>;
    expect(
      records.find((record) => record.workspaceId === explicit.workspace?.id)?.runtime,
    ).toEqual({
      runtimeId: "fixture",
    });
    expect(records.find((record) => record.workspaceId === omitted.workspace?.id)?.runtime).toEqual(
      {
        runtimeId: "local",
      },
    );
  } finally {
    await selectedClient.close().catch(() => undefined);
    await selectedDaemon.close();
  }
});

test("selected worktree provider journey stays behind the public daemon and client boundary", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-runtime-selected-worktree-"));
  cleanupRoots.push(root);
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repo });
  writeFileSync(path.join(repo, "characterized.txt"), "before\n");
  copyFileSync(fixtureAgentPath, path.join(repo, "fixture-agent.mjs"));
  chmodSync(path.join(repo, "fixture-agent.mjs"), 0o755);
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"], {
    cwd: repo,
  });
  const paseoHomeRoot = path.join(root, "daemon-home");
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  mkdirSync(paseoHome, { recursive: true });
  const workspaceId = `selected-worktree-${Date.now()}`;
  let runtimeSelected = true;
  const seedRuntime = createWorkspaceRuntimeService({
    paseoHome,
    worktreesRoot: path.join(root, "worktrees"),
    resolveRuntimeId: async (id) => (id === workspaceId && runtimeSelected ? "worktree" : null),
    persistRuntimeId: async () => {
      runtimeSelected = true;
    },
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async () => {
      runtimeSelected = false;
    },
  });
  await seedRuntime.create({
    workspaceId,
    runtimeId: "worktree",
    project: { id: "selected-worktree-project", source: { kind: "host-directory", path: repo } },
    placement: {
      kind: "branch",
      branchName: "selected-worktree",
      baseRef: "main",
      worktreeSlug: workspaceId,
    },
  });
  const runtimeState = JSON.parse(
    readFileSync(
      path.join(
        paseoHome,
        "workspace-runtimes",
        "worktree",
        readdirSync(path.join(paseoHome, "workspace-runtimes", "worktree"))[0]!,
      ),
      "utf8",
    ),
  ) as { root: string };
  const seededProjectRegistry = new FileBackedProjectRegistry(
    path.join(paseoHome, "projects", "projects.json"),
    createTestLogger(),
  );
  const seededWorkspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(paseoHome, "projects", "workspaces.json"),
    createTestLogger(),
  );
  await seededProjectRegistry.initialize();
  await seededWorkspaceRegistry.initialize();
  const now = new Date().toISOString();
  await seededProjectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: "selected-worktree-project",
      rootPath: repo,
      kind: "git",
      displayName: "selected-worktree-project",
      createdAt: now,
      updatedAt: now,
    }),
  );
  await seededWorkspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "selected-worktree-project",
      cwd: runtimeState.root,
      kind: "worktree",
      displayName: "selected-worktree",
      branch: "selected-worktree",
      worktreeRoot: runtimeState.root,
      mainRepoRoot: repo,
      isPaseoOwnedWorktree: true,
      runtime: { runtimeId: "worktree" },
      createdAt: now,
      updatedAt: now,
    }),
  );
  const selectedDaemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    cleanup: false,
    mcpEnabled: false,
    providerOverrides: {
      [FIXTURE_PROVIDER]: {
        extends: "acp",
        label: "Workspace Runtime Fixture",
        command: [path.join(runtimeState.root, "fixture-agent.mjs")],
        params: { supportsMcpServers: false },
        enabled: true,
      },
    },
  });
  const selectedClient = new DaemonClient({
    url: `ws://127.0.0.1:${selectedDaemon.port}/ws`,
    appVersion: "0.3.0-beta.2",
    reconnect: { enabled: false },
  });
  try {
    await selectedClient.connect();
    await selectedClient.fetchAgents({
      subscribe: { subscriptionId: "selected-worktree-agents" },
    });
    const snapshot = await selectedClient.getProvidersSnapshot({
      cwd: runtimeState.root,
      workspaceId,
    });
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        provider: FIXTURE_PROVIDER,
        status: "ready",
        models: [expect.objectContaining({ id: FIXTURE_MODEL })],
      }),
    );
    const agent = await selectedClient.createAgent({
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL,
      cwd: runtimeState.root,
      workspaceId,
      title: "selected worktree fixture",
    });
    await selectedClient.sendMessage(agent.id, "selected worktree edit");
    await expect(selectedClient.waitForFinish(agent.id, 30_000)).resolves.toMatchObject({
      status: "idle",
    });
    const edited = await selectedClient.readFile(
      runtimeState.root,
      "stdio-agent-output.txt",
      undefined,
      workspaceId,
    );
    expect(new TextDecoder().decode(edited.bytes)).toBe("selected worktree edit\n");
    await expect(
      selectedClient.bindWorkspaceGit({ workspaceId, cwd: runtimeState.root }).getStatus(),
    ).resolves.toMatchObject({ isGit: true, isDirty: true });
  } finally {
    await selectedClient.close().catch(() => undefined);
    await selectedDaemon.close();
    await seedRuntime.destroy(workspaceId);
  }
}, 120_000);
