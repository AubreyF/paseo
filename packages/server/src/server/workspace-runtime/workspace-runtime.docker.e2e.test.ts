import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, watch } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, expect, onTestFinished, test, vi } from "vitest";

import { createWorkspaceRuntimeService } from "./index.js";
import { WorkspaceGitServiceImpl } from "../workspace-git-service.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { allocateWorkspaceServicePort } from "../workspace-service-port-allocator.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";

const repositoryRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const dockerRuntimeRoot = path.join(repositoryRoot, "packages/docker-workspace-runtime");
const runtimeExecutable = path.join(dockerRuntimeRoot, "dist/index.js");
const image = "paseo-workspace-runtime-slice1:test";
const fixtureAgent = fileURLToPath(
  new URL("../test-utils/fixtures/workspace-runtime-acp-agent.mjs", import.meta.url),
);
const run = promisify(execFile);

beforeAll(() => {
  execFileSync(
    "docker",
    ["build", "-t", image, "-f", path.join(dockerRuntimeRoot, "Dockerfile"), repositoryRoot],
    { stdio: "pipe" },
  );
}, 120_000);

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

test("the command runtime owns Docker workspace materialization, pipes, and lifecycle", async () => {
  const fixture = await dockerTestFixture("paseo-runtime-docker-");
  const root = fixture.root;
  const repo = await createRepository(root);
  await writeFile(path.join(repo, ".env"), "must-not-enter-runtime\n");
  const runtimeIds = new Map<string, string>();
  const options = {
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (workspaceId: string) => runtimeIds.get(workspaceId) ?? null,
    persistRuntimeId: async (workspaceId: string, runtimeId: string) => {
      runtimeIds.set(workspaceId, runtimeId);
    },
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (workspaceId: string) => {
      runtimeIds.delete(workspaceId);
    },
    externalRuntimes: {
      docker: {
        type: "docker",
        image,
      },
    },
  };
  const service = createWorkspaceRuntimeService(options);
  const workspaceId = `docker-${Date.now()}`;
  fixture.workspace(workspaceId);

  try {
    const workspace = await service.create({
      workspaceId,
      runtimeId: "docker",
      project: {
        id: "docker-project",
        source: { kind: "host-directory", path: repo },
      },
      placement: { kind: "existing" },
    });

    expect(workspace).toEqual({ workspaceId, runtimeId: "docker", cwd: "/workspace" });
    await expect(service.inspect(workspaceId)).resolves.toEqual({
      status: "ready",
      cwd: "/workspace",
    });
    await expect(service.requireHostVisiblePath(workspaceId)).rejects.toThrow(
      `Workspace has no host-visible path: ${workspaceId}`,
    );

    for (const [name, value] of [
      ["user.email", "test@example.com"],
      ["user.name", "Paseo Test"],
    ] as const) {
      const configure = await service.run({
        workspaceId,
        argv: ["git", "config", name, value],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        purpose: { kind: "git" },
      });
      configure.stdin.end();
      await expect(configure.exited).resolves.toEqual({ code: 0, signal: null });
    }

    const workspaceGitService = new WorkspaceGitServiceImpl({
      logger: createLogger(),
      paseoHome: options.paseoHome,
      workspaceRuntime: service,
    });
    const workspaceGit = workspaceGitService.bindWorkspace({ workspaceId, cwd: repo });

    const files = service.files(workspaceId);
    const listing = await files.list(".");
    expect(listing.entries.map((entry) => entry.name)).toContain("committed.txt");
    const initialFile = await files.stat("committed.txt");
    expect(initialFile).toMatchObject({ status: "ready", size: 10 });
    let resolveFileChange!: () => void;
    const fileChanged = new Promise<void>((resolve) => {
      resolveFileChange = resolve;
    });
    const fileSubscription = await files.subscribe({ paths: ["committed.txt"] }, (event) => {
      if (event.type === "changed" && event.paths.includes("committed.txt")) resolveFileChange();
    });
    const terminalFileEdit = await service.run({
      workspaceId,
      argv: ["/bin/sh", "-c", "printf container-change > committed.txt"],
      env: {},
      purpose: { kind: "terminal", terminalId: "docker-file-edit" },
    });
    terminalFileEdit.stdin.end();
    await expect(terminalFileEdit.exited).resolves.toEqual({ code: 0, signal: null });
    await expect(fileChanged).resolves.toBeUndefined();
    const dirtyGit = await workspaceGit.getSnapshot({
      force: true,
      includeForge: false,
      reason: "docker-edit",
    });
    const dockerDiff = await workspaceGit.getCheckoutDiff(
      { mode: "uncommitted", includeStructured: true },
      { force: true, reason: "docker-edit" },
    );
    expect(dirtyGit.git).toMatchObject({ isGit: true, isDirty: true, currentBranch: "main" });
    expect(JSON.stringify(dockerDiff)).toContain("container-change");
    await workspaceGit.commit({ message: "container commit", addAll: true });
    await workspaceGit.createBranch({ branch: "container-branch", baseRef: "main" });
    await workspaceGit.switchBranch("main");
    await workspaceGit.fetch();
    const cleanGit = await workspaceGit.getSnapshot();
    expect(cleanGit.git).toMatchObject({ isDirty: false, currentBranch: "main" });
    expect(await readFileFromHost(repo, "committed.txt")).toBe("committed\n");
    const containerFile = await files.read("committed.txt");
    await expect(collect(containerFile.chunks)).resolves.toBe("container-change");
    const conflict = await files.write({
      path: "committed.txt",
      contents: Buffer.from("stale"),
      ...(initialFile.status === "ready" ? { expectedRevision: initialFile.revision } : {}),
    });
    expect(conflict).toMatchObject({ status: "conflict" });
    const large = await files.read("large.bin");
    expect(await collectBytes(large.chunks)).toEqual(Buffer.alloc(700_000, 0xa5));
    await expect(files.read("outside-link")).rejects.toThrow(
      "Access outside of workspace is not allowed",
    );
    await fileSubscription.unsubscribe();

    const write = await service.run({
      workspaceId,
      argv: ["/bin/sh", "-c", "cat > runtime-owned.txt; printf runtime-stderr >&2; exit 19"],
      env: {},
      purpose: { kind: "workspace-script", script: "write-contract" },
    });
    write.stdin.end("docker-state");
    const [stderr, writeExit] = await Promise.all([collect(write.stderr), write.exited]);
    expect(stderr).toBe("runtime-stderr");
    expect(writeExit).toEqual({ code: 19, signal: null });

    const env = await service.run({
      workspaceId,
      argv: ["/usr/bin/env"],
      env: { RUNTIME_EXACT_ENV: "docker" },
      purpose: { kind: "workspace-script", script: "environment-contract" },
    });
    env.stdin.end();
    await expect(collect(env.stdout)).resolves.toBe("RUNTIME_EXACT_ENV=docker\n");
    await expect(env.exited).resolves.toEqual({ code: 0, signal: null });

    await service.pause(workspaceId);
    await expect(
      service.run({
        workspaceId,
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "paused-contract" },
      }),
    ).rejects.toThrow(`Workspace runtime is paused: ${workspaceId}`);

    const recovered = createWorkspaceRuntimeService(options);
    await recovered.resume(workspaceId);
    const escapedCwd = await recovered.run({
      workspaceId,
      cwd: "../escape",
      argv: ["/bin/true"],
      env: {},
      purpose: { kind: "workspace-script", script: "cwd-contract" },
    });
    escapedCwd.stdin.end();
    await expect(escapedCwd.exited).rejects.toThrow("Workspace cwd escapes its root");
    const read = await recovered.run({
      workspaceId,
      argv: ["/bin/cat", "runtime-owned.txt"],
      env: {},
      purpose: { kind: "workspace-script", script: "read-contract" },
    });
    read.stdin.end();
    await expect(collect(read.stdout)).resolves.toBe("docker-state");
    await expect(read.exited).resolves.toEqual({ code: 0, signal: null });

    const terminal = await recovered.openTerminal({
      workspaceId,
      argv: [
        "/usr/local/bin/node",
        "-e",
        "process.stdin.setEncoding('utf8');process.stdout.write(`${process.cwd()}|${process.stdout.isTTY}|${process.stdout.columns}x${process.stdout.rows}|λ`);process.stdin.once('data',data=>{process.stdout.write(`|${data.trim()}|${process.stdout.columns}x${process.stdout.rows}`);process.exit(6)})",
      ],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      purpose: { kind: "terminal", terminalId: "docker-contract-terminal" },
      rows: 24,
      cols: 80,
    });
    let terminalOutput = "";
    terminal.onData((data) => {
      terminalOutput += data;
    });
    await Promise.race([
      vi.waitFor(() => expect(terminalOutput).toContain("/workspace|true|80x24|λ"), {
        timeout: 10_000,
      }),
      terminal.exited.then((exit) => {
        throw new Error(`Docker PTY exited before initial output: ${JSON.stringify(exit)}`);
      }),
    ]);
    terminal.resize(103, 39);
    terminal.write("héllo\n");
    await expect(terminal.exited).resolves.toEqual({ code: 6, signal: null });
    expect(terminalOutput).toContain("|héllo|103x39");

    const terminalSignal = await recovered.openTerminal({
      workspaceId,
      argv: ["/bin/sleep", "30"],
      env: { PATH: "/usr/bin:/bin" },
      purpose: { kind: "terminal", terminalId: "docker-signal-terminal" },
      rows: 24,
      cols: 80,
    });
    terminalSignal.kill("SIGTERM");
    await expect(terminalSignal.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
    await vi.waitFor(() => expect(dockerProcesses(workspaceId)).not.toContain("sleep 30"));

    const terminalForced = await recovered.openTerminal({
      workspaceId,
      argv: ["/bin/sleep", "30"],
      env: { PATH: "/usr/bin:/bin" },
      purpose: { kind: "terminal", terminalId: "docker-force-terminal" },
      rows: 24,
      cols: 80,
    });
    terminalForced.kill("SIGKILL");
    await expect(terminalForced.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
    await vi.waitFor(() => expect(dockerProcesses(workspaceId)).not.toContain("sleep 30"));

    const terminalControlFailure = await recovered.openTerminal({
      workspaceId,
      argv: ["/bin/sleep", "30"],
      env: { PATH: "/usr/bin:/bin" },
      purpose: { kind: "terminal", terminalId: "docker-control-failure-terminal" },
      rows: 24,
      cols: 80,
    });
    terminalControlFailure.kill("SIGUSR1");
    await expect(terminalControlFailure.exited).rejects.toThrow("Unsupported signal: SIGUSR1");
    expect(dockerProcesses(workspaceId)).not.toContain("sleep 30");

    const committedOnly = await recovered.run({
      workspaceId,
      argv: ["/bin/sh", "-c", "test ! -e .env"],
      env: {},
      purpose: { kind: "workspace-script", script: "materialization-contract" },
    });
    committedOnly.stdin.end();
    await expect(committedOnly.exited).resolves.toEqual({ code: 0, signal: null });
    expect(execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" })).toBe(
      "?? .env\n",
    );

    const killed = await recovered.run({
      workspaceId,
      argv: ["/bin/sh", "-c", "sleep 30 & echo ready; wait"],
      env: { PATH: "/usr/bin:/bin" },
      purpose: { kind: "workspace-script", script: "signal-contract" },
    });
    killed.stdin.end();
    await expect(waitForOutput(killed.stdout, "ready")).resolves.toContain("ready");
    const killedAt = Date.now();
    killed.kill("SIGTERM");
    await expect(killed.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
    expect(Date.now() - killedAt).toBeLessThan(5_000);
    await vi.waitFor(() => expect(dockerProcesses(workspaceId)).not.toContain("sleep 30"));

    const stubborn = await recovered.run({
      workspaceId,
      argv: [
        "/usr/local/bin/node",
        "-e",
        "process.on('SIGTERM',()=>{});console.log('stubborn-ready');setInterval(()=>{},1000)",
      ],
      env: {},
      purpose: { kind: "workspace-script", script: "escalation-contract" },
    });
    stubborn.stdin.end();
    await expect(waitForOutput(stubborn.stdout, "stubborn-ready")).resolves.toContain(
      "stubborn-ready",
    );
    const pauseStartedAt = Date.now();
    await recovered.pause(workspaceId);
    expect(Date.now() - pauseStartedAt).toBeLessThan(5_000);
    await expect(stubborn.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
    expect(
      execFileSync(
        "docker",
        ["inspect", "--format", "{{.State.Running}}", dockerResourceName(workspaceId)],
        {
          encoding: "utf8",
        },
      ).trim(),
    ).toBe("false");

    await workspaceGitService.dispose();
    await recovered.destroy(workspaceId);
    expect(dockerResourceCount("ps", workspaceId)).toBe(0);
    expect(dockerResourceCount("volume", workspaceId)).toBe(0);
    expect(await readFileFromHost(repo, "runtime-owned.txt")).toBeNull();
    await expect(
      recovered.run({
        workspaceId,
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "missing-contract" },
      }),
    ).rejects.toThrow(`Workspace runtime is not selected: ${workspaceId}`);
  } finally {
    await service.destroy(workspaceId).catch(() => undefined);
  }
}, 180_000);

test("Docker buffers immediate pipe signals until the workload identity is authoritative", async () => {
  const fixture = await dockerTestFixture("paseo-runtime-docker-started-");
  const root = fixture.root;
  const repo = await createRepository(root);
  const workspaceId = `docker-started-${Date.now()}`;
  fixture.workspace(workspaceId);
  const runtimeIds = new Map<string, string>();
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => {
      runtimeIds.delete(id);
    },
    externalRuntimes: {
      docker: {
        type: "docker",
        image,
      },
    },
  });
  const originalPath = process.env.PATH;
  const originalBarrier = process.env.PASEO_DOCKER_TEST_BARRIER;

  try {
    await service.create({
      workspaceId,
      runtimeId: "docker",
      project: { id: "started-project", source: { kind: "host-directory", path: repo } },
      placement: { kind: "existing" },
    });
    const shimDirectory = path.join(root, "docker-shim");
    await mkdir(shimDirectory);
    const realDocker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
    const shim = path.join(shimDirectory, "docker");
    await writeFile(shim, dockerBarrierShim(realDocker));
    await chmod(shim, 0o755);
    process.env.PATH = `${shimDirectory}:${originalPath ?? ""}`;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const barrier = path.join(root, `barrier-${attempt}`);
      await mkdir(barrier);
      process.env.PASEO_DOCKER_TEST_BARRIER = barrier;
      const entered = nextFile(barrier, "entered");
      const workload = await service.run({
        workspaceId,
        argv: ["/bin/sleep", "3"],
        env: { PATH: "/usr/bin:/bin" },
        purpose: { kind: "workspace-script", script: `immediate-signal-${attempt}` },
      });
      workload.stdin.end();
      await entered;
      const killedAt = Date.now();
      workload.kill("SIGTERM");
      await writeFile(path.join(barrier, "release"), "release");

      await expect(workload.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
      expect(Date.now() - killedAt).toBeLessThan(1_500);
      expect(dockerProcesses(workspaceId)).not.toContain("sleep 3");
    }

    const shortBarrier = path.join(root, "barrier-short-exit");
    await mkdir(shortBarrier);
    process.env.PASEO_DOCKER_TEST_BARRIER = shortBarrier;
    const shortEntered = nextFile(shortBarrier, "entered");
    const short = await service.run({
      workspaceId,
      argv: ["/bin/true"],
      env: {},
      purpose: { kind: "workspace-script", script: "exit-around-started" },
    });
    short.stdin.end();
    await shortEntered;
    await writeFile(path.join(shortBarrier, "release"), "release");
    await expect(short.exited).resolves.toEqual({ code: 0, signal: null });

    delete process.env.PASEO_DOCKER_TEST_BARRIER;
    const later = await service.run({
      workspaceId,
      argv: ["/bin/true"],
      env: {},
      purpose: { kind: "workspace-script", script: "after-immediate-signals" },
    });
    later.stdin.end();
    await expect(later.exited).resolves.toEqual({ code: 0, signal: null });
  } finally {
    process.env.PATH = originalPath;
    if (originalBarrier === undefined) delete process.env.PASEO_DOCKER_TEST_BARRIER;
    else process.env.PASEO_DOCKER_TEST_BARRIER = originalBarrier;
    await service.destroy(workspaceId).catch(() => undefined);
  }
}, 120_000);

