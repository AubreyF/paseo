import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createWorkspaceRuntimeService,
  type CreateWorkspaceInput,
  type WorkspaceRuntimeOptions,
  type WorkspaceRuntimeService,
} from "./index.js";

const cleanupRoots: string[] = [];
const posixDescribe = describe.runIf(process.platform !== "win32");

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

posixDescribe.each(["local", "worktree"] as const)("%s runtime public contract", (runtimeId) => {
  test("bound runtime exposes only process, file, and command-resolution primitives", async () => {
    const fixture = await createFixture(runtimeId);
    await fixture.service.create(fixture.createInput);

    const runtime = await fixture.service.bind(fixture.workspaceId);

    expect(Object.keys(runtime).sort()).toEqual(["files", "homeFiles", "resolveCommand", "run"]);
    await expect(runtime.resolveCommand("git")).resolves.toMatch(/^\//u);
    await expect(runtime.resolveCommand("paseo-command-that-does-not-exist")).resolves.toBeNull();
    await fixture.service.destroy(fixture.workspaceId);
  });

  test("binds streaming files and live observation to the selected runtime", async () => {
    const fixture = await createFixture(runtimeId);
    await fixture.service.create(fixture.createInput);
    const files = fixture.service.files(fixture.workspaceId);

    const listing = await files.list(".");
    expect(listing.entries.map((entry) => entry.name)).toContain("committed.txt");
    const initial = await files.stat("committed.txt");
    expect(initial).toMatchObject({ status: "ready", size: 10 });
    if (initial.status !== "ready") throw new Error("Expected committed.txt to exist");

    let resolveChanged!: () => void;
    const watcherEvents: Array<{ type: string; error?: string }> = [];
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve;
    });
    const subscription = await files.subscribe({ paths: ["committed.txt"] }, (event) => {
      watcherEvents.push(event);
      if (event.type === "changed" && event.paths.includes("committed.txt")) resolveChanged();
    });
    const terminalEdit = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: ["/bin/sh", "-c", "printf changed > committed.txt"],
      env: {},
      purpose: { kind: "terminal", terminalId: `${runtimeId}-file-edit` },
    });
    terminalEdit.stdin.end();
    await expect(terminalEdit.exited).resolves.toEqual({ code: 0, signal: null });
    await expect(changed).resolves.toBeUndefined();

    const streamed = await files.read("committed.txt");
    await expect(collect(streamed.chunks)).resolves.toBe("changed");
    await fixture.service.pause(fixture.workspaceId);
    expect(watcherEvents).toContainEqual({
      type: "error",
      error: "Workspace files client is closed",
    });
    await expect(files.list(".")).rejects.toThrow(`Workspace runtime is paused`);
    await subscription.unsubscribe();
    await fixture.service.resume(fixture.workspaceId);
    await expect(files.list(".")).resolves.toMatchObject({ path: "." });
    const reconstructedEvents: Array<{ type: string; error?: string }> = [];
    await files.subscribe({ paths: ["committed.txt"] }, (event) => {
      reconstructedEvents.push(event);
    });
    await fixture.service.destroy(fixture.workspaceId);
    expect(reconstructedEvents).toContainEqual({
      type: "error",
      error: "Workspace files client is closed",
    });
  });

  test("opens an interactive PTY with input, Unicode output, resize, EOF, and signals", async () => {
    const fixture = await createFixture(runtimeId);
    await fixture.service.create(fixture.createInput);

    const terminal = await fixture.service.openTerminal({
      workspaceId: fixture.workspaceId,
      argv: [
        process.execPath,
        "-e",
        "process.stdin.setEncoding('utf8');process.stdout.write(`${process.cwd()}|${process.stdout.isTTY}|${process.stdout.columns}x${process.stdout.rows}|λ`);process.stdin.once('data',data=>{const finish=()=>{process.stdout.write(`|${data.trim()}|${process.stdout.columns}x${process.stdout.rows}`);process.exit(7)};process.stdout.columns===101?finish():process.stdout.once('resize',finish)})",
      ],
      env: { PATH: process.env.PATH ?? "" },
      purpose: { kind: "terminal", terminalId: `${runtimeId}-terminal` },
      rows: 24,
      cols: 80,
      term: "xterm-256color",
    });
    const output = collectTerminal(terminal);
    await waitForTerminalOutput(output, "|true|80x24|λ");
    terminal.resize(101, 37);
    terminal.write("héllo\n");
    await expect(terminal.exited).resolves.toEqual({ code: 7, signal: null });
    expect(output.value()).toContain("|héllo|101x37");

    const signaled = await fixture.service.openTerminal({
      workspaceId: fixture.workspaceId,
      argv: ["/bin/sleep", "30"],
      env: { PATH: "/usr/bin:/bin" },
      purpose: { kind: "terminal", terminalId: `${runtimeId}-signal-terminal` },
      rows: 24,
      cols: 80,
    });
    signaled.kill("SIGTERM");
    await expect(signaled.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });

    const forced = await fixture.service.openTerminal({
      workspaceId: fixture.workspaceId,
      argv: ["/bin/sleep", "30"],
      env: { PATH: "/usr/bin:/bin" },
      purpose: { kind: "terminal", terminalId: `${runtimeId}-force-terminal` },
      rows: 24,
      cols: 80,
    });
    forced.kill("SIGKILL");
    await expect(forced.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });

    await fixture.service.destroy(fixture.workspaceId);
  });

  test("creates, pipes an exact environment, preserves status, and owns only its resources", async () => {
    const fixture = await createFixture(runtimeId);
    const created = await fixture.service.create(fixture.createInput);
    expect(created).toEqual({ workspaceId: fixture.workspaceId, runtimeId });
    expect("cwd" in created).toBe(false);

    const runtimeRoot = fixture.runtimeRoot();
    expect(await readFile(path.join(runtimeRoot, "committed.txt"), "utf8")).toBe("committed\n");
    if (runtimeId === "worktree") {
      expect(await readFile(path.join(runtimeRoot, "setup-owned.txt"), "utf8")).toBe("setup\n");
    }

    const child = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: [
        "/bin/sh",
        "-c",
        "cat > runtime-owned.txt; printf runtime-stdout; printf runtime-stderr >&2; exit 23",
      ],
      env: { RUNTIME_EXACT_ENV: runtimeId },
      purpose: { kind: "workspace-script", script: "public-contract" },
    });
    child.stdin.end(`${runtimeId}-state`);
    const [stdout, stderr, exit] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      child.exited,
    ]);
    expect({ stdout, stderr, exit }).toEqual({
      stdout: "runtime-stdout",
      stderr: "runtime-stderr",
      exit: { code: 23, signal: null },
    });

    const env = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: ["/usr/bin/env"],
      env: { RUNTIME_EXACT_ENV: runtimeId },
      purpose: { kind: "workspace-script", script: "environment-contract" },
    });
    env.stdin.end();
    await expect(collect(env.stdout)).resolves.toBe(`RUNTIME_EXACT_ENV=${runtimeId}\n`);
    await expect(env.exited).resolves.toEqual({ code: 0, signal: null });

    const signaled = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: ["/bin/sleep", "30"],
      env: {},
      purpose: { kind: "workspace-script", script: "signal-contract" },
    });
    signaled.stdin.end();
    signaled.kill("SIGTERM");
    await expect(signaled.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });

    await fixture.service.pause(fixture.workspaceId);
    const recovered = createWorkspaceRuntimeService(fixture.options);
    await expect(
      recovered.run({
        workspaceId: fixture.workspaceId,
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "paused-contract" },
      }),
    ).rejects.toThrow(`Workspace runtime is paused: ${fixture.workspaceId}`);
    await recovered.resume(fixture.workspaceId);
    expect(await readFile(path.join(runtimeRoot, "runtime-owned.txt"), "utf8")).toBe(
      `${runtimeId}-state`,
    );

    await recovered.destroy(fixture.workspaceId);
    expect(existsSync(fixture.repo)).toBe(true);
    expect(existsSync(runtimeRoot)).toBe(runtimeId === "local");
    await expect(
      recovered.run({
        workspaceId: fixture.workspaceId,
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "missing-contract" },
      }),
    ).rejects.toThrow(`Workspace runtime is missing: ${fixture.workspaceId}`);
  });

  test("repeated create does not rerun setup or change paused state", async () => {
    const fixture = await createFixture(runtimeId);
    const setupMarker = "idempotent-setup.txt";
    const input = {
      ...fixture.createInput,
      setup: [
        {
          argv: ["/bin/sh", "-c", `printf 'setup\\n' >> ${setupMarker}`] as const,
          env: {},
        },
      ],
    };
    await fixture.service.create(input);
    await fixture.service.pause(fixture.workspaceId);
    await fixture.service.create(input);
    expect(await readFile(path.join(fixture.runtimeRoot(), setupMarker), "utf8")).toBe("setup\n");
    await expect(
      fixture.service.run({
        workspaceId: fixture.workspaceId,
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "idempotence-contract" },
      }),
    ).rejects.toThrow(`Workspace runtime is paused: ${fixture.workspaceId}`);
    await fixture.service.resume(fixture.workspaceId);
    await fixture.service.destroy(fixture.workspaceId);
  });
});

