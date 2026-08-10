import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import type {
  WorkspaceDriverCreateInput,
  WorkspaceDriverInspection,
  WorkspaceDriverSpawnInput,
  WorkspacePipeProcess,
  WorkspaceRuntimeDriver,
} from "../../drivers/index.js";
import {
  CommandRuntimeDescribeResponseSchema,
  CommandRuntimeLifecycleResponseSchema,
} from "./protocol.js";

export interface CommandRuntimeConfig {
  command: readonly [string, ...string[]];
  options?: Readonly<Record<string, unknown>>;
}

export function createCommandRuntime(
  runtimeId: string,
  config: CommandRuntimeConfig,
): WorkspaceRuntimeDriver {
  let described: Promise<void> | null = null;

  function ensureCompatible(): Promise<void> {
    described ??= runCommand(["describe"], undefined).then((output) => {
      const description = CommandRuntimeDescribeResponseSchema.parse(JSON.parse(output));
      if (!description.modes.includes("pipes")) {
        throw new Error(`Workspace runtime ${runtimeId} does not support pipes`);
      }
      return undefined;
    });
    return described;
  }

  async function lifecycle(
    operation: "create" | "inspect" | "pause" | "resume" | "destroy",
    workspaceId: string,
    input?: WorkspaceDriverCreateInput,
  ) {
    await ensureCompatible();
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
      await ensureCompatible();
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
    JSON.stringify({
      protocolVersion: 1,
      argv: input.argv,
      cwd: input.cwd,
      env: input.env,
      purpose: input.purpose,
      options,
      execId,
    }),
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", (error) => {
        reject(new Error(`Workspace runtime ${runtimeId} exec failed: ${error.message}`));
      });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  function forceKill(): void {
    const signalCommand = spawn(
      command[0],
      [
        ...command.slice(1),
        "signal",
        "--workspace-id",
        input.workspaceId,
        "--exec-id",
        execId,
        "--signal",
        "SIGKILL",
      ],
      { env: commandEnvironment(), shell: false, stdio: ["pipe", "ignore", "ignore"] },
    );
    signalCommand.stdin.end(JSON.stringify({ protocolVersion: 1, options }));
    signalCommand.once("close", () => child.kill("SIGKILL"));
    signalCommand.once("error", () => child.kill("SIGKILL"));
  }

  return {
    kind: "pipes",
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill(signal = "SIGTERM") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (signal === "SIGKILL") forceKill();
      else child.kill(signal);
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