test("a selected Docker service port script executes in the container and leaves the host decoy untouched", async () => {
  const fixture = await dockerTestFixture("paseo-runtime-docker-port-script-");
  const root = fixture.root;
  const repo = await createRepository(root);
  const script = path.join(repo, "port-script.sh");
  await writeFile(
    script,
    "#!/bin/sh\nprintf runtime > runtime-port-script.txt\nprintf '41234\\n'\n",
  );
  await chmod(script, 0o755);
  execFileSync("git", ["add", "port-script.sh"], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "port script"], {
    cwd: repo,
  });
  const workspaceId = `docker-port-script-${Date.now()}`;
  fixture.workspace(workspaceId);
  const runtimeIds = new Map<string, string>();
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => {
      runtimeIds.delete(id);
    },
    externalRuntimes: {
      docker: {
        type: "docker",
        image,
      },
    },
  });
  try {
    await service.create({
      workspaceId,
      runtimeId: "docker",
      project: { id: "docker-port-project", source: { kind: "host-directory", path: repo } },
      placement: { kind: "existing" },
    });
    await writeFile(script, "#!/bin/sh\nprintf host > host-port-script.txt\nprintf '49999\\n'\n");

    await expect(
      allocateWorkspaceServicePort({
        allocation: { portScript: "./port-script.sh" },
        cwd: repo,
        scriptName: "web",
        workspaceId,
        branchName: null,
        runtime: await service.bind(workspaceId),
      }),
    ).resolves.toBe(41234);
    await expect(service.files(workspaceId).stat("runtime-port-script.txt")).resolves.toMatchObject(
      {
        status: "ready",
      },
    );
    await expect(readFile(path.join(repo, "host-port-script.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await service.destroy(workspaceId).catch(() => undefined);
  }
}, 120_000);

test("public daemon and client keep Docker provider discovery, launch, files, Git, and snapshots in one runtime", async () => {
  const fixture = await dockerTestFixture("paseo-runtime-docker-daemon-");
  const root = fixture.root;
  const repo = await createRepository(root);
  await writeFile(path.join(repo, "provider-model.txt"), "fixture-model-v1\n");
  execFileSync("git", ["add", "provider-model.txt"], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "provider model"], {
    cwd: repo,
  });
  const paseoHomeRoot = path.join(root, "daemon-home");
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  const runtimeConfig = { type: "docker" as const, image };
  const configuredRuntimeConfig = {
    type: "command" as const,
    command: [process.execPath, runtimeExecutable] as const,
    options: { image },
    providerEnvironment: { PASEO_DAEMON_ONLY_PROVIDER_ENV: "runtime-configured" },
  };
  const runtimeConfigs = { docker: runtimeConfig, "docker-configured": configuredRuntimeConfig };
  const workspaceIds = [`docker-daemon-a-${Date.now()}`, `docker-daemon-b-${Date.now()}`];
  for (const workspaceId of workspaceIds) fixture.workspace(workspaceId);
  const hostProbeMarker = path.join(root, "host-provider-probed.txt");
  const hostOnlyProvider = path.join(root, "host-only-provider.mjs");
  await writeFile(
    hostOnlyProvider,
    `#!/usr/bin/env node\nawait import("node:fs/promises").then((fs) => fs.appendFile(${JSON.stringify(hostProbeMarker)}, \`${"${process.cwd()}"}\\n\`));\n${(await readFile(fixtureAgent, "utf8")).replace(/^#![^\n]*\n/u, "")}`,
  );
  await chmod(hostOnlyProvider, 0o755);
  const selectedRuntimeIds = new Map([
    [workspaceIds[0]!, "docker"],
    [workspaceIds[1]!, "docker-configured"],
  ]);
  const seedRuntime = createWorkspaceRuntimeService({
    paseoHome,
    externalRuntimes: runtimeConfigs,
    resolveRuntimeId: async (workspaceId) => selectedRuntimeIds.get(workspaceId) ?? null,
    persistRuntimeId: async (workspaceId, runtimeId) => {
      selectedRuntimeIds.set(workspaceId, runtimeId);
    },
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (workspaceId) => {
      selectedRuntimeIds.delete(workspaceId);
    },
  });
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(paseoHome, "projects", "projects.json"),
    createTestLogger(),
  );
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(paseoHome, "projects", "workspaces.json"),
    createTestLogger(),
  );
  await projectRegistry.initialize();
  await workspaceRegistry.initialize();
  const now = new Date().toISOString();
  await projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: "docker-daemon-project",
      rootPath: repo,
      kind: "git",
      displayName: "docker-daemon-project",
      createdAt: now,
      updatedAt: now,
    }),
  );
  for (const workspaceId of workspaceIds) {
    const runtimeId = selectedRuntimeIds.get(workspaceId)!;
    await seedRuntime.create({
      workspaceId,
      runtimeId,
      project: { id: "docker-daemon-project", source: { kind: "host-directory", path: repo } },
      placement: { kind: "existing" },
    });
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId,
        projectId: "docker-daemon-project",
        cwd: repo,
        kind: "local_checkout",
        displayName: workspaceId,
        runtime: { runtimeId },
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    cleanup: false,
    mcpEnabled: false,
    agentClients: {},
    workspaceRuntimes: runtimeConfigs,
    providerOverrides: {
      "docker-fixture": {
        extends: "acp",
        label: "Docker Fixture",
        command: ["node", "./fixture-agent.mjs"],
        params: { supportsMcpServers: false },
        enabled: true,
      },
      "host-only-fixture": {
        extends: "acp",
        label: "Host Only",
        command: [hostOnlyProvider],
        params: { supportsMcpServers: false },
        enabled: true,
      },
    },
  });
  const publicClient = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.3.0-beta.2",
    reconnect: { enabled: false },
  });

  try {
    await publicClient.connect();
    await publicClient.fetchAgents({ subscribe: { subscriptionId: "docker-runtime-agents" } });
    const recoveredRegistry = new FileBackedWorkspaceRegistry(
      path.join(paseoHome, "projects", "workspaces.json"),
      createTestLogger(),
    );
    await recoveredRegistry.initialize();
    const recoveredRecords = await recoveredRegistry.list();
    const publicCwds = new Map(
      recoveredRecords
        .filter((workspace) => workspaceIds.includes(workspace.workspaceId))
        .map((workspace) => [workspace.workspaceId, workspace.cwd]),
    );
    expect(Array.from(publicCwds.values())).toEqual(["/workspace", "/workspace"]);
    expect(
      recoveredRecords
        .filter((workspace) => workspaceIds.includes(workspace.workspaceId))
        .map((workspace) => workspace.hostVisiblePath),
    ).toEqual([null, null]);
    for (const workspaceId of workspaceIds) {
      const cwd = publicCwds.get(workspaceId)!;
      const snapshot = await publicClient.getProvidersSnapshot({ cwd, workspaceId });
      expect(snapshot.entries).toContainEqual(
        expect.objectContaining({
          provider: "docker-fixture",
          status: "ready",
          models: [expect.objectContaining({ id: "fixture-model-v1" })],
        }),
      );
      expect(snapshot.entries).toContainEqual(
        expect.objectContaining({ provider: "host-only-fixture", status: "unavailable" }),
      );
      expect(snapshot.entries).toContainEqual(
        expect.objectContaining({ provider: "opencode", status: "unavailable" }),
      );
      const hostProbeCwds = (await readFileFromHost(root, "host-provider-probed.txt"))
        ?.trim()
        .split("\n");
      expect(hostProbeCwds).not.toContain(repo);
    }

    const workspaceId = workspaceIds[0]!;
    const cwd = publicCwds.get(workspaceId)!;
    const workspaceGit = publicClient.bindWorkspaceGit({ workspaceId, cwd });
    await expect(workspaceGit.getStatus()).resolves.toMatchObject({
      isGit: true,
      isDirty: false,
    });
    const agent = await publicClient.createAgent({
      provider: "docker-fixture",
      model: "fixture-model-v1",
      cwd,
      workspaceId,
      title: "Docker public fake provider",
    });
    await publicClient.sendMessage(agent.id, "public docker edit");
    await expect(publicClient.waitForFinish(agent.id, 30_000)).resolves.toMatchObject({
      status: "idle",
    });
    const edited = await publicClient.readFile(
      cwd,
      "stdio-agent-output.txt",
      undefined,
      workspaceId,
    );
    expect(new TextDecoder().decode(edited.bytes)).toBe("public docker edit\n");
    const editedTrackedFile = await publicClient.readFile(
      cwd,
      "committed.txt",
      undefined,
      workspaceId,
    );
    expect(new TextDecoder().decode(editedTrackedFile.bytes)).toBe("public docker edit\n");
    const dirtyDiff = await workspaceGit.getDiff({ mode: "uncommitted" });
    expect(dirtyDiff.files.map((file) => file.path)).toContain("committed.txt");
    const isolatedEnvironment = await publicClient.readFile(
      cwd,
      "stdio-agent-env.txt",
      undefined,
      workspaceId,
    );
    expect(new TextDecoder().decode(isolatedEnvironment.bytes)).toBe("<absent>\n");

    const configuredAgent = await publicClient.createAgent({
      provider: "docker-fixture",
      model: "fixture-model-v1",
      cwd: publicCwds.get(workspaceIds[1]!)!,
      workspaceId: workspaceIds[1],
      title: "Configured Docker public fake provider",
    });
    await publicClient.sendMessage(configuredAgent.id, "configured public docker edit");
    await expect(publicClient.waitForFinish(configuredAgent.id, 30_000)).resolves.toMatchObject({
      status: "idle",
    });
    const configuredEnvironment = await publicClient.readFile(
      publicCwds.get(workspaceIds[1]!)!,
      "stdio-agent-env.txt",
      undefined,
      workspaceIds[1],
    );
    expect(new TextDecoder().decode(configuredEnvironment.bytes)).toBe("runtime-configured\n");

    await seedRuntime.destroy(workspaceId);
    await writeFile(path.join(repo, "provider-model.txt"), "fixture-model-v2\n");
    execFileSync("git", ["add", "provider-model.txt"], { cwd: repo });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "provider model v2"], {
      cwd: repo,
    });
    await seedRuntime.create({
      workspaceId,
      runtimeId: "docker",
      project: { id: "docker-daemon-project", source: { kind: "host-directory", path: repo } },
      placement: { kind: "existing" },
    });

    const rebuiltA = await publicClient.getProvidersSnapshot({ cwd, workspaceId });
    expect(rebuiltA.entries).toContainEqual(
      expect.objectContaining({
        provider: "docker-fixture",
        models: [expect.objectContaining({ id: "fixture-model-v2" })],
      }),
    );
    const unchangedB = await publicClient.getProvidersSnapshot({
      cwd: publicCwds.get(workspaceIds[1]!)!,
      workspaceId: workspaceIds[1],
    });
    expect(unchangedB.entries).toContainEqual(
      expect.objectContaining({
        provider: "docker-fixture",
        models: [expect.objectContaining({ id: "fixture-model-v1" })],
      }),
    );
  } finally {
    await publicClient.close().catch(() => undefined);
    await daemon.close();
    await Promise.all(workspaceIds.map((workspaceId) => seedRuntime.destroy(workspaceId)));
  }
}, 180_000);

