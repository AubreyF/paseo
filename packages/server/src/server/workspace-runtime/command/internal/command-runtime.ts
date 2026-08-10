import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type {
  WorkspaceDriverCreateInput,
  WorkspaceDriverInspection,
  WorkspaceDriverSpawnInput,
  WorkspacePipeProcess,
  WorkspacePtyProcess,
  WorkspaceRuntimeDriver,
} from "../../drivers/index.js";
import {
  CommandRuntimeDescribeResponseSchema,
  CommandRuntimeLifecycleResponseSchema,
  CommandRuntimePtyEventSchema,
} from "./protocol.js";

const COMMAND_RUNTIME_CLEANUP_TIMEOUT_MS = 1_000;

export interface CommandRuntimeConfig {
  command: readonly [string, ...string[]];
  options?: Readonly<Record<string, unknown>>;
}

export function createCommandRuntime(
  runtimeId: string,
  config: CommandRuntimeConfig,
): WorkspaceRuntimeDriver {
  let described: Promise<ReadonlySet<"pipes" | "pty">> | null = null;

  function describe(): Promise<ReadonlySet<"pipes" | "pty">> {
    described ??= runCommand(["describe"], undefined).then((output) => {
      const description = CommandRuntimeDescribeResponseSchema.parse(JSON.parse(output));
      if (!description.modes.includes("pipes")) {
        throw new Error(`Workspace runtime ${runtimeId} does not support pipes`);
      }
      return new Set(description.modes);
    });
    return described;
  }

  async function lifecycle(
    operation: "create" | "inspect" | "pause" | "resume" | "destroy",
    workspaceId: string,
    input?: WorkspaceDriverCreateInput,
  ) {
    await describe();
    const output = await runCommand(
      [operation, "--workspace-id", workspaceId],
      JSON.stringify({ protocolVersion: 1, input, options: config.options ?? {} }),
    );
    return CommandRuntimeLifecycleResponseSchema.parse(JSON.parse(output));
  }

  return {
    id: runtimeId,
    async create(input) {
      const response = await lifecycle("create", input.workspaceId, input);
      if (response.type !== "state") throw new Error(`Invalid create response from ${runtimeId}`);
      return response.state;
    },
    async inspect(workspaceId): Promise<WorkspaceDriverInspection> {
      const response = await lifecycle("inspect", workspaceId);
      if (response.type !== "inspection") {
        throw new Error(`Invalid inspect response from ${runtimeId}`);
      }
      return response.inspection as WorkspaceDriverInspection;
    },
    async spawn(input) {
      const modes = await describe();
      if (input.stdio.kind === "pty") {
        if (!modes.has("pty")) {
          throw new Error(`Workspace runtime ${runtimeId} does not support PTY mode`);
        }
        return spawnCommandPty(runtimeId, config.command, input, config.options ?? {});
      }
      return spawnCommandProcess(runtimeId, config.command, input, config.options ?? {});
    },
    async pause(workspaceId) {
      const response = await lifecycle("pause", workspaceId);
      if (response.type !== "ok") throw new Error(`Invalid pause response from ${runtimeId}`);
    },
    async resume(workspaceId) {
      const response = await lifecycle("resume", workspaceId);
      if (response.type !== "state") throw new Error(`Invalid resume response from ${runtimeId}`);
      return response.state;
    },
    async destroy(workspaceId) {
      const response = await lifecycle("destroy", workspaceId);
      if (response.type !== "ok") throw new Error(`Invalid destroy response from ${runtimeId}`);
    },
  };

  async function runCommand(args: string[], stdin: string | undefined): Promise<string> {
    const child = spawn(config.command[0], [...config.command.slice(1), ...args], {
      env: commandEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(`${stdin}\n`);
    const [stdout, stderr, exit] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
    ]);
    if (exit.code !== 0) {
      throw new Error(
        `Workspace runtime ${runtimeId} ${args[0]} failed (${exit.code ?? exit.signal}): ${stderr.trim()}`,
      );
    }
    return stdout;
  }
}

