import type { BoundWorkspaceRuntime, WorkspaceProcess } from "./workspace-runtime/index.js";

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const WATCH_SCRIPT = String.raw`
const fs = require("node:fs");
const watcher = fs.watch(process.argv[1], { recursive: true }, () => process.stdout.write("changed\n"));
watcher.on("error", error => { process.stderr.write(String(error)); process.exit(1); });
process.stdout.write("ready\n");
`;
const STAT_SCRIPT = String.raw`
const fs = require("node:fs");
const stat = fs.statSync(process.argv[1], { bigint: true });
let mountNamespace = "host";
try { mountNamespace = fs.readlinkSync("/proc/self/ns/mnt"); } catch {}
process.stdout.write(mountNamespace + ":" + String(stat.dev) + ":" + String(stat.ino));
`;

interface CommonRefMember {
  runtime: BoundWorkspaceRuntime;
  listener: () => void;
}

interface CommonRefGroup {
  key: string;
  commonDir: string;
  members: Map<symbol, CommonRefMember>;
  process: WorkspaceProcess | null;
  owner: symbol | null;
  stopping: boolean;
  lifecycle: Promise<void>;
}

const commonRefGroups = new Map<string, CommonRefGroup>();

export async function observeWorkspaceGit(
  runtime: BoundWorkspaceRuntime,
  listener: () => void,
): Promise<{ unsubscribe(): Promise<void> }> {
  let ready = false;
  const workingTree = await runtime.files.subscribe(
    { paths: ["."], recursive: true, ignoredPaths: [".git"] },
    (event) => {
      if (ready && event.type !== "error") listener();
    },
  );

  let commonRefs: { unsubscribe(): Promise<void> } | null = null;
  try {
    const commonDir = await resolveCommonGitDirectory(runtime);
    if (commonDir) commonRefs = await subscribeCommonRefs(runtime, commonDir, listener);
    ready = true;
  } catch (error) {
    await workingTree.unsubscribe();
    throw error;
  }

  let closed = false;
  return {
    async unsubscribe() {
      if (closed) return;
      closed = true;
      await Promise.all([workingTree.unsubscribe(), commonRefs?.unsubscribe()]);
    },
  };
}

async function subscribeCommonRefs(
  runtime: BoundWorkspaceRuntime,
  commonDir: string,
  listener: () => void,
): Promise<{ unsubscribe(): Promise<void> }> {
  const key = await resolveFilesystemIdentity(runtime, commonDir);
  let group = commonRefGroups.get(key);
  if (!group) {
    group = {
      key,
      commonDir,
      members: new Map(),
      process: null,
      owner: null,
      stopping: false,
      lifecycle: Promise.resolve(),
    };
    commonRefGroups.set(key, group);
  }
  const memberId = Symbol(key);
  group.members.set(memberId, { runtime, listener });
  try {
    await updateGroupLifecycle(group, async () => {
      if (!group.process) await startGroup(group);
    });
  } catch (error) {
    await updateGroupLifecycle(group, async () => {
      group.members.delete(memberId);
      if (group.members.size === 0) {
        commonRefGroups.delete(key);
        await stopGroup(group);
      }
    });
    throw error;
  }

  let closed = false;
  return {
    async unsubscribe() {
      if (closed) return;
      closed = true;
      await updateGroupLifecycle(group, async () => {
        const wasOwner = group.owner === memberId;
        group.members.delete(memberId);
        if (group.members.size === 0) {
          commonRefGroups.delete(key);
          await stopGroup(group);
        } else if (wasOwner) {
          await stopGroup(group);
          if (group.members.size > 0) await startGroup(group);
        }
      });
    },
  };
}