test("Docker creation validates roots and rolls back when runtime selection cannot persist", async () => {
  const fixture = await dockerTestFixture("paseo-runtime-docker-rollback-");
  const root = fixture.root;
  const repo = await createRepository(root);
  const workspaceId = `docker-rollback-${Date.now()}`;
  fixture.workspace(workspaceId);
  fixture.workspace(`${workspaceId}-escape`);
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async () => null,
    persistRuntimeId: async () => {
      throw new Error("persistence failed");
    },
    externalRuntimes: {
      docker: {
        type: "docker",
        image,
      },
    },
  });
  await expect(
    service.create({
      workspaceId: `${workspaceId}-escape`,
      runtimeId: "docker",
      project: { id: "docker-project", source: { kind: "host-directory", path: repo } },
      placement: { kind: "existing", relativeCwd: "../escape" },
    }),
  ).rejects.toThrow("Workspace cwd escapes its root");
  expect(dockerResourceCount("ps", `${workspaceId}-escape`)).toBe(0);
  expect(dockerResourceCount("volume", `${workspaceId}-escape`)).toBe(0);

  await expect(
    service.create({
      workspaceId,
      runtimeId: "docker",
      project: { id: "docker-project", source: { kind: "host-directory", path: repo } },
      placement: { kind: "existing" },
    }),
  ).rejects.toThrow("persistence failed");
  expect(dockerResourceCount("ps", workspaceId)).toBe(0);
  expect(dockerResourceCount("volume", workspaceId)).toBe(0);
}, 120_000);

