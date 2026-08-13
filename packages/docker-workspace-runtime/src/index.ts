#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import {
  COMMAND_RUNTIME_PROTOCOL_VERSION,
  CommandRuntimeControlSchema,
  CommandRuntimeDescribeResponseSchema,
  CommandRuntimeLifecycleRequestSchema,
  CommandRuntimeLifecycleResponseSchema,
  CommandRuntimeProcessEventSchema,
  encodeCommandRuntimeMessage,
  type CommandRuntimeControl,
  type CommandRuntimeLifecycleRequest,
  type CommandRuntimeMessageSchema,
  type CommandRuntimeSpawnEnvelope,
  type CommandRuntimeState,
} from "@getpaseo/workspace-runtime-contract";

type RuntimeState = CommandRuntimeState;
type PrivateRuntimeState = RuntimeState & {
  root: string;
  revision: string;
  container: string;
  lifecycleEnvironment: Readonly<Record<string, string>>;
};
type LifecycleRequest = CommandRuntimeLifecycleRequest;
type ExecRequest = CommandRuntimeSpawnEnvelope;
type PtyControl = CommandRuntimeControl;
interface DockerBindMount {
  source: string;
  target: string;
  readOnly: boolean;
}

const PTY_CLEANUP_TIMEOUT_MS = 1_000;
const EXEC_READY_TIMEOUT_MS = 5_000;

const [operation] = process.argv.slice(2);
const requestedWorkspaceId = argument("--workspace-id");

