#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";

interface RuntimeState {
  workspaceId: string;
  root: string;
  revision: string;
  executionDomainId: string;
  lifecycle: "ready" | "paused";
}

interface LifecycleRequest {
  protocolVersion: 1;
  input?: {
    workspaceId: string;
    project: {
      source:
        | { kind: "host-directory"; path: string }
        | { kind: "git"; url: string; revision: string; subdirectory?: string };
    };
    placement: { relativeCwd?: string };
  };
  options: { image?: unknown };
}

interface ExecRequest {
  protocolVersion: 1;
  argv: [string, ...string[]];
  cwd?: string;
  env: Record<string, string>;
  purpose:
    | { kind: "agent"; agentId: string; provider: string }
    | { kind: "terminal"; terminalId: string }
    | { kind: "git" }
    | { kind: "provider-probe"; provider: string }
    | { kind: "workspace-helper" }
    | { kind: "workspace-script"; script: string }
    | { kind: "setup" }
    | { kind: "archive" };
  options: { image?: unknown };
  execId: string;
}

const [operation] = process.argv.slice(2);
const requestedWorkspaceId = argument("--workspace-id");

try {
  if (operation === "describe") {
    writeJson({ protocolVersion: 1, modes: ["pipes"] });
  } else if (!requestedWorkspaceId) {
    throw new Error("--workspace-id is required");
  } else if (operation === "exec") {
    await execute(requestedWorkspaceId);
  } else if (operation === "signal") {
    await readStdin();
    await signalExec(
      requestedWorkspaceId,
      requireArgument("--exec-id"),
      requireSignal(requireArgument("--signal")),
    );
  } else {
    const request = JSON.parse(await readStdin()) as LifecycleRequest;
    assertProtocol(request.protocolVersion);
    switch (operation) {
      case "create":
        writeJson({
          protocolVersion: 1,
          type: "state",
          state: await create(requestedWorkspaceId, request),
        });
        break;
      case "inspect":
        writeJson({
          protocolVersion: 1,
          type: "inspection",
          inspection: await inspect(requestedWorkspaceId),
        });
        break;
      case "pause":
        await pause(requestedWorkspaceId);
        writeJson({ protocolVersion: 1, type: "ok" });
        break;
      case "resume":
        writeJson({
          protocolVersion: 1,
          type: "state",
          state: await resume(requestedWorkspaceId),
        });
        break;
      case "destroy":
        await destroy(requestedWorkspaceId);
        writeJson({ protocolVersion: 1, type: "ok" });
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function create(workspaceId: string, request: LifecycleRequest): Promise<RuntimeState> {
  const existing = await inspect(workspaceId);
  if (existing.status === "ready" || existing.status === "paused") return existing.state;
  const input = request.input;
  if (!input) throw new Error("create input is required");
  const image = requireImage(request.options);
  const relativeRoot =
    input.project.source.kind === "git"
      ? input.project.source.subdirectory
      : input.placement.relativeCwd;
  const requestedRoot = resolveWorkspaceCwd("/workspace", relativeRoot);
  const names = resourceNames(workspaceId);
  const existingVolume = await inspectVolume(names.volume);
  if (existingVolume) {
    if (existingVolume.owner !== workspaceId) {
      throw new Error(`Docker volume ownership mismatch: ${names.volume}`);
    }
    throw new Error(`Docker workspace has an incomplete owned volume: ${workspaceId}`);
  }
  await docker([
    "volume",
    "create",
    "--label",
    "sh.paseo.runtime=workspace",
    "--label",
    `sh.paseo.workspace-id=${workspaceId}`,
    names.volume,
  ]);

  try {
    const source = input.project.source;
    const cloneSource = source.kind === "host-directory" ? "/source" : source.url;
    const revision = source.kind === "git" ? source.revision : "";
    const mounts = ["-v", `${names.volume}:/workspace`];
    if (source.kind === "host-directory") {
      mounts.push("-v", `${await realpath(source.path)}:/source:ro`);
    }
    await docker([
      "run",
      "--rm",
      ...mounts,
      image,
      "/bin/sh",
      "-c",
      'git clone --no-hardlinks "$1" /workspace && if [ -n "$2" ]; then git -C /workspace checkout --detach "$2"; fi',
      "paseo-materialize",
      cloneSource,
      revision,
    ]);
    const commit = (
      await docker([
        "run",
        "--rm",
        "-v",
        `${names.volume}:/workspace`,
        image,
        "git",
        "-C",
        "/workspace",
        "rev-parse",
        "HEAD",
      ])
    ).trim();
    const root = (
      await docker([
        "run",
        "--rm",
        "-v",
        `${names.volume}:/workspace`,
        image,
        "/bin/sh",
        "-c",
        'cd "$1" && pwd -P',
        "paseo-resolve-root",
        requestedRoot,
      ])
    ).trim();
    assertContainedPath("/workspace", root);
    await docker([
      "create",
      "--init",
      "--name",
      names.container,
      "--label",
      "sh.paseo.runtime=workspace",
      "--label",
      `sh.paseo.workspace-id=${workspaceId}`,
      "--label",
      `sh.paseo.workspace-root=${root}`,
      "--label",
      `sh.paseo.workspace-revision=${commit}`,
      "-v",
      `${names.volume}:/workspace`,
      image,
      "/bin/sh",
      "-c",
      "exec tail -f /dev/null",
    ]);
    await docker(["start", names.container]);
    await waitUntilReady(names.container);
    return stateFor(workspaceId, root, commit, names.container);
  } catch (error) {
    await docker(["rm", "-f", names.container], true);
    await docker(["volume", "rm", "-f", names.volume], true);
    throw error;
  }
}

async function inspect(
  workspaceId: string,
): Promise<{ status: "missing" } | { status: "ready" | "paused"; state: RuntimeState }> {
  const names = resourceNames(workspaceId);
  const inspection = await docker(
    [
      "inspect",
      "--format",
      '{{.State.Running}}|{{index .Config.Labels "sh.paseo.runtime"}}|{{index .Config.Labels "sh.paseo.workspace-id"}}|{{index .Config.Labels "sh.paseo.workspace-root"}}|{{index .Config.Labels "sh.paseo.workspace-revision"}}',
      names.container,
    ],
    true,
  );
  if (!inspection) return { status: "missing" };
  const [running, owner, inspectedWorkspaceId, root, revision] = inspection.trim().split("|");
  if (owner !== "workspace" || inspectedWorkspaceId !== workspaceId || !root || !revision) {
    throw new Error(`Docker resource ownership mismatch: ${names.container}`);
  }
  return {
    status: running === "true" ? "ready" : "paused",
    state: stateFor(
      workspaceId,
      root,
      revision,
      names.container,
      running === "true" ? "ready" : "paused",
    ),
  };
}

async function pause(workspaceId: string): Promise<void> {
  const current = await inspect(workspaceId);
  if (current.status === "missing" || current.status === "paused") return;
  await docker(["stop", "--time", "5", resourceNames(workspaceId).container]);
}

async function resume(workspaceId: string): Promise<RuntimeState> {
  const current = await inspect(workspaceId);
  if (current.status === "missing") throw new Error(`Docker workspace is missing: ${workspaceId}`);
  if (current.status === "paused") await docker(["start", resourceNames(workspaceId).container]);
  await waitUntilReady(resourceNames(workspaceId).container);
  const ready = await inspect(workspaceId);
  if (ready.status !== "ready") throw new Error(`Docker workspace did not resume: ${workspaceId}`);
  return ready.state;
}

async function destroy(workspaceId: string): Promise<void> {
  const names = resourceNames(workspaceId);
  const current = await inspect(workspaceId);
  const volume = await inspectVolume(names.volume);
  if (volume && volume.owner !== workspaceId) {
    throw new Error(`Docker volume ownership mismatch: ${names.volume}`);
  }
  if (current.status !== "missing") await docker(["rm", "-f", names.container]);
  if (volume) await docker(["volume", "rm", names.volume]);
}

async function inspectVolume(name: string): Promise<{ owner: string | null } | null> {
  const output = await docker(["volume", "inspect", name], true);
  if (!output) return null;
  const inspection = JSON.parse(output) as Array<{ Labels?: Record<string, string> | null }>;
  return { owner: inspection[0]?.Labels?.["sh.paseo.workspace-id"] ?? null };
}

async function execute(workspaceId: string): Promise<void> {
  const request = JSON.parse(await readOneShotEnvelope()) as ExecRequest;
  assertProtocol(request.protocolVersion);
  if (!/^[a-f0-9]{32}$/.test(request.execId)) throw new Error("Invalid exec id");
  const current = await inspect(workspaceId);
  if (current.status !== "ready") throw new Error(`Docker workspace is ${current.status}`);
  const requestedCwd = resolveWorkspaceCwd(current.state.root, request.cwd);
  const cwd = (
    await docker([
      "exec",
      resourceNames(workspaceId).container,
      "/bin/sh",
      "-c",
      'cd "$1" && pwd -P',
      "paseo-resolve-cwd",
      requestedCwd,
    ])
  ).trim();
  assertContainedPath(current.state.root, cwd);
  const encoded = Buffer.from(
    JSON.stringify({ argv: request.argv, cwd, env: request.env }),
  ).toString("base64url");
  const execId = request.execId;
  const container = resourceNames(workspaceId).container;
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PASEO_RUNTIME_EXEC",
      "-e",
      "PASEO_RUNTIME_EXEC_ID",
      container,
      "node",
      "/opt/paseo-workspace-runtime/workload.mjs",
    ],
    {
      env: { ...process.env, PASEO_RUNTIME_EXEC: encoded, PASEO_RUNTIME_EXEC_ID: execId },
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  let forwardedSignal: NodeJS.Signals | null = null;
  const forwardSignal = async (signal: NodeJS.Signals): Promise<void> => {
    forwardedSignal = signal;
    await signalExec(workspaceId, execId, signal);
  };
  const hostSignalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => void forwardSignal(signal).catch(() => child.kill(signal));
    hostSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  const exit = await exitPromise;
  for (const [signal, handler] of hostSignalHandlers) process.off(signal, handler);
  if (forwardedSignal) {
    process.removeAllListeners(forwardedSignal);
    process.kill(process.pid, forwardedSignal);
    return;
  }
  if (exit.signal) {
    process.kill(process.pid, exit.signal);
    return;
  }
  process.exitCode = exit.code ?? 1;
}

async function signalExec(
  workspaceId: string,
  execId: string,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(execId)) throw new Error("Invalid exec id");
  const current = await inspect(workspaceId);
  if (current.status === "missing") throw new Error(`Docker workspace is missing: ${workspaceId}`);
  await docker([
    "exec",
    resourceNames(workspaceId).container,
    "/bin/sh",
    "-c",
    'test ! -f "$1" || { read -r supervisor workload < "$1"; signal=${2#SIG}; kill -"$signal" "-$workload" 2>/dev/null || kill -"$signal" "$workload" 2>/dev/null || true; kill -"$signal" "$supervisor" 2>/dev/null || true; }',
    "paseo-signal",
    `/tmp/paseo-runtime-exec-${execId}.pid`,
    signal,
  ]);
}

function resolveWorkspaceCwd(root: string, relativeCwd?: string): string {
  if (!root.startsWith("/workspace") || path.posix.relative("/workspace", root).startsWith("..")) {
    throw new Error(`Invalid Docker workspace root: ${root}`);
  }
  if (!relativeCwd) return root;
  if (path.posix.isAbsolute(relativeCwd) || relativeCwd.includes("\\")) {
    throw new Error("Workspace cwd must be relative");
  }
  const resolved = path.posix.resolve(root, relativeCwd);
  const relative = path.posix.relative(root, resolved);
  if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error("Workspace cwd escapes its root");
  }
  return resolved;
}

function assertContainedPath(root: string, candidate: string): void {
  const relative = path.posix.relative(root, candidate);
  if (
    !candidate ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative)
  ) {
    throw new Error("Workspace cwd escapes its root");
  }
}