test("Docker rejects a committed symlink cwd that resolves outside the selected root", async () => {
  const fixture = await dockerTestFixture("paseo-runtime-docker-symlink-");
  const root = fixture.root;
  const repo = await createRepository(root);
  await mkdir(path.join(repo, "selected"));
  await symlink("..", path.join(repo, "selected", "escape"));
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "symlink fixture"], {
    cwd: repo,
  });
  const workspaceId = `docker-symlink-${Date.now()}`;
  fixture.workspace(workspaceId);
  const runtimeIds = new Map<string, string>();
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => {
      runtimeIds.delete(id);
    },
    externalRuntimes: {
      docker: {
        type: "docker",
        image,
      },
    },
  });

  try {
    await service.create({
      workspaceId,
      runtimeId: "docker",
      project: { id: "symlink-project", source: { kind: "host-directory", path: repo } },
      placement: { kind: "existing", relativeCwd: "selected" },
    });
    const escaped = await service.run({
      workspaceId,
      cwd: "escape",
      argv: ["/bin/sh", "-c", "touch escaped-marker"],
      env: {},
      purpose: { kind: "workspace-script", script: "realpath-confinement" },
    });
    escaped.stdin.end();
    const escapedError = collect(escaped.stderr);
    await expect(escaped.exited).rejects.toThrow("Workspace cwd escapes its root");
    expect(await escapedError).toContain("Workspace cwd escapes its root");
    const verify = await service.run({
      workspaceId,
      argv: ["/bin/sh", "-c", "test ! -e ../escaped-marker"],
      env: {},
      purpose: { kind: "workspace-script", script: "realpath-confinement-proof" },
    });
    verify.stdin.end();
    await expect(verify.exited).resolves.toEqual({ code: 0, signal: null });
  } finally {
    await service.destroy(workspaceId).catch(() => undefined);
  }
}, 120_000);