posixDescribe("fail-closed and producer cleanup", () => {
  test("missing and unregistered selections never fall back to the host", async () => {
    const root = await temporaryRoot("fail-closed");
    const runtimeIds = new Map<string, string>();
    const service = createService(root, runtimeIds);
    await expect(
      service.run({
        workspaceId: "missing",
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "missing-selection" },
      }),
    ).rejects.toThrow("Workspace runtime is not selected: missing");
    runtimeIds.set("missing", "not-registered");
    await expect(
      service.run({
        workspaceId: "missing",
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "unregistered-selection" },
      }),
    ).rejects.toThrow("Workspace runtime is not registered: not-registered");
    await expect(
      service.create({
        workspaceId: "unknown",
        runtimeId: "not-registered",
        project: { id: "project", source: { kind: "host-directory", path: root } },
        placement: { kind: "existing" },
      }),
    ).rejects.toThrow("Workspace runtime is not registered: not-registered");
  });

  test("persistence failure destroys the newly-created worktree", async () => {
    const root = await temporaryRoot("persist-cleanup");
    const repo = await createRepository(root);
    const worktreesRoot = path.join(root, "worktrees");
    const service = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "home"),
      worktreesRoot,
      resolveRuntimeId: async () => null,
      persistRuntimeId: async () => {
        throw new Error("persistence failed");
      },
    });
    await expect(
      service.create({
        workspaceId: "../../hostile-id",
        runtimeId: "worktree",
        project: { id: "project", source: { kind: "host-directory", path: repo } },
        placement: {
          kind: "branch",
          branchName: "persist-cleanup",
          baseRef: "main",
          worktreeSlug: "persist-cleanup",
        },
      }),
    ).rejects.toThrow("persistence failed");
    expect(listLinkedWorktrees(repo)).toHaveLength(1);
    expect(existsSync(path.join(root, "hostile-id.json"))).toBe(false);
  });

  test("persistence failure removes newly-created local driver state", async () => {
    const root = await temporaryRoot("local-persist-cleanup");
    const repo = await createRepository(root);
    const service = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "home"),
      resolveRuntimeId: async () => null,
      persistRuntimeId: async () => {
        throw new Error("persistence failed");
      },
    });
    await expect(
      service.create({
        workspaceId: "../../hostile-local-id",
        runtimeId: "local",
        project: { id: "project", source: { kind: "host-directory", path: repo } },
        placement: { kind: "existing" },
      }),
    ).rejects.toThrow("persistence failed");
    await expect(
      service.run({
        workspaceId: "../../hostile-local-id",
        argv: ["/bin/true"],
        env: {},
        purpose: { kind: "workspace-script", script: "cleanup-contract" },
      }),
    ).rejects.toThrow("Workspace runtime is not selected");
    expect(existsSync(path.join(root, "hostile-local-id.json"))).toBe(false);
  });
});