function spawnCommandPty(
  runtimeId: string,
  command: readonly [string, ...string[]],
  input: WorkspaceDriverSpawnInput,
  options: Readonly<Record<string, unknown>>,
): WorkspacePtyProcess {
  if (input.stdio.kind !== "pty") throw new Error("PTY spawn requires PTY stdio");
  const execId = randomBytes(16).toString("hex");
  const child = spawn(
    command[0],
    [...command.slice(1), "exec", "--workspace-id", input.workspaceId],
    {
      env: commandEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  const control = child.stdio[3] as Writable;
  const events = child.stdio[4] as Readable;
  const listeners = new Set<(data: string) => void>();
  let pendingData = "";
  const decoder = new StringDecoder("utf8");
  let stderr = "";
  let resizeId = 0;
  let pendingResizeId: number | null = null;
  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingWrites = "";
  let settled = false;
  let sawEof = false;
  let workloadExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let eventsEnded = false;
  let wrapperClosed = false;
  let resolveWrapperClosed!: () => void;
  const wrapperClosedPromise = new Promise<void>((resolve) => {
    resolveWrapperClosed = resolve;
  });
  let wrapperExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let failureCleanup: Promise<void> | null = null;
  let resolveExit!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let rejectExit!: (error: Error) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    },
  );
  exited.catch(() => undefined);

  child.stdout.on("data", (chunk: Buffer) => emitData(decoder.write(chunk)));
  child.stdout.once("end", () => emitData(decoder.end()));
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  void readNdjson(events, (value) => {
    const event = CommandRuntimePtyEventSchema.parse(value);
    if (event.type === "eof") {
      sawEof = true;
      return;
    }
    if (event.type === "resized") {
      if (event.id !== pendingResizeId) return;
      pendingResizeId = null;
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = null;
      if (pendingWrites) {
        child.stdin.write(pendingWrites);
        pendingWrites = "";
      }
      return;
    }
    if (event.type === "error") {
      failPty(new Error(`Workspace runtime ${runtimeId} PTY failed: ${event.message}`));
      return;
    }
    if (workloadExit) {
      throw new Error(`Workspace runtime ${runtimeId} returned duplicate PTY exit events`);
    }
    const signal = event.signal;
    let parsedSignal: NodeJS.Signals | null = null;
    if (signal !== null) {
      if (!isNodeSignal(signal)) {
        throw new Error(`Workspace runtime ${runtimeId} returned an invalid signal: ${signal}`);
      }
      parsedSignal = signal;
    }
    workloadExit = { code: event.code, signal: parsedSignal };
    child.stdin.end();
    control.end();
  }).then(
    () => {
      eventsEnded = true;
      finishFromAuthoritativeExit();
      return undefined;
    },
    (error) => {
      failPty(error);
      return undefined;
    },
  );
  control.once("error", failPty);
  child.stdin.once("error", failPty);
  child.once("error", (error) => {
    failPty(new Error(`Workspace runtime ${runtimeId} PTY failed: ${error.message}`));
  });
  child.once("close", (code, signal) => {
    wrapperClosed = true;
    wrapperExit = { code, signal };
    resolveWrapperClosed();
    finishFromAuthoritativeExit();
  });
  writeControl({
    type: "spawn",
    protocolVersion: 1,
    argv: input.argv,
    cwd: input.cwd,
    env: input.env,
    purpose: input.purpose,
    options,
    execId,
    stdio: input.stdio,
  });

  return {
    kind: "pty",
    onData(listener) {
      listeners.add(listener);
      if (pendingData) {
        const data = pendingData;
        pendingData = "";
        listener(data);
      }
      return () => listeners.delete(listener);
    },
    write(data) {
      if (pendingResizeId === null) child.stdin.write(data);
      else pendingWrites += data;
    },
    resize(cols, rows) {
      resizeId += 1;
      pendingResizeId = resizeId;
      writeControl({ type: "resize", protocolVersion: 1, id: resizeId, cols, rows });
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(
        () => failPty(new Error("PTY resize acknowledgement timed out")),
        1000,
      );
    },
    exited,
    kill(signal = "SIGTERM") {
      if (settled || failureCleanup) return;
      writeControl({ type: "signal", protocolVersion: 1, signal });
    },
  };

  function emitData(data: string): void {
    if (!data) return;
    if (listeners.size === 0) {
      pendingData += data;
      return;
    }
    for (const listener of listeners) listener(data);
  }

  function writeControl(value: unknown): void {
    try {
      control.write(`${JSON.stringify(value)}\n`);
    } catch (error) {
      failPty(error);
    }
  }

  function finishFromAuthoritativeExit(): void {
    if (settled || failureCleanup || !eventsEnded || !wrapperClosed) return;
    if (!workloadExit || !sawEof) {
      const detail = stderr.trim() || wrapperExit?.signal || wrapperExit?.code || "unknown";
      failPty(
        new Error(
          `Workspace runtime ${runtimeId} PTY wrapper ended without a valid fd4 exit event (${detail})`,
        ),
      );
      return;
    }
    settled = true;
    resolveExit(workloadExit);
  }

  function failPty(error: unknown): void {
    if (settled || failureCleanup) return;
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = null;
    control.destroy();
    events.destroy();
    child.stdin.destroy();
    const failure = error instanceof Error ? error : new Error(String(error));
    failureCleanup = (async () => {
      let cleanupError: unknown;
      if (!wrapperClosed) {
        try {
          await forceKillCommandRuntime(
            command,
            input.workspaceId,
            execId,
            options,
            child,
            wrapperClosedPromise,
          );
        } catch (cleanupFailure) {
          cleanupError = cleanupFailure;
        }
      }
      settled = true;
      const cleanupDetail =
        cleanupError instanceof Error ? `; cleanup failed: ${cleanupError.message}` : "";
      rejectExit(
        new Error(`Workspace runtime ${runtimeId} PTY failed: ${failure.message}${cleanupDetail}`),
      );
    })();
  }
}