function updateGroupLifecycle<T>(group: CommonRefGroup, update: () => Promise<T>): Promise<T> {
  const result = group.lifecycle.then(update, update);
  group.lifecycle = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function startGroup(group: CommonRefGroup, excludedOwner?: symbol): Promise<void> {
  const candidates = [...group.members].filter(([id]) => id !== excludedOwner);
  if (candidates.length === 0 && excludedOwner) {
    candidates.push(...group.members);
  }
  let lastError: unknown = null;
  for (const [memberId, member] of candidates) {
    try {
      const process = await member.runtime.run({
        argv: ["node", "-e", WATCH_SCRIPT, group.commonDir],
        env: runtimeCommandEnvironment(),
        purpose: { kind: "git" },
      });
      process.stdin.end();
      group.process = process;
      group.owner = memberId;
      group.stopping = false;
      await waitForReady(process, () => {
        if (group.process !== process) return;
        for (const current of group.members.values()) current.listener();
      });
      void drain(process.stderr);
      void process.exited.then(() => handleGroupExit(group, process, memberId));
      return;
    } catch (error) {
      const failedProcess = group.process;
      group.process = null;
      group.owner = null;
      if (failedProcess) {
        failedProcess.kill("SIGKILL");
        await failedProcess.exited.catch(() => undefined);
      }
      lastError = error;
    }
  }
  throw lastError ?? new Error("Git common-ref observer has no runtime owner");
}

async function stopGroup(group: CommonRefGroup): Promise<void> {
  const process = group.process;
  group.process = null;
  group.owner = null;
  if (!process) return;
  group.stopping = true;
  process.kill("SIGTERM");
  await process.exited.catch(() => undefined);
  group.stopping = false;
}

function handleGroupExit(group: CommonRefGroup, process: WorkspaceProcess, owner: symbol): void {
  void updateGroupLifecycle(group, async () => {
    if (group.process !== process) return;
    group.process = null;
    group.owner = null;
    if (group.stopping || group.members.size === 0 || commonRefGroups.get(group.key) !== group)
      return;
    await startGroup(group, owner);
    if (commonRefGroups.get(group.key) === group) {
      for (const member of group.members.values()) member.listener();
    }
  }).catch(() => undefined);
}

function waitForReady(process: WorkspaceProcess, onChange: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    let ready = false;
    process.stdout.on("data", (chunk) => {
      buffered += Buffer.from(chunk).toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "ready" && !ready) {
          ready = true;
          resolve();
        } else if (line === "changed" && ready) {
          onChange();
        }
      }
      if (!ready && Buffer.byteLength(buffered) > MAX_COMMAND_OUTPUT_BYTES) {
        process.kill("SIGKILL");
        reject(new Error("Git observer startup output exceeded 64 KiB"));
      }
    });
    void process.exited.then(() => {
      if (!ready) reject(new Error("Git common-ref observer exited before ready"));
      return undefined;
    });
  });
}

async function resolveCommonGitDirectory(runtime: BoundWorkspaceRuntime): Promise<string | null> {
  const result = await runBoundCommand(runtime, [
    "git",
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (result.exit.code !== 0 || result.exit.signal !== null) return null;
  return result.stdout.trim() || null;
}

async function resolveFilesystemIdentity(
  runtime: BoundWorkspaceRuntime,
  path: string,
): Promise<string> {
  const result = await runBoundCommand(runtime, ["node", "-e", STAT_SCRIPT, path]);
  if (result.exit.code !== 0 || result.exit.signal !== null || !result.stdout.trim()) {
    throw new Error(`Could not identify Git common directory: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function runBoundCommand(
  runtime: BoundWorkspaceRuntime,
  argv: readonly [string, ...string[]],
) {
  const process = await runtime.run({
    argv,
    env: runtimeCommandEnvironment(),
    purpose: { kind: "git" },
  });
  process.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    collect(process.stdout, process),
    collect(process.stderr, process),
    process.exited,
  ]);
  return { stdout, stderr, exit };
}

async function collect(stream: NodeJS.ReadableStream, process: WorkspaceProcess): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_COMMAND_OUTPUT_BYTES) {
      process.kill("SIGKILL");
      throw new Error("Git observation command output exceeded 64 KiB");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function drain(stream: NodeJS.ReadableStream): Promise<void> {
  for await (const _chunk of stream) {
    // Keep the long-running observer's diagnostic pipe flowing.
  }
}

function runtimeCommandEnvironment(): Readonly<Record<string, string>> {
  return {
    PATH: ["/usr/local/bin", "/usr/bin", "/bin", process.env.PATH].filter(Boolean).join(":"),
  };
}
