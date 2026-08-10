import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import { createWorkspaceRuntimeService } from "./index.js";

const fixtureExecutable = fileURLToPath(
  new URL("../test-utils/fixtures/workspace-runtime-command-fixture.mjs", import.meta.url),
);
const helperExecutable = fileURLToPath(
  new URL("../workspace-helper/executable.mjs", import.meta.url),
);
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("a trusted registered command is selected and receives secret launch data off argv", async () => {
  const fixture = await createFixture("registered");
  await fixture.service.create({
    ...fixture.createInput,
    setup: [{ argv: ["/bin/sh", "-c", "printf setup > setup-purpose.txt"], env: {} }],
  });
  const setupLaunch = JSON.parse(
    await readFile(path.join(fixture.source, ".runtime-launch.json"), "utf8"),
  ) as { purpose: unknown };
  expect(setupLaunch.purpose).toEqual({ kind: "setup" });
  const secret = "secret-shaped-workload-value";
  const process = await fixture.service.run({
    workspaceId: fixture.workspaceId,
    argv: [
      processExecPath(),
      "-e",
      "require('fs').writeFileSync('workload-secret.txt', process.env.SECRET_TOKEN)",
    ],
    env: { SECRET_TOKEN: secret },
    purpose: { kind: "workspace-script", script: "secure-envelope-contract" },
  });
  process.stdin.end();
  await expect(process.exited).resolves.toEqual({ code: 0, signal: null });
  expect(await readFile(path.join(fixture.source, "workload-secret.txt"), "utf8")).toBe(secret);
  const launch = JSON.parse(
    await readFile(path.join(fixture.source, ".runtime-launch.json"), "utf8"),
  ) as { argv: string[]; purpose: unknown };
  expect(JSON.stringify(launch.argv)).not.toContain(secret);
  expect(launch.purpose).toEqual({
    kind: "workspace-script",
    script: "secure-envelope-contract",
  });

  await expect(
    fixture.service.create({
      ...fixture.createInput,
      workspaceId: "unregistered",
      runtimeId: "nope",
    }),
  ).rejects.toThrow("Workspace runtime is not registered: nope");
  await fixture.service.destroy(fixture.workspaceId);
});

test("a command runtime tears down and reconstructs its bound files capability", async () => {
  const fixture = await createFixture("files-reconstruction");
  await writeFile(path.join(fixture.source, "watched.txt"), "before\n");
  await fixture.service.create(fixture.createInput);
  const files = fixture.service.files(fixture.workspaceId);
  const firstEvents: Array<{ type: string; error?: string }> = [];
  const first = await files.subscribe({ paths: ["watched.txt"] }, (event) => {
    firstEvents.push(event);
  });

  await fixture.service.pause(fixture.workspaceId);
  expect(firstEvents).toContainEqual({
    type: "error",
    error: "Workspace files client is closed",
  });
  await first.unsubscribe();
  await fixture.service.resume(fixture.workspaceId);
  await expect(files.list(".")).resolves.toMatchObject({ path: "." });

  const reconstructedEvents: Array<{ type: string; error?: string }> = [];
  await files.subscribe({ paths: ["watched.txt"] }, (event) => {
    reconstructedEvents.push(event);
  });
  await fixture.service.destroy(fixture.workspaceId);
  expect(reconstructedEvents).toContainEqual({
    type: "error",
    error: "Workspace files client is closed",
  });
});

test("a file operation racing pause cannot reconstruct the closing helper client", async () => {
  const fixture = await createFixture("files-pause-race", true);
  await writeFile(path.join(fixture.source, "watched.txt"), "before\n");
  await fixture.service.create(fixture.createInput);
  const files = fixture.service.files(fixture.workspaceId);
  await files.list(".");
  await writeFile(path.join(fixture.barrierDirectory, "block-next-inspect"), "block");
  const inspectEntered = nextFile(fixture.barrierDirectory, "inspect-entered");

  const racingList = files.list(".");
  await inspectEntered;
  await fixture.service.pause(fixture.workspaceId);
  await writeFile(path.join(fixture.barrierDirectory, "release-inspect"), "release");

  await expect(racingList).rejects.toThrow(`Workspace runtime is paused: ${fixture.workspaceId}`);
  await fixture.service.resume(fixture.workspaceId);
  await expect(files.list(".")).resolves.toMatchObject({ path: "." });
  await fixture.service.destroy(fixture.workspaceId);
});