test("the Docker runtime never adopts or destroys an unowned deterministic resource", async () => {
  const fixture = await dockerTestFixture("paseo-runtime-docker-ownership-");
  const root = fixture.root;
  const workspaceId = `docker-ownership-${Date.now()}`;
  const volume = dockerResourceName(workspaceId);
  fixture.workspace(workspaceId);
  execFileSync("docker", ["volume", "create", volume]);
  const runtimeIds = new Map([[workspaceId, "docker"]]);
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => {
      runtimeIds.delete(id);
    },
    externalRuntimes: {
      docker: {
        type: "docker",
        image,
      },
    },
  });

  try {
    await expect(
      service.create({
        workspaceId,
        runtimeId: "docker",
        project: { id: "ownership-project", source: { kind: "host-directory", path: root } },
        placement: { kind: "existing" },
      }),
    ).rejects.toThrow(`Docker volume ownership mismatch: ${volume}`);
    await expect(service.destroy(workspaceId)).rejects.toThrow(
      `Docker volume ownership mismatch: ${volume}`,
    );
    expect(
      execFileSync("docker", ["volume", "inspect", "--format", "{{.Name}}", volume], {
        encoding: "utf8",
      }).trim(),
    ).toBe(volume);
  } finally {
    execFileSync("docker", ["volume", "rm", volume]);
  }
}, 30_000);

