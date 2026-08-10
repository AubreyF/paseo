import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileVersion } from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const FIXTURE_PROVIDER = "workspace-runtime-fixture";
const FIXTURE_MODEL = "fixture-model";
const fixtureAgentPath = fileURLToPath(
  new URL("../test-utils/fixtures/workspace-runtime-acp-agent.mjs", import.meta.url),
);

interface CharacterizedWorkspace {
  cwd: string;
  id: string;
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
  const listing = await client.listDirectory(workspace.cwd, ".");
  expect(listing.entries.map((entry) => entry.name)).toContain("characterized.txt");

  const initialRead = await client.readFile(workspace.cwd, "characterized.txt");
  expect(new TextDecoder().decode(initialRead.bytes)).toBe("before\n");

  let resolveUpdate!: (version: FileVersion) => void;
  const updated = new Promise<FileVersion>((resolve) => {
    resolveUpdate = resolve;
  });
  const fileSubscription = await client.subscribeFile(
    { cwd: workspace.cwd, path: "characterized.txt" },
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
  });
  expect(write).toMatchObject({ status: "written", size: 6 });
  await expect(updated).resolves.toMatchObject({ status: "ready", size: 6 });
  fileSubscription.unsubscribe();

  const writtenRead = await client.readFile(workspace.cwd, "characterized.txt");
  expect(new TextDecoder().decode(writtenRead.bytes)).toBe("after\n");
}

async function expectGitObservation(workspace: CharacterizedWorkspace): Promise<void> {
  await expect
    .poll(() => client.getCheckoutStatus(workspace.cwd), { timeout: 15_000 })
    .toMatchObject({
      isGit: true,
      isDirty: true,
    });
  const diff = await client.getCheckoutDiff(workspace.cwd, { mode: "uncommitted" });
  expect(diff.error).toBeNull();
  expect(diff.files).toContainEqual(
    expect.objectContaining({ path: "characterized.txt", status: "ok" }),
  );
}

async function expectTerminalCommand(workspace: CharacterizedWorkspace): Promise<void> {
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
  const command = "printf '%s%s\\n' runtime-terminal- ok";
  expect(command).not.toContain(marker);
  try {
    const terminalOutput = waitForTerminalOutput(terminalId, marker);
    await client.subscribeTerminal(terminalId);
    client.sendTerminalInput(terminalId, { type: "input", data: `${command}\r` });
    await expect(terminalOutput).resolves.toContain(marker);
  } finally {
    await client.killTerminal(terminalId);
  }
}

async function expectProviderDiscoveryAndAgentExecution(
  workspace: CharacterizedWorkspace,
): Promise<void> {
  await client.refreshProvidersSnapshot({ cwd: workspace.cwd, providers: [FIXTURE_PROVIDER] });
  const providers = await client.getProvidersSnapshot({ cwd: workspace.cwd });
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
  const agentRead = await client.readFile(workspace.cwd, "stdio-agent-output.txt");
  expect(new TextDecoder().decode(agentRead.bytes)).toBe(`characterize ${workspace.kind}\n`);
}

async function readWorkspaceTextFile(cwd: string, filePath: string): Promise<string> {
  const file = await client.readFile(cwd, filePath);
  return new TextDecoder().decode(file.bytes);
}

describe("current workspace runtime journeys", () => {
  test("local workspace uses the public daemon/client behavior", async () => {
    const workspace = await createCharacterizedWorkspace("local");
    try {
      await expectFileEditAndWatch(workspace);
      await expectGitObservation(workspace);
      await expectTerminalCommand(workspace);
      await expectProviderDiscoveryAndAgentExecution(workspace);
      const archive = await client.archiveWorkspace(workspace.id);
      expect(archive.error).toBeNull();
      expect(existsSync(workspace.cwd)).toBe(true);
      expect(readFileSync(path.join(workspace.cwd, "characterized.txt"), "utf8")).toBe("after\n");
    } finally {
      await client.archiveWorkspace(workspace.id).catch(() => undefined);
    }
  }, 120_000);

  test("owned worktree runs setup and uses the same public daemon/client behavior", async () => {
    const workspace = await createCharacterizedWorkspace("worktree");
    try {
      await expect
        .poll(() => client.fetchWorkspaceSetupStatus(workspace.id), { timeout: 30_000 })
        .toMatchObject({ snapshot: { status: "completed", error: null } });
      await expect(readWorkspaceTextFile(workspace.cwd, "setup-output.txt")).resolves.toBe(
        "setup complete\n",
      );

      await expectFileEditAndWatch(workspace);
      await expectGitObservation(workspace);
      await expectTerminalCommand(workspace);
      await expectProviderDiscoveryAndAgentExecution(workspace);

      const removal = await client.archivePaseoWorktree({
        worktreePath: workspace.cwd,
        workspaceId: workspace.id,
      });
      expect(removal).toMatchObject({ success: true, error: null });
      await expect.poll(() => existsSync(workspace.cwd), { timeout: 15_000 }).toBe(false);
    } finally {
      if (existsSync(workspace.cwd)) {
        await client
          .archivePaseoWorktree({ worktreePath: workspace.cwd, workspaceId: workspace.id })
          .catch(() => undefined);
      }
    }
  }, 120_000);
});