posixDescribe.each(["local", "worktree"] as const)(
  "%s runtime confinement and process teardown",
  (runtimeId) => {
    test("rejects a symlink cwd that resolves outside the runtime root", async () => {
      const fixture = await createFixture(runtimeId);
      await fixture.service.create(fixture.createInput);
      const outside = path.join(fixture.root, "outside");
      await mkdir(outside);
      await symlink(outside, path.join(fixture.runtimeRoot(), "escape"));
      await expect(
        fixture.service.run({
          workspaceId: fixture.workspaceId,
          cwd: "escape",
          argv: ["/bin/pwd"],
          env: {},
          purpose: { kind: "workspace-script", script: "cwd-contract" },
        }),
      ).rejects.toThrow("Workspace cwd escapes its runtime root");
      await fixture.service.destroy(fixture.workspaceId);
    });

    test("pause escalates past ignored SIGTERM and leaves no descendant", async () => {
      const fixture = await createFixture(runtimeId);
      await fixture.service.create(fixture.createInput);
      const child = await fixture.service.run({
        workspaceId: fixture.workspaceId,
        argv: [
          process.execPath,
          "-e",
          "process.on('SIGTERM',()=>{});const c=require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});require('fs').writeFileSync('descendant.pid',String(c.pid));setInterval(()=>{},1000)",
        ],
        env: {},
        purpose: { kind: "workspace-script", script: "teardown-contract" },
      });
      child.stdin.end();
      const pidFile = path.join(fixture.runtimeRoot(), "descendant.pid");
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
      const descendantPid = Number((await readFile(pidFile, "utf8")).trim());
      const startedAt = Date.now();
      await fixture.service.pause(fixture.workspaceId);
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      await expect(child.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
      await vi.waitFor(() => expect(isProcessAlive(descendantPid)).toBe(false));
      await fixture.service.resume(fixture.workspaceId);
      await fixture.service.destroy(fixture.workspaceId);
    });
  },
);

async function createFixture(runtimeId: "local" | "worktree") {
  const root = await temporaryRoot(runtimeId);
  const repo = await createRepository(root);
  const runtimeIds = new Map<string, string>();
  const worktreesRoot = path.join(root, "worktrees");
  const options: WorkspaceRuntimeOptions = {
    paseoHome: path.join(root, "home"),
    worktreesRoot,
    resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
    persistRuntimeId: async (workspaceId, selectedRuntimeId) => {
      runtimeIds.set(workspaceId, selectedRuntimeId);
    },
  };
  const workspaceId = `${runtimeId}-workspace`;
  const createInput: CreateWorkspaceInput = {
    workspaceId,
    runtimeId,
    project: { id: `${runtimeId}-project`, source: { kind: "host-directory", path: repo } },
    placement:
      runtimeId === "local"
        ? { kind: "existing" }
        : {
            kind: "branch",
            branchName: "runtime-branch",
            baseRef: "main",
            worktreeSlug: "runtime-worktree",
          },
    setup:
      runtimeId === "worktree"
        ? [{ argv: ["/bin/sh", "-c", "printf 'setup\\n' > setup-owned.txt"], env: {} }]
        : undefined,
  };
  return {
    root,
    repo,
    options,
    workspaceId,
    createInput,
    service: createWorkspaceRuntimeService(options),
    runtimeRoot: () =>
      runtimeId === "local"
        ? repo
        : listLinkedWorktrees(repo).find((cwd) => path.basename(cwd) === "runtime-worktree")!,
  };
}

function createService(root: string, runtimeIds: Map<string, string>): WorkspaceRuntimeService {
  return createWorkspaceRuntimeService({
    paseoHome: path.join(root, "home"),
    resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
    persistRuntimeId: async (workspaceId, runtimeId) => {
      runtimeIds.set(workspaceId, runtimeId);
    },
  });
}

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `paseo-runtime-${name}-`));
  cleanupRoots.push(root);
  return root;
}

async function createRepository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repo });
  await writeFile(path.join(repo, "committed.txt"), "committed\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"], { cwd: repo });
  return repo;
}

function listLinkedWorktrees(repo: string): string[] {
  return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function collectTerminal(terminal: { onData(listener: (data: string) => void): () => void }): {
  value(): string;
} {
  let output = "";
  terminal.onData((data) => {
    output += data;
  });
  return { value: () => output };
}

async function waitForTerminalOutput(output: { value(): string }, marker: string): Promise<void> {
  await vi.waitFor(() => expect(output.value()).toContain(marker));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