function requireImage(options: LifecycleRequest["options"]): string {
  if (typeof options.image !== "string" || !options.image.trim()) {
    throw new Error("Docker runtime option image is required");
  }
  return options.image;
}

function resourceNames(workspaceId: string): { container: string; volume: string } {
  const key = createHash("sha256").update(workspaceId).digest("hex").slice(0, 20);
  return { container: `paseo-ws-${key}`, volume: `paseo-ws-${key}` };
}

function stateFor(
  workspaceId: string,
  root: string,
  revision: string,
  container: string,
  lifecycle: "ready" | "paused" = "ready",
): RuntimeState {
  return { workspaceId, root, revision, executionDomainId: `docker:${container}`, lifecycle };
}

async function waitUntilReady(container: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const output = await docker(
      ["exec", container, "/bin/sh", "-c", "test -d /workspace && echo ready"],
      true,
    );
    if (output.trim() === "ready") return;
    lastError = `Container is not ready: ${container}`;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(lastError);
}

async function docker(args: string[], allowFailure = false): Promise<string> {
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  const [stdout, stderr, exit] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    new Promise<{ code: number | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code }));
    }),
  ]);
  if (exit.code !== 0) {
    if (allowFailure) return "";
    throw new Error(`docker ${args[0]} failed: ${stderr.trim()}`);
  }
  return stdout;
}

async function readStdin(): Promise<string> {
  return readStream(process.stdin);
}

async function readOneShotEnvelope(): Promise<string> {
  const stream = new Socket({ fd: 3, readable: true, writable: false });
  try {
    return await readStream(stream);
  } finally {
    stream.destroy();
  }
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function assertProtocol(version: unknown): asserts version is 1 {
  if (version !== 1) throw new Error(`Unsupported protocol version: ${String(version)}`);
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag, 2);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requireArgument(flag: string): string {
  const value = argument(flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function requireSignal(value: string): NodeJS.Signals {
  if (value !== "SIGINT" && value !== "SIGTERM" && value !== "SIGHUP" && value !== "SIGKILL") {
    throw new Error(`Unsupported signal: ${value}`);
  }
  return value;
}