async function forceKillCommandRuntime(
  command: readonly [string, ...string[]],
  workspaceId: string,
  execId: string,
  options: Readonly<Record<string, unknown>>,
  wrapper: { kill(signal?: NodeJS.Signals): boolean },
  wrapperClosed: Promise<void>,
): Promise<void> {
  const signalCommand = spawn(
    command[0],
    [
      ...command.slice(1),
      "signal",
      "--workspace-id",
      workspaceId,
      "--exec-id",
      execId,
      "--signal",
      "SIGKILL",
    ],
    { env: commandEnvironment(), shell: false, stdio: ["pipe", "ignore", "ignore"] },
  );
  const signalResult = new Promise<Error | null>((resolve) => {
    let finished = false;
    const finish = (error: Error | null) => {
      if (finished) return;
      finished = true;
      resolve(error);
    };
    signalCommand.once("error", (error) => finish(error));
    signalCommand.stdin.once("error", (error) => finish(error));
    signalCommand.once("close", (code, signal) =>
      finish(
        code === 0 ? null : new Error(`signal helper failed (${code ?? signal ?? "unknown"})`),
      ),
    );
  });
  signalCommand.stdin.end(JSON.stringify({ protocolVersion: 1, options }));
  const helper = await waitBounded(signalResult, COMMAND_RUNTIME_CLEANUP_TIMEOUT_MS);
  let cleanupError: Error | null = null;
  if (helper.timedOut) {
    cleanupError = new Error("signal helper timed out");
    signalCommand.kill("SIGKILL");
  } else {
    cleanupError = helper.value;
    if (cleanupError) signalCommand.kill("SIGKILL");
  }
  wrapper.kill("SIGKILL");
  const wrapperResult = await waitBounded(wrapperClosed, COMMAND_RUNTIME_CLEANUP_TIMEOUT_MS);
  if (wrapperResult.timedOut) {
    const wrapperError = new Error("wrapper remained alive after SIGKILL");
    throw cleanupError ? new AggregateError([cleanupError, wrapperError]) : wrapperError;
  }
  if (cleanupError) throw cleanupError;
}

async function waitBounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    promise.then((value) => ({ timedOut: false as const, value })),
    new Promise<{ timedOut: true }>((resolve) => {
      timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}

function isNodeSignal(value: string): value is NodeJS.Signals {
  return value in constants.signals;
}

async function readNdjson(stream: Readable, receive: (value: unknown) => void): Promise<void> {
  let pending = "";
  for await (const chunk of stream) {
    pending += chunk.toString();
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line) receive(JSON.parse(line));
      newline = pending.indexOf("\n");
    }
  }
  if (pending.trim()) receive(JSON.parse(pending));
}

function spawnCommandProcess(
  runtimeId: string,
  command: readonly [string, ...string[]],
  input: WorkspaceDriverSpawnInput,
  options: Readonly<Record<string, unknown>>,
): WorkspacePipeProcess {
  const execId = randomBytes(16).toString("hex");
  const child = spawn(
    command[0],
    [...command.slice(1), "exec", "--workspace-id", input.workspaceId],
    {
      env: commandEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  const metadata = child.stdio[3] as Writable;
  metadata.on("error", () => {
    // The exec process owns the actionable spawn error through `exited`.
  });
  metadata.end(
    `${JSON.stringify({
      type: "spawn",
      protocolVersion: 1,
      argv: input.argv,
      cwd: input.cwd,
      env: input.env,
      purpose: input.purpose,
      options,
      execId,
      stdio: input.stdio,
    })}\n`,
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", (error) => {
        reject(new Error(`Workspace runtime ${runtimeId} exec failed: ${error.message}`));
      });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  return {
    kind: "pipes",
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill(signal = "SIGTERM") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (signal === "SIGKILL") {
        void forceKillCommandRuntime(
          command,
          input.workspaceId,
          execId,
          options,
          child,
          exited.then(
            () => undefined,
            () => undefined,
          ),
        ).catch(() => undefined);
      } else child.kill(signal);
    },
  };
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.FORCE_COLOR !== undefined) delete env.NO_COLOR;
  return env;
}