try {
  if (operation === "describe") {
    writeJson(CommandRuntimeDescribeResponseSchema, {
      protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
      modes: ["pipes", "pty"],
      reconcile: true,
    });
  } else if (operation === "reconcile") {
    const request = CommandRuntimeLifecycleRequestSchema.parse(JSON.parse(await readStdin()));
    await reconcile(request.workspaceIds ?? [], requireOwner(request.runtimeInstanceId));
    writeJson(CommandRuntimeLifecycleResponseSchema, {
      protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
      type: "ok",
    });
  } else if (!requestedWorkspaceId) {
    throw new Error("--workspace-id is required");
  } else if (operation === "exec") {
    await execute(requestedWorkspaceId);
  } else if (operation === "signal") {
    const request = CommandRuntimeLifecycleRequestSchema.parse(JSON.parse(await readStdin()));
    await signalExec(
      requestedWorkspaceId,
      requireArgument("--exec-id"),
      requireSignal(requireArgument("--signal")),
      requireOwner(request.runtimeInstanceId),
    );
  } else {
    const request = CommandRuntimeLifecycleRequestSchema.parse(JSON.parse(await readStdin()));
    switch (operation) {
      case "create":
        {
          const result = await create(requestedWorkspaceId, request);
          writeJson(CommandRuntimeLifecycleResponseSchema, {
            protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
            type: "state",
            state: publicState(result.state),
            placement: runtimePlacement(result.state),
            materializedFreshContent: result.materializedFreshContent,
          });
        }
        break;
      case "inspect":
        writeJson(CommandRuntimeLifecycleResponseSchema, {
          protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
          type: "inspection",
          inspection: await inspect(requestedWorkspaceId, requireOwner(request.runtimeInstanceId)),
        });
        break;
      case "pause":
        await pause(requestedWorkspaceId, requireOwner(request.runtimeInstanceId));
        writeJson(CommandRuntimeLifecycleResponseSchema, {
          protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
          type: "ok",
        });
        break;
      case "resume":
        {
          const state = await resume(requestedWorkspaceId, requireOwner(request.runtimeInstanceId));
          writeJson(CommandRuntimeLifecycleResponseSchema, {
            protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
            type: "state",
            state: publicState(state),
            placement: runtimePlacement(state),
          });
        }
        break;
      case "destroy":
        await destroy(requestedWorkspaceId, requireOwner(request.runtimeInstanceId));
        writeJson(CommandRuntimeLifecycleResponseSchema, {
          protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
          type: "ok",
        });
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function create(
  workspaceId: string,
  request: LifecycleRequest,
): Promise<{ state: PrivateRuntimeState; materializedFreshContent: boolean }> {
  const owner = requireOwner(request.runtimeInstanceId);
  const existing = await inspectPrivate(workspaceId, owner);
  if (existing.status === "ready" || existing.status === "paused") {
    return { state: existing.state, materializedFreshContent: false };
  }
  const input = request.input;
  if (!input) throw new Error("create input is required");
  const image = requireImage(request.options);
  const bindMounts = requireBindMounts(request.options);
  const relativeRoot =
    input.project.source.kind === "git"
      ? input.project.source.subdirectory
      : input.placement.relativeCwd;
  const requestedRoot = resolveWorkspaceCwd("/workspace", relativeRoot);
  const names = resourceNames(workspaceId);
  await docker([
    "volume",
    "create",
    "--label",
    "sh.paseo.runtime=workspace",
    "--label",
    `sh.paseo.workspace-id=${workspaceId}`,
    "--label",
    `sh.paseo.runtime-owner=${owner}`,
    names.volume,
  ]);
  const createdVolume = await inspectVolume(names.volume);
  if (!createdVolume) throw new Error(`Docker volume disappeared after creation: ${names.volume}`);
  assertOwnedResource("volume", names.volume, createdVolume, workspaceId, owner);

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
      ...dockerBindMountArguments(bindMounts),
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
      `sh.paseo.runtime-owner=${owner}`,
      "--label",
      `sh.paseo.workspace-root=${root}`,
      "--label",
      `sh.paseo.workspace-revision=${commit}`,
      "-v",
      `${names.volume}:/workspace`,
      ...dockerBindMountArguments(bindMounts),
      image,
      "/bin/sh",
      "-c",
      "exec tail -f /dev/null",
    ]);
    await assertOwnedWorkspaceResources(workspaceId, owner);
    await docker(["start", names.container]);
    await waitUntilReady(names.container);
    return {
      state: stateFor(workspaceId, root, commit, names.container),
      materializedFreshContent: true,
    };
  } catch (error) {
    const cleanupErrors = await cleanupOwnedCreation(workspaceId, owner);
    if (cleanupErrors.length > 0) {
      throw new Error(
        `Docker creation rollback failed: ${cleanupErrors.map((cleanupError) => cleanupError.message).join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

interface DockerResourceLabels {
  runtime: string | null;
  workspaceId: string | null;
  runtimeOwner: string | null;
}

interface DockerContainerInspection extends DockerResourceLabels {
  running: boolean;
  root: string | null;
  revision: string | null;
}

async function assertOwnedWorkspaceResources(
  workspaceId: string,
  expectedOwner: string,
): Promise<void> {
  const names = resourceNames(workspaceId);
  const [container, volume] = await Promise.all([
    inspectContainer(names.container),
    inspectVolume(names.volume),
  ]);
  if (!container || !volume) {
    throw new Error(`Docker workspace resources are incomplete: ${workspaceId}`);
  }
  assertOwnedResource("container", names.container, container, workspaceId, expectedOwner);
  assertOwnedResource("volume", names.volume, volume, workspaceId, expectedOwner);
}

async function inspectPrivate(
  workspaceId: string,
  expectedOwner: string,
): Promise<
  | { status: "missing" }
  | {
      status: "ready" | "paused";
      state: PrivateRuntimeState;
      placement: { cwd: string };
    }
> {
  const names = resourceNames(workspaceId);
  const [container, volume] = await Promise.all([
    inspectContainer(names.container),
    inspectVolume(names.volume),
  ]);
  if (container)
    assertOwnedResource("container", names.container, container, workspaceId, expectedOwner);
  if (volume) assertOwnedResource("volume", names.volume, volume, workspaceId, expectedOwner);
  if (!container && !volume) return { status: "missing" };
  if (!container || !volume) {
    throw new Error(`Docker workspace resources are incomplete: ${workspaceId}`);
  }
  if (!container.root || !container.revision) {
    throw new Error(`Docker container placement is incomplete: ${names.container}`);
  }
  const state = stateFor(
    workspaceId,
    container.root,
    container.revision,
    names.container,
    container.running ? "ready" : "paused",
  );
  return {
    status: container.running ? "ready" : "paused",
    state,
    placement: runtimePlacement(state),
  };
}

async function inspectContainer(name: string): Promise<DockerContainerInspection | null> {
  const output = await docker(
    [
      "inspect",
      "--format",
      '{{json .State.Running}}|{{json (index .Config.Labels "sh.paseo.runtime")}}|{{json (index .Config.Labels "sh.paseo.workspace-id")}}|{{json (index .Config.Labels "sh.paseo.runtime-owner")}}|{{json (index .Config.Labels "sh.paseo.workspace-root")}}|{{json (index .Config.Labels "sh.paseo.workspace-revision")}}',
      name,
    ],
    true,
  );
  if (!output) return null;
  const [running, runtime, workspaceId, runtimeOwner, root, revision] = output
    .trim()
    .split("|")
    .map(parseDockerJsonValue);
  return {
    running: running === true,
    runtime: typeof runtime === "string" ? runtime : null,
    workspaceId: typeof workspaceId === "string" ? workspaceId : null,
    runtimeOwner: typeof runtimeOwner === "string" ? runtimeOwner : null,
    root: typeof root === "string" ? root : null,
    revision: typeof revision === "string" ? revision : null,
  };
}

async function inspect(workspaceId: string, expectedOwner: string) {
  const inspection = await inspectPrivate(workspaceId, expectedOwner);
  if (inspection.status === "ready" || inspection.status === "paused") {
    return { ...inspection, state: publicState(inspection.state) };
  }
  return inspection;
}

async function pause(workspaceId: string, expectedOwner: string): Promise<void> {
  const current = await inspectPrivate(workspaceId, expectedOwner);
  if (current.status === "missing" || current.status === "paused") return;
  await docker(["stop", "--time", "5", resourceNames(workspaceId).container]);
}

async function resume(workspaceId: string, expectedOwner: string): Promise<PrivateRuntimeState> {
  const current = await inspectPrivate(workspaceId, expectedOwner);
  if (current.status === "missing") throw new Error(`Docker workspace is missing: ${workspaceId}`);
  if (current.status === "paused") await docker(["start", resourceNames(workspaceId).container]);
  await waitUntilReady(resourceNames(workspaceId).container);
  const ready = await inspectPrivate(workspaceId, expectedOwner);
  if (ready.status !== "ready") throw new Error(`Docker workspace did not resume: ${workspaceId}`);
  return ready.state;
}

async function destroy(workspaceId: string, expectedOwner: string): Promise<void> {
  const names = resourceNames(workspaceId);
  const current = await inspectPrivate(workspaceId, expectedOwner);
  if (current.status === "missing") return;
  await docker(["rm", "-f", names.container]);
  await docker(["volume", "rm", names.volume]);
}

async function inspectVolume(name: string): Promise<DockerResourceLabels | null> {
  const output = await docker(["volume", "inspect", name], true);
  if (!output) return null;
  const inspection = JSON.parse(output) as Array<{ Labels?: Record<string, string> | null }>;
  return {
    workspaceId: inspection[0]?.Labels?.["sh.paseo.workspace-id"] ?? null,
    runtime: inspection[0]?.Labels?.["sh.paseo.runtime"] ?? null,
    runtimeOwner: inspection[0]?.Labels?.["sh.paseo.runtime-owner"] ?? null,
  };
}

async function reconcile(workspaceIds: readonly string[], owner: string): Promise<void> {
  const known = new Set(workspaceIds);
  const containers = await labeledResources("ps", owner);
  const volumes = await labeledResources("volume", owner);
  const candidateWorkspaceIds = new Set([...containers.values(), ...volumes.values()]);
  for (const workspaceId of candidateWorkspaceIds) {
    if (!workspaceId || known.has(workspaceId)) continue;
    const names = resourceNames(workspaceId);
    const containerProven = containers.get(names.container) === workspaceId;
    const volumeProven = volumes.get(names.volume) === workspaceId;
    if (!containerProven && !volumeProven) continue;
    const container = await inspectContainer(names.container);
    const volume = await inspectVolume(names.volume);
    if (container) assertOwnedResource("container", names.container, container, workspaceId, owner);
    if (volume) assertOwnedResource("volume", names.volume, volume, workspaceId, owner);
    if (containerProven && container) await docker(["rm", "-f", names.container]);
    if (volumeProven && volume) await docker(["volume", "rm", names.volume]);
  }
}

async function labeledResources(
  kind: "ps" | "volume",
  owner: string,
): Promise<Map<string, string>> {
  const output =
    kind === "ps"
      ? await docker([
          "ps",
          "-a",
          "--filter",
          "label=sh.paseo.runtime=workspace",
          "--filter",
          `label=sh.paseo.runtime-owner=${owner}`,
          "--format",
          '{{.Names}}|{{.Label "sh.paseo.workspace-id"}}',
        ])
      : await docker([
          "volume",
          "ls",
          "--filter",
          "label=sh.paseo.runtime=workspace",
          "--filter",
          `label=sh.paseo.runtime-owner=${owner}`,
          "--format",
          '{{.Name}}|{{.Label "sh.paseo.workspace-id"}}',
        ]);
  return new Map(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("|");
        return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function execute(workspaceId: string): Promise<void> {
  const control = new Socket({ fd: 3, readable: true, writable: false });
  const lines = createInterface({ input: control, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error("Runtime exec spawn control is required");
  const request = CommandRuntimeControlSchema.parse(JSON.parse(first.value));
  if (request.type !== "spawn") throw new Error("Runtime exec spawn control is required");
  if (!/^[a-f0-9]{32}$/.test(request.execId)) throw new Error("Invalid exec id");
  const expectedOwner = requireOwner(request.runtimeInstanceId);
  const current = await inspectPrivate(workspaceId, expectedOwner);
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
  const encoded = Buffer.from(JSON.stringify({ ...request, cwd })).toString("base64url");
  const execId = request.execId;
  const container = resourceNames(workspaceId).container;
  const readiness = await beginExecutionReadiness(container, execId);
  if (request.stdio.kind === "pty") {
    try {
      await executeDockerPty({
        workspaceId,
        request,
        controls: iterator,
        encoded,
        container,
        readiness,
      });
    } finally {
      await readiness.close();
    }
    return;
  }
  const events = new Socket({ fd: 4, readable: false, writable: true });
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
  let forwardedSignalCompletion: Promise<void> | null = null;
  let forwardedSignalFailure: unknown;
  const forwardSignal = async (signal: NodeJS.Signals): Promise<void> => {
    forwardedSignal = signal;
    try {
      await withTimeout(
        signalExec(workspaceId, execId, signal, expectedOwner),
        PTY_CLEANUP_TIMEOUT_MS,
        "Docker signal helper timed out",
      );
    } catch (error) {
      if (signal === "SIGKILL") throw error;
      try {
        await withTimeout(
          signalExec(workspaceId, execId, "SIGKILL", expectedOwner),
          PTY_CLEANUP_TIMEOUT_MS,
          "Docker forced signal helper timed out",
        );
      } catch (fallbackError) {
        throw new Error(`Docker signal cleanup failed after ${String(error)}`, {
          cause: fallbackError,
        });
      }
    }
  };
  const hostSignalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      forwardedSignalCompletion = forwardSignal(signal).catch((error) => {
        forwardedSignalFailure = error;
      });
    };
    hostSignalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    await withTimeout(
      readiness.ready,
      EXEC_READY_TIMEOUT_MS,
      "Docker workload readiness timed out",
    );
    writePtyEvent(events, {
      type: "started",
      protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
    });
    exit = await exitPromise;
    if (forwardedSignalCompletion) await forwardedSignalCompletion;
    if (forwardedSignalFailure) throw forwardedSignalFailure;
  } catch (error) {
    child.kill("SIGKILL");
    await readiness.close();
    throw error;
  }
  for (const [signal, handler] of hostSignalHandlers) process.off(signal, handler);
  writePtyEvent(events, { type: "eof", protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION });
  await new Promise<void>((resolve, reject) => {
    events
      .end(
        encodeCommandRuntimeMessage(CommandRuntimeProcessEventSchema, {
          type: "exit",
          protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
          code: forwardedSignal || exit.signal ? null : (exit.code ?? 1),
          signal: forwardedSignal ?? exit.signal,
        }),
        resolve,
      )
      .once("error", reject);
  });
  await readiness.close();
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

async function executeDockerPty(input: {
  workspaceId: string;
  request: ExecRequest;
  controls: AsyncIterator<string>;
  encoded: string;
  container: string;
  readiness: ExecutionReadiness;
}): Promise<void> {
  if (input.request.stdio.kind !== "pty") throw new Error("Docker PTY execution requires PTY mode");
  const events = new Socket({ fd: 4, readable: false, writable: true });
  const created = await dockerApiJson<{ Id: string }>(
    "POST",
    `/containers/${encodeURIComponent(input.container)}/exec`,
    {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: [`PASEO_RUNTIME_EXEC=${input.encoded}`, `PASEO_RUNTIME_EXEC_ID=${input.request.execId}`],
      Cmd: ["node", "/opt/paseo-workspace-runtime/workload.mjs"],
    },
  );
  const stream = await startDockerExec(created.Id);
  await resizeDockerExec(created.Id, input.request.stdio.cols, input.request.stdio.rows);
  await withTimeout(
    input.readiness.ready,
    EXEC_READY_TIMEOUT_MS,
    "Docker workload readiness timed out",
  );
  writePtyEvent(events, {
    type: "started",
    protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
  });
  process.stdin.pipe(stream);
  stream.on("data", (data: Buffer) => process.stdout.write(data));
  stream.resume();
  let requestedSignal: NodeJS.Signals | null = null;
  let executionFinished = false;
  let announceControlFailure!: (error: Error) => void;
  const controlFailureStarted = new Promise<Error>((resolve) => {
    announceControlFailure = resolve;
  });
  const controlCleanup = handlePtyControls(
    input.workspaceId,
    input.request.execId,
    created.Id,
    input.controls,
    requireOwner(input.request.runtimeInstanceId),
    (signal) => {
      requestedSignal = signal;
    },
    (id) => {
      writePtyEvent(events, {
        type: "resized",
        protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
        id,
      });
    },
  ).then(
    () => new Promise<never>(() => {}),
    async (error) => {
      if (executionFinished) return new Promise<never>(() => {});
      const failure = error instanceof Error ? error : new Error(String(error));
      announceControlFailure(failure);
      let cleanupError: Error | null = null;
      try {
        await withTimeout(
          signalExec(
            input.workspaceId,
            input.request.execId,
            "SIGKILL",
            requireOwner(input.request.runtimeInstanceId),
          ),
          PTY_CLEANUP_TIMEOUT_MS,
          "Docker PTY signal helper timed out",
        );
      } catch (cleanupFailure) {
        cleanupError =
          cleanupFailure instanceof Error ? cleanupFailure : new Error(String(cleanupFailure));
      }
      stream.destroy();
      return { failure, cleanupError };
    },
  );
  const streamEnded = new Promise<void>((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
  const firstOutcome = await Promise.race([
    streamEnded.then(() => "stream" as const),
    controlFailureStarted.then(() => "control" as const),
  ]);
  const outcome =
    firstOutcome === "control" ? await controlCleanup : { failure: null, cleanupError: null };
  executionFinished = true;
  process.stdin.unpipe(stream);
  writePtyEvent(events, { type: "eof", protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION });
  if (outcome.failure) {
    const cleanupDetail = outcome.cleanupError
      ? `; cleanup failed: ${outcome.cleanupError.message}`
      : "";
    writePtyEvent(events, {
      type: "error",
      protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
      message: `${outcome.failure.message}${cleanupDetail}`,
    });
    events.end();
    return;
  }
  const inspection = await dockerApiJson<{ ExitCode: number }>(
    "GET",
    `/exec/${encodeURIComponent(created.Id)}/json`,
  );
  writePtyEvent(events, {
    type: "exit",
    protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
    code: requestedSignal ? null : inspection.ExitCode,
    signal: requestedSignal,
  });
  events.end();
}

interface ExecutionReadiness {
  ready: Promise<void>;
  close(): Promise<void>;
}

async function beginExecutionReadiness(
  container: string,
  execId: string,
): Promise<ExecutionReadiness> {
  const files = executionFiles(execId);
  await docker([
    "exec",
    container,
    "/bin/sh",
    "-c",
    'umask 077; rm -f "$1" "$2" "$3"; mkfifo "$1"',
    "paseo-ready",
    files.ready,
    files.pid,
    files.done,
  ]);
  const waiter = spawn(
    "docker",
    [
      "exec",
      container,
      "/bin/sh",
      "-c",
      'IFS= read -r token < "$1"; status=$?; rm -f "$1"; test "$status" -eq 0 && test "$token" = "$2"',
      "paseo-ready",
      files.ready,
      execId,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const ready = Promise.all([
    readStream(waiter.stderr),
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      waiter.once("error", reject);
      waiter.once("close", (code, signal) => resolve({ code, signal }));
    }),
  ]).then(([stderr, exit]) => {
    if (exit.code === 0) return;
    throw new Error(
      `Docker workload readiness failed (${exit.code ?? exit.signal}): ${stderr.trim()}`,
    );
  });
  let closed = false;
  return {
    ready,
    async close() {
      if (closed) return;
      closed = true;
      if (waiter.exitCode === null && waiter.signalCode === null) waiter.kill("SIGKILL");
      await docker(
        [
          "exec",
          container,
          "/bin/sh",
          "-c",
          'rm -f "$1" "$2"',
          "paseo-ready-cleanup",
          files.ready,
          files.done,
        ],
        true,
      );
    },
  };
}

function executionFiles(execId: string): { pid: string; ready: string; done: string } {
  const prefix = `/tmp/paseo-runtime-exec-${execId}`;
  return { pid: `${prefix}.pid`, ready: `${prefix}.ready`, done: `${prefix}.done` };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function handlePtyControls(
  workspaceId: string,
  execId: string,
  dockerExecId: string,
  controls: AsyncIterator<string>,
  expectedOwner: string,
  onSignal: (signal: NodeJS.Signals) => void,
  onResize: (id: number) => void,
): Promise<void> {
  while (true) {
    const next = await controls.next();
    if (next.done) return;
    const control: PtyControl = CommandRuntimeControlSchema.parse(JSON.parse(next.value));
    if (control.type === "resize") {
      await resizeDockerExec(dockerExecId, control.cols, control.rows);
      onResize(control.id);
    } else if (control.type === "signal") {
      const signal = requireSignal(control.signal);
      onSignal(signal);
      await signalExec(workspaceId, execId, signal, expectedOwner);
    } else {
      throw new Error(`Unexpected PTY control: ${control.type}`);
    }
  }
}

async function resizeDockerExec(execId: string, cols: number, rows: number): Promise<void> {
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new Error("Invalid PTY size");
  }
  await dockerApiJson("POST", `/exec/${encodeURIComponent(execId)}/resize?h=${rows}&w=${cols}`);
}

function writePtyEvent(stream: Socket, event: unknown): void {
  stream.write(encodeCommandRuntimeMessage(CommandRuntimeProcessEventSchema, event));
}

async function dockerApiJson<T = Record<string, never>>(
  method: "GET" | "POST",
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: "/var/run/docker.sock",
        method,
        path: apiPath,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : undefined,
      },
      (response) => {
        void readStream(response).then((output) => {
          if ((response.statusCode ?? 500) >= 300) {
            return reject(new Error(`Docker API ${method} ${apiPath} failed: ${output.trim()}`));
          }
          return resolve((output ? JSON.parse(output) : {}) as T);
        }, reject);
      },
    );
    request.once("error", reject);
    request.end(payload);
  });
}

async function startDockerExec(execId: string): Promise<Duplex> {
  const payload = JSON.stringify({ Detach: false, Tty: true });
  return new Promise<Duplex>((resolve, reject) => {
    const request = httpRequest({
      socketPath: "/var/run/docker.sock",
      method: "POST",
      path: `/exec/${encodeURIComponent(execId)}/start`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
    });
    request.once("upgrade", (_response, socket, head) => {
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    request.once("response", (response) => {
      void readStream(response).then((output) => {
        return reject(new Error(`Docker exec attach failed: ${output.trim()}`));
      }, reject);
    });
    request.once("error", reject);
    request.end(payload);
  });
}

async function signalExec(
  workspaceId: string,
  execId: string,
  signal: NodeJS.Signals,
  expectedOwner: string,
): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(execId)) throw new Error("Invalid exec id");
  const current = await inspectPrivate(workspaceId, expectedOwner);
  if (current.status === "missing") throw new Error(`Docker workspace is missing: ${workspaceId}`);
  const files = executionFiles(execId);
  await docker([
    "exec",
    resourceNames(workspaceId).container,
    "/bin/sh",
    "-c",
    'if [ ! -f "$1" ]; then if [ -f "$2" ]; then exit 0; fi; echo "execution identity is not ready" >&2; exit 75; fi; read -r supervisor workload < "$1" || { echo "execution identity is malformed" >&2; exit 76; }; signal=${3#SIG}; kill -"$signal" "-$workload" 2>/dev/null || kill -"$signal" "$workload" 2>/dev/null || true; tail --pid="$supervisor" --sleep-interval=.05 -f /dev/null || { echo "execution wait failed" >&2; exit 77; }; test ! -f "$1" && test -f "$2" || { echo "execution did not publish completion" >&2; exit 78; }',
    "paseo-signal",
    files.pid,
    files.done,
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

function requireOwner(runtimeInstanceId: string): string {
  if (!/^[a-f0-9]{64}$/.test(runtimeInstanceId)) {
    throw new Error("Runtime instance id must be a SHA-256 identity");
  }
  return runtimeInstanceId;
}

function parseDockerJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function assertOwnedResource(
  kind: "container" | "volume",
  name: string,
  resource: DockerResourceLabels,
  workspaceId: string,
  expectedOwner: string,
): void {
  if (resource.runtime !== "workspace" || resource.workspaceId !== workspaceId) {
    throw new Error(`Docker ${kind} ownership mismatch: ${name}`);
  }
  if (resource.runtimeOwner !== expectedOwner) {
    throw new Error(`Docker ${kind} runtime owner mismatch: ${name}`);
  }
}

async function cleanupOwnedCreation(workspaceId: string, expectedOwner: string): Promise<Error[]> {
  const names = resourceNames(workspaceId);
  const errors: Error[] = [];
  const [container, volume] = await Promise.all([
    inspectContainer(names.container),
    inspectVolume(names.volume),
  ]);
  const remove = async (
    kind: "container" | "volume",
    resource: DockerResourceLabels | null,
    args: string[],
  ): Promise<void> => {
    if (!resource) return;
    try {
      assertOwnedResource(kind, names[kind], resource, workspaceId, expectedOwner);
      await docker(args);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  };
  await remove("container", container, ["rm", "-f", names.container]);
  await remove("volume", volume, ["volume", "rm", "-f", names.volume]);
  return errors;
}

function requireBindMounts(options: LifecycleRequest["options"]): readonly DockerBindMount[] {
  const value = options.bindMounts;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Docker runtime option bindMounts must be an array");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Docker bind mount ${index} must be an object`);
    }
    const { source, target, readOnly } = entry as Record<string, unknown>;
    if (typeof source !== "string" || !path.isAbsolute(source)) {
      throw new Error(`Docker bind mount ${index} source must be absolute`);
    }
    if (typeof target !== "string" || !path.posix.isAbsolute(target)) {
      throw new Error(`Docker bind mount ${index} target must be an absolute container path`);
    }
    const normalizedTarget = path.posix.normalize(target);
    const workspaceRelative = path.posix.relative("/workspace", normalizedTarget);
    if (workspaceRelative === "" || !workspaceRelative.startsWith("../")) {
      throw new Error(`Docker bind mount ${index} target must be outside /workspace`);
    }
    if (typeof readOnly !== "boolean") {
      throw new Error(`Docker bind mount ${index} readOnly must be boolean`);
    }
    return { source, target: normalizedTarget, readOnly };
  });
}

function dockerBindMountArguments(bindMounts: readonly DockerBindMount[]): string[] {
  return bindMounts.flatMap(({ source, target, readOnly }) => [
    "--mount",
    `type=bind,source=${source},target=${target}${readOnly ? ",readonly" : ""}`,
  ]);
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
): PrivateRuntimeState {
  return {
    workspaceId,
    root,
    revision,
    container,
    lifecycle,
    lifecycleEnvironment: {
      PASEO_SOURCE_CHECKOUT_PATH: ".",
      PASEO_ROOT_PATH: ".",
      PASEO_WORKTREE_PATH: ".",
      PASEO_BRANCH_NAME: "",
    },
  };
}

function publicState(state: PrivateRuntimeState): RuntimeState {
  return {
    workspaceId: state.workspaceId,
    lifecycle: state.lifecycle,
    lifecycleEnvironment: state.lifecycleEnvironment,
  };
}

function runtimePlacement(state: PrivateRuntimeState): { cwd: string } {
  return { cwd: state.root };
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

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson<T>(schema: CommandRuntimeMessageSchema<T>, value: unknown): void {
  process.stdout.write(encodeCommandRuntimeMessage(schema, value));
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
