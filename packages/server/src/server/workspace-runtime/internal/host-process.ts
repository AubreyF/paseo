import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import type {
  WorkspaceDriverSpawnInput,
  WorkspacePipeProcess,
  WorkspaceProcessExit,
} from "../drivers/index.js";

export async function spawnHostProcess(
  root: string,
  input: WorkspaceDriverSpawnInput,
): Promise<WorkspacePipeProcess> {
  const cwd = await resolveRuntimeCwd(root, input.cwd);
  const child = spawn(input.argv[0], input.argv.slice(1), {
    cwd,
    env: { ...input.env },
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<WorkspaceProcessExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal: signal as NodeJS.Signals | null });
    });
  });

  return {
    kind: "pipes",
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill(signal = "SIGTERM") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process can exit between the state check and the signal.
        }
      }
      child.kill(signal);
    },
  };
}

export async function resolveRuntimeCwd(root: string, relativeCwd?: string): Promise<string> {
  const normalizedRoot = await realpath(root);
  const cwd = await realpath(path.resolve(normalizedRoot, relativeCwd ?? "."));
  const relative = path.relative(normalizedRoot, cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Workspace cwd escapes its runtime root: ${relativeCwd}`);
  }
  return cwd;
}