test("Docker reconciliation removes only orphaned resources with deterministic names and ownership labels", async () => {
  const fixture = await dockerTestFixture("paseo-runtime-docker-reconcile-");
  const root = fixture.root;
  const orphanWorkspaceId = `docker-orphan-${Date.now()}`;
  const foreignWorkspaceId = `${orphanWorkspaceId}-foreign`;
  const orphanVolume = dockerResourceName(orphanWorkspaceId);
  const foreignVolume = `${dockerResourceName(foreignWorkspaceId)}-foreign`;
  fixture.volume(orphanVolume);
  fixture.volume(foreignVolume);
  execFileSync("docker", [
    "volume",
    "create",
    "--label",
    "sh.paseo.runtime=workspace",
    "--label",
    `sh.paseo.workspace-id=${orphanWorkspaceId}`,
    orphanVolume,
  ]);
  execFileSync("docker", [
    "volume",
    "create",
    "--label",
    "sh.paseo.runtime=workspace",
    "--label",
    `sh.paseo.workspace-id=${foreignWorkspaceId}`,
    foreignVolume,
  ]);
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async () => null,
    persistRuntimeId: async () => undefined,
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async () => {},
    listRuntimeRecords: async () => [],
    externalRuntimes: {
      docker: {
        type: "docker",
        image,
      },
    },
  });

  try {
    await service.reconcile();
    expect(dockerResourceCount("volume", orphanWorkspaceId)).toBe(0);
    expect(
      execFileSync("docker", ["volume", "inspect", "--format", "{{.Name}}", foreignVolume], {
        encoding: "utf8",
      }).trim(),
    ).toBe(foreignVolume);
  } finally {
    execFileSync("docker", ["volume", "rm", "-f", orphanVolume, foreignVolume], {
      stdio: "ignore",
    });
  }
}, 30_000);