test("the command runtime transports PTY input, Unicode output, resize, and signals", async () => {
  const fixture = await createFixture("pty");
  await fixture.service.create(fixture.createInput);
  const secret = "terminal-secret-value";
  const terminal = await fixture.service.openTerminal({
    workspaceId: fixture.workspaceId,
    argv: [
      processExecPath(),
      "-e",
      "process.stdin.setEncoding('utf8');process.stdout.write(`${process.stdout.isTTY}|${process.stdout.columns}x${process.stdout.rows}|λ|${process.env.SECRET}`);process.stdin.once('data',data=>{process.stdout.write(`|${data.trim()}|${process.stdout.columns}x${process.stdout.rows}`);process.exit(9)})",
    ],
    env: { SECRET: secret, PATH: process.env.PATH ?? "" },
    purpose: { kind: "terminal", terminalId: "command-pty" },
    rows: 24,
    cols: 80,
  });
  let output = "";
  terminal.onData((data) => {
    output += data;
  });
  await vi.waitFor(() => expect(output).toContain(`true|80x24|λ|${secret}`));
  terminal.resize(99, 41);
  terminal.write("héllo\n");
  await expect(terminal.exited).resolves.toEqual({ code: 9, signal: null });
  expect(output).toContain("|héllo|99x41");
  const launch = JSON.parse(
    await readFile(path.join(fixture.source, ".runtime-launch.json"), "utf8"),
  ) as { argv: string[] };
  expect(JSON.stringify(launch.argv)).not.toContain(secret);

  const signaled = await fixture.service.openTerminal({
    workspaceId: fixture.workspaceId,
    argv: ["/bin/sleep", "30"],
    env: { PATH: "/usr/bin:/bin" },
    purpose: { kind: "terminal", terminalId: "command-signal" },
    rows: 24,
    cols: 80,
  });
  signaled.kill("SIGTERM");
  await expect(signaled.exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
  const forced = await fixture.service.openTerminal({
    workspaceId: fixture.workspaceId,
    argv: ["/bin/sleep", "30"],
    env: { PATH: "/usr/bin:/bin" },
    purpose: { kind: "terminal", terminalId: "command-force" },
    rows: 24,
    cols: 80,
  });
  forced.kill("SIGKILL");
  await expect(forced.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
  await fixture.service.destroy(fixture.workspaceId);
});

test("a registered pipes-only command runtime fails closed when asked for a PTY", async () => {
  const fixture = await createFixture("pipes-only", false, "pipes");
  await fixture.service.create(fixture.createInput);

  await expect(
    fixture.service.openTerminal({
      workspaceId: fixture.workspaceId,
      argv: ["/bin/sh"],
      env: {},
      purpose: { kind: "terminal", terminalId: "unsupported-pty" },
      rows: 24,
      cols: 80,
    }),
  ).rejects.toThrow("Workspace runtime fixture does not support PTY mode");

  await fixture.service.destroy(fixture.workspaceId);
});

test("the fd4 workload exit remains authoritative after the wrapper exits", async () => {
  const fixture = await createFixture("delayed-pty-exit", false, "pty", {
    delayedPtyExitEvent: true,
  });
  await fixture.service.create(fixture.createInput);
  const terminal = await fixture.service.openTerminal({
    workspaceId: fixture.workspaceId,
    argv: [processExecPath(), "-e", "process.exit(6)"],
    env: {},
    purpose: { kind: "terminal", terminalId: "delayed-exit" },
    rows: 24,
    cols: 80,
  });

  await expect(terminal.exited).resolves.toEqual({ code: 6, signal: null });
  await fixture.service.destroy(fixture.workspaceId);
});

test("a wrapper exit without an fd4 workload exit rejects", async () => {
  const fixture = await createFixture("missing-pty-exit", false, "pty", {
    omitPtyExitEvent: true,
  });
  await fixture.service.create(fixture.createInput);
  const terminal = await fixture.service.openTerminal({
    workspaceId: fixture.workspaceId,
    argv: [processExecPath(), "-e", "process.exit(6)"],
    env: {},
    purpose: { kind: "terminal", terminalId: "missing-exit" },
    rows: 24,
    cols: 80,
  });

  await expect(terminal.exited).rejects.toThrow("ended without a valid fd4 exit event");
  await fixture.service.destroy(fixture.workspaceId);
});

test("an invalid fd4 event rejects and terminates the wrapper workload", async () => {
  const fixture = await createFixture("invalid-pty-event", false, "pty", {
    invalidPtyEvent: true,
  });
  const pidFile = path.join(fixture.source, "invalid-event.pid");
  await fixture.service.create(fixture.createInput);
  const terminal = await fixture.service.openTerminal({
    workspaceId: fixture.workspaceId,
    argv: [
      processExecPath(),
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
    ],
    env: {},
    purpose: { kind: "terminal", terminalId: "invalid-event" },
    rows: 24,
    cols: 80,
  });

  await expect(terminal.exited).rejects.toThrow("Invalid discriminator value");
  const workloadPid = Number(await readFile(pidFile, "utf8"));
  expect(processExists(workloadPid)).toBe(false);
  await fixture.service.destroy(fixture.workspaceId);
});

test("a failed PTY control channel rejects and terminates the wrapper workload", async () => {
  const fixture = await createFixture("failed-pty-control", false, "pty", {
    closePtyControl: true,
  });
  const pidFile = path.join(fixture.source, "failed-control.pid");
  await fixture.service.create(fixture.createInput);
  const terminal = await fixture.service.openTerminal({
    workspaceId: fixture.workspaceId,
    argv: [
      processExecPath(),
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
    ],
    env: {},
    purpose: { kind: "terminal", terminalId: "failed-control" },
    rows: 24,
    cols: 80,
  });
  const workloadPid = await vi.waitFor(async () => {
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(processExists(pid)).toBe(true);
    return pid;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  terminal.resize(100, 40);

  await expect(terminal.exited).rejects.toThrow("PTY resize acknowledgement timed out");
  expect(processExists(workloadPid)).toBe(false);
  await fixture.service.destroy(fixture.workspaceId);
});

test.each(["error", "hang"] as const)(
  "PTY cleanup is bounded when the signal helper ends with %s",
  async (signalHelperFailure) => {
    const fixture = await createFixture(`pty-signal-helper-${signalHelperFailure}`, false, "pty", {
      invalidPtyEvent: true,
      signalHelperFailure,
    });
    const pidFile = path.join(fixture.source, `signal-helper-${signalHelperFailure}.pid`);
    await fixture.service.create(fixture.createInput);
    const terminal = await fixture.service.openTerminal({
      workspaceId: fixture.workspaceId,
      argv: [
        processExecPath(),
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
      ],
      env: {},
      purpose: { kind: "terminal", terminalId: `signal-helper-${signalHelperFailure}` },
      rows: 24,
      cols: 80,
    });

    await expect(terminal.exited).rejects.toThrow("cleanup failed");
    const workloadPid = Number(await readFile(pidFile, "utf8"));
    expect(processExists(workloadPid)).toBe(false);
    await fixture.service.destroy(fixture.workspaceId);
  },
  5_000,
);

test("run admission racing pause cannot leave an unregistered workload running", async () => {
  const fixture = await createFixture("race", true);
  await fixture.service.create(fixture.createInput);
  await writeFile(path.join(fixture.barrierDirectory, "block-next-inspect"), "block");

  const runPromise = fixture.service.run({
    workspaceId: fixture.workspaceId,
    argv: [processExecPath(), "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    env: {},
    purpose: { kind: "workspace-script", script: "pause-race-contract" },
  });
  await vi.waitFor(() =>
    expect(existsSync(path.join(fixture.barrierDirectory, "inspect-entered"))).toBe(true),
  );
  const pausePromise = fixture.service.pause(fixture.workspaceId);
  await writeFile(path.join(fixture.barrierDirectory, "release-inspect"), "release");

  const workload = await runPromise;
  workload.stdin.end();
  await pausePromise;
  await expect(workload.exited).resolves.toMatchObject({ code: null });
  await expect(
    fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: ["/bin/true"],
      env: {},
      purpose: { kind: "workspace-script", script: "paused-admission-contract" },
    }),
  ).rejects.toThrow(`Workspace runtime is paused: ${fixture.workspaceId}`);
  await fixture.service.resume(fixture.workspaceId);
  await fixture.service.destroy(fixture.workspaceId);
}, 15_000);

test("an existing runtime selection cannot be switched before target driver dispatch", async () => {
  const fixture = await createFixture("immutable-selection");
  await fixture.service.create({ ...fixture.createInput, runtimeId: "local" });

  await expect(fixture.service.create(fixture.createInput)).rejects.toThrow(
    `Workspace runtime is already selected as local: ${fixture.workspaceId}`,
  );
  expect(await readdir(fixture.stateDirectory)).toEqual([]);

  await fixture.service.destroy(fixture.workspaceId);
});

async function createFixture(
  name: string,
  withBarrier = false,
  modes: "pipes" | "pty" = "pty",
  runtimeOptions: Readonly<Record<string, unknown>> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), `paseo-command-runtime-${name}-`));
  cleanupRoots.push(root);
  const source = path.join(root, "source");
  const stateDirectory = path.join(root, "state");
  const barrierDirectory = path.join(root, "barrier");
  await Promise.all([mkdir(source), mkdir(stateDirectory), mkdir(barrierDirectory)]);
  const runtimeIds = new Map<string, string>();
  const workspaceId = `${name}-workspace`;
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    externalRuntimes: {
      fixture: {
        type: "command",
        command: [
          processExecPath(),
          fixtureExecutable,
          ...(modes === "pipes" ? ["--modes", "pipes"] : []),
        ],
        helperCommand: [processExecPath(), helperExecutable],
        options: {
          stateDirectory,
          ...runtimeOptions,
          ...(withBarrier ? { inspectBarrierDirectory: barrierDirectory } : {}),
        },
      },
    },
  });
  return {
    source,
    stateDirectory,
    barrierDirectory,
    workspaceId,
    service,
    createInput: {
      workspaceId,
      runtimeId: "fixture",
      project: { id: `${name}-project`, source: { kind: "host-directory" as const, path: source } },
      placement: { kind: "existing" as const },
    },
  };
}

function processExecPath(): string {
  return process.execPath;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function nextFile(directory: string, expectedName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(directory, (_event, filename) => {
      if (filename?.toString() !== expectedName) return;
      watcher.close();
      resolve();
    });
    watcher.once("error", reject);
  });
}
