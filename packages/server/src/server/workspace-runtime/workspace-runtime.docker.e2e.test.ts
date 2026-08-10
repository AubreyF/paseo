import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { createWorkspaceRuntimeService } from "./index.js";

const repositoryRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const dockerRuntimeRoot = path.join(repositoryRoot, "packages/docker-workspace-runtime");
const runtimeExecutable = path.join(dockerRuntimeRoot, "src/index.ts");
const image = "paseo-workspace-runtime-slice1:test";
const cleanupRoots: string[] = [];

beforeAll(() => {
  execFileSync(
    "docker",
    ["build", "-t", image, "-f", path.join(dockerRuntimeRoot, "Dockerfile"), repositoryRoot],
    { stdio: "pipe" },
  );
}, 120_000);

afterAll(async () => {
  await Promise.all(cleanupRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

test("the command runtime owns Docker workspace materialization, pipes, and lifecycle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-runtime-docker-"));
  cleanupRoots.push(root);
  const repo = await createRepository(root);
  await writeFile(path.join(repo, ".env"), "must-not-enter-runtime\n");
  const runtimeIds = new Map<string, string>();
  const options = {
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (workspaceId: string) => runtimeIds.get(workspaceId) ?? null,
    persistRuntimeId: async (workspaceId: string, runtimeId: string) => {
      runtimeIds.set(workspaceId, runtimeId);
    },
    externalRuntimes: {
      docker: {
        type: "command",
        command: [process.execPath, "--import", "tsx", runtimeExecutable] as const,
        options: { image },
      },
    },
  };
  const service = createWorkspaceRuntimeService(options);
  const workspaceId = `docker-${Date.now()}`;

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
    expect(workspace).toEqual({ workspaceId, runtimeId: "docker" });
    expect("cwd" in workspace).toBe(false);

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
    await expect(
      recovered.run({
        workspaceId,
        cwd: "../escape",
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "cwd-contract" },
      }),
    ).rejects.toThrow("Workspace cwd must stay within the runtime root");
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
    terminalControlFailure.resize(0, 0);
    await expect(terminalControlFailure.exited).rejects.toThrow("Invalid PTY size");
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
    await expect(stubborn.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
    expect(
      execFileSync(
        "docker",
        ["inspect", "--format", "{{.State.Running}}", dockerResourceName(workspaceId)],
        {
          encoding: "utf8",
        },
      ).trim(),
    ).toBe("false");

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
    ).rejects.toThrow(`Workspace runtime is missing: ${workspaceId}`);
  } finally {
    await service.destroy(workspaceId).catch(() => undefined);
  }
}, 120_000);

test("Docker creation validates roots and rolls back when runtime selection cannot persist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-runtime-docker-rollback-"));
  cleanupRoots.push(root);
  const repo = await createRepository(root);
  const workspaceId = `docker-rollback-${Date.now()}`;
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async () => null,
    persistRuntimeId: async () => {
      throw new Error("persistence failed");
    },
    externalRuntimes: {
      docker: {
        type: "command",
        command: [process.execPath, "--import", "tsx", runtimeExecutable],
        options: { image },
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
  const root = await mkdtemp(path.join(tmpdir(), "paseo-runtime-docker-symlink-"));
  cleanupRoots.push(root);
  const repo = await createRepository(root);
  await mkdir(path.join(repo, "selected"));
  await symlink("..", path.join(repo, "selected", "escape"));
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "symlink fixture"], {
    cwd: repo,
  });
  const workspaceId = `docker-symlink-${Date.now()}`;
  const runtimeIds = new Map<string, string>();
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    externalRuntimes: {
      docker: {
        type: "command",
        command: [process.execPath, "--import", "tsx", runtimeExecutable],
        options: { image },
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
    const [escapedError, escapedExit] = await Promise.all([
      collect(escaped.stderr),
      escaped.exited,
    ]);
    expect(escapedError).toContain("Workspace cwd escapes its root");
    expect(escapedExit.code).not.toBe(0);
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
  const root = await mkdtemp(path.join(tmpdir(), "paseo-runtime-docker-ownership-"));
  cleanupRoots.push(root);
  const workspaceId = `docker-ownership-${Date.now()}`;
  const volume = dockerResourceName(workspaceId);
  execFileSync("docker", ["volume", "create", volume]);
  const runtimeIds = new Map([[workspaceId, "docker"]]);
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    externalRuntimes: {
      docker: {
        type: "command",
        command: [process.execPath, "--import", "tsx", runtimeExecutable],
        options: { image },
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

async function createRepository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repo });
  await writeFile(path.join(repo, "committed.txt"), "committed\n");
  await writeFile(path.join(repo, "large.bin"), Buffer.alloc(700_000, 0xa5));
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

async function readFileFromHost(root: string, name: string): Promise<string | null> {
  try {
    return await (await import("node:fs/promises")).readFile(path.join(root, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