async function dockerTestFixture(prefix: string): Promise<{
  root: string;
  workspace(workspaceId: string): void;
  volume(name: string): void;
}> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const containers = new Set<string>();
  const volumes = new Set<string>();
  const workspaceIds = new Set<string>();
  onTestFinished(async () => {
    await Promise.all(
      [...containers].map((name) =>
        run("docker", ["rm", "-f", name], { timeout: 10_000 }).catch(() => undefined),
      ),
    );
    await Promise.all(
      [...volumes].map((name) =>
        run("docker", ["volume", "rm", "-f", name], { timeout: 10_000 }).catch(() => undefined),
      ),
    );
    const leakedContainers = [...containers].filter((name) =>
      dockerResourceExists("container", name),
    );
    const leakedVolumes = [...volumes].filter((name) => dockerResourceExists("volume", name));
    const runningProcesses = dockerTestProcessPids(workspaceIds);
    if (runningProcesses.length > 0) {
      await run("kill", ["-KILL", ...runningProcesses.map(String)], { timeout: 5_000 }).catch(
        () => undefined,
      );
    }
    const leakedProcesses = dockerTestProcessPids(workspaceIds);
    await rm(root, { recursive: true, force: true });
    if (leakedContainers.length || leakedVolumes.length || leakedProcesses.length) {
      throw new Error(
        `Docker test leaked containers=${leakedContainers.join(",")} volumes=${leakedVolumes.join(",")} processes=${leakedProcesses.join(",")}`,
      );
    }
  }, 30_000);
  return {
    root,
    workspace(workspaceId) {
      workspaceIds.add(workspaceId);
      const name = dockerResourceName(workspaceId);
      containers.add(name);
      volumes.add(name);
    },
    volume(name) {
      volumes.add(name);
    },
  };
}

function dockerResourceExists(kind: "container" | "volume", name: string): boolean {
  try {
    execFileSync("docker", [kind, "inspect", name], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function dockerTestProcessPids(workspaceIds: ReadonlySet<string>): number[] {
  if (workspaceIds.size === 0) return [];
  const output = execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const needles = [...workspaceIds].flatMap((workspaceId) => [
    dockerResourceName(workspaceId),
    `--workspace-id ${workspaceId}`,
  ]);
  return output
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter(
      (match): match is RegExpMatchArray =>
        !!match && needles.some((needle) => match[2]!.includes(needle)),
    )
    .map((match) => Number(match[1]));
}

async function createRepository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repo });
  await writeFile(path.join(repo, "committed.txt"), "committed\n");
  await writeFile(path.join(repo, "large.bin"), Buffer.alloc(700_000, 0xa5));
  await copyFile(fixtureAgent, path.join(repo, "fixture-agent.mjs"));
  await chmod(path.join(repo, "fixture-agent.mjs"), 0o755);
  await symlink("/etc/passwd", path.join(repo, "outside-link"));
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"], {
    cwd: repo,
  });
  return repo;
}

async function collectBytes(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const buffers: Buffer[] = [];
  for await (const chunk of chunks) buffers.push(Buffer.from(chunk));
  return Buffer.concat(buffers);
}

async function waitForOutput(stream: NodeJS.ReadableStream, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (!output.includes(marker)) return;
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
      resolve(output);
    };
    const onError = (error: Error) => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      reject(error);
    };
    const onEnd = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      reject(new Error(`Stream ended before output marker: ${marker}`));
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

function dockerProcesses(workspaceId: string): string {
  const container = dockerResourceName(workspaceId);
  return execFileSync("docker", ["top", container, "-eo", "pid,args"], { encoding: "utf8" });
}

function dockerResourceName(workspaceId: string): string {
  return `paseo-ws-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 20)}`;
}

function dockerResourceCount(kind: "ps" | "volume", workspaceId: string): number {
  const args =
    kind === "ps"
      ? ["ps", "-aq", "--filter", `label=sh.paseo.workspace-id=${workspaceId}`]
      : ["volume", "ls", "-q", "--filter", `label=sh.paseo.workspace-id=${workspaceId}`];
  return execFileSync("docker", args, { encoding: "utf8" }).trim() ? 1 : 0;
}

function nextFile(directory: string, expectedName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const expected = path.join(directory, expectedName);
    const watcher = watch(directory, (_event, filename) => {
      if (filename?.toString() !== expectedName) return;
      finish();
    });
    watcher.once("error", reject);
    if (existsSync(expected)) finish();

    function finish(): void {
      watcher.close();
      resolve();
    }
  });
}

function dockerBarrierShim(realDocker: string): string {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const barrier = process.env.PASEO_DOCKER_TEST_BARRIER;
const readiness = barrier && args.includes("paseo-ready");
const signal = barrier && args.includes("paseo-signal");
if (readiness) await writeFile(path.join(barrier, "readiness-waiting"), "waiting");
if (barrier && args[0] === "exec" && args.includes("/opt/paseo-workspace-runtime/workload.mjs")) {
  await writeFile(path.join(barrier, "entered"), "entered");
  await nextFile(barrier, "release");
  await nextOneOf(barrier, ["readiness-waiting", "signal-finished"]);
}
const child = spawn(${JSON.stringify(realDocker)}, args, { stdio: "inherit" });
child.once("error", error => { process.stderr.write(String(error)); process.exitCode = 127; });
child.once("exit", async (code, exitSignal) => {
  if (signal) await writeFile(path.join(barrier, "signal-finished"), "finished");
  if (exitSignal) { process.removeAllListeners(exitSignal); process.kill(process.pid, exitSignal); }
  else process.exitCode = code ?? 1;
});

function nextFile(directory, name) {
  const expected = path.join(directory, name);
  if (existsSync(expected)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, (_event, filename) => {
      if (filename?.toString() !== name) return;
      watcher.close();
      resolve();
    });
    watcher.once("error", reject);
    if (existsSync(expected)) { watcher.close(); resolve(); }
  });
}

function nextOneOf(directory, names) {
  if (names.some(name => existsSync(path.join(directory, name)))) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, (_event, filename) => {
      if (!filename || !names.includes(filename.toString())) return;
      watcher.close();
      resolve();
    });
    watcher.once("error", reject);
    if (names.some(name => existsSync(path.join(directory, name)))) { watcher.close(); resolve(); }
  });
}
`;
}

async function readFileFromHost(root: string, name: string): Promise<string | null> {
  try {
    return await (await import("node:fs/promises")).readFile(path.join(root, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function createLogger() {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}
