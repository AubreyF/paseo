import { execFileSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import { createWorkspaceRuntimeService } from "./index.js";

const fixtureExecutable = fileURLToPath(
  new URL("../../../../fixture-workspace-runtime/src/index.mjs", import.meta.url),
);
const helperExecutable = fileURLToPath(
  new URL("../workspace-helper/executable.mjs", import.meta.url),
);
const rebindHelperExecutable = fileURLToPath(
  new URL("../test-utils/fixtures/workspace-helper-rebind-fixture.mjs", import.meta.url),
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

test("equal display cwd values never share external runtime execution, files, Git, or caches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-command-runtime-equal-display-"));
  cleanupRoots.push(root);
  const sources = [path.join(root, "source-a"), path.join(root, "source-b")];
  const stateDirectories = [path.join(root, "state-a"), path.join(root, "state-b")];
  await Promise.all([...sources, ...stateDirectories].map((directory) => mkdir(directory)));
  for (const [index, source] of sources.entries()) {
    execFileSync("git", ["init", "-b", "main"], { cwd: source });
    execFileSync("git", ["config", "user.email", "paseo@example.com"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: source });
    await writeFile(path.join(source, "tracked.txt"), "base\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: source });
    execFileSync("git", ["commit", "-m", "base"], { cwd: source });
    await writeFile(path.join(source, `only-${index === 0 ? "a" : "b"}.txt`), "before");
  }
  const runtimeIds = new Map<string, string>();
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => void runtimeIds.set(id, runtimeId),
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => void runtimeIds.delete(id),
    externalRuntimes: Object.fromEntries(
      ["a", "b"].map((suffix, index) => [
        `fixture-${suffix}`,
        {
          type: "command" as const,
          command: [processExecPath(), fixtureExecutable] as const,
          helperCommand: [processExecPath(), helperExecutable] as const,
          options: {
            stateDirectory: stateDirectories[index],
            displayCwd: "/workspace",
            exposeHostVisiblePath: false,
          },
        },
      ]),
    ),
  });

  for (const [index, suffix] of ["a", "b"].entries()) {
    await service.create({
      workspaceId: `equal-${suffix}`,
      runtimeId: `fixture-${suffix}`,
      project: {
        id: `project-${suffix}`,
        source: { kind: "host-directory", path: sources[index] },
      },
      placement: { kind: "existing" },
    });
  }
  await expect(service.inspect("equal-a")).resolves.toEqual({ status: "ready", cwd: "/workspace" });
  await expect(service.inspect("equal-b")).resolves.toEqual({ status: "ready", cwd: "/workspace" });
  await expect(service.requireHostVisiblePath("equal-a")).rejects.toThrow("no host-visible path");
  expect(await service.bind("equal-a")).not.toBe(await service.bind("equal-b"));

  await expect(
    service.files("equal-a").write({ path: "only-a.txt", contents: Buffer.from("a") }),
  ).resolves.toMatchObject({ status: "written" });
  await expect(
    service.files("equal-b").write({ path: "only-b.txt", contents: Buffer.from("b") }),
  ).resolves.toMatchObject({ status: "written" });
  await expect(service.files("equal-a").stat("only-b.txt")).resolves.toMatchObject({
    status: "missing",
  });
  await expect(service.files("equal-b").stat("only-a.txt")).resolves.toMatchObject({
    status: "missing",
  });

  const statuses = await Promise.all(
    ["a", "b"].map(async (suffix) => {
      const workload = await service.run({
        workspaceId: `equal-${suffix}`,
        argv: ["git", "status", "--porcelain"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        purpose: { kind: "git" },
      });
      workload.stdin.end();
      const output = await collectText(workload.stdout);
      await workload.exited;
      return output;
    }),
  );
  expect(statuses[0]).toContain("only-a.txt");
  expect(statuses[0]).not.toContain("only-b.txt");
  expect(statuses[1]).toContain("only-b.txt");
  expect(statuses[1]).not.toContain("only-a.txt");

  await service.destroy("equal-a");
  await service.destroy("equal-b");
});

test.each(["/tmp", "../outside", "outside-link"])(
  "the external runtime itself rejects workspace cwd escape %s",
  async (cwd) => {
    const fixture = await createFixture(`cwd-${cwd.replaceAll(/[^a-z]/g, "-")}`);
    const outside = path.join(fixture.root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(fixture.source, "outside-link"), "dir");
    await fixture.service.create(fixture.createInput);

    const escaped = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      cwd,
      argv: [processExecPath(), "-e", "process.exit(0)"],
      env: {},
      purpose: { kind: "workspace-script", script: "cwd-confinement" },
    });
    escaped.stdin.end();
    await expect(escaped.exited).rejects.toThrow("Workspace cwd escapes its runtime root");
    await fixture.service.destroy(fixture.workspaceId);
  },
);

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

test("a failed second subscription rebind rolls back the staged observer set before retry", async () => {
  const fixture = await createFixture("transactional-rebind", false, "pty", {}, (root) => [
    processExecPath(),
    rebindHelperExecutable,
    helperExecutable,
    path.join(root, "watch-launches"),
  ]);
  await Promise.all([
    writeFile(path.join(fixture.source, "first.txt"), "before\n"),
    writeFile(path.join(fixture.source, "second.txt"), "before\n"),
  ]);
  await fixture.service.create(fixture.createInput);
  const files = fixture.service.files(fixture.workspaceId);
  let observeChanges = false;
  let resolveFirstChange!: () => void;
  let resolveSecondChange!: () => void;
  const firstChange = new Promise<void>((resolve) => {
    resolveFirstChange = resolve;
  });
  const secondChange = new Promise<void>((resolve) => {
    resolveSecondChange = resolve;
  });
  const subscriptions = await Promise.all([
    files.subscribe({ paths: ["first.txt"] }, (event) => {
      if (observeChanges && event.type === "changed") resolveFirstChange();
    }),
    files.subscribe({ paths: ["second.txt"] }, (event) => {
      if (observeChanges && event.type === "changed") resolveSecondChange();
    }),
  ]);

  await fixture.service.pause(fixture.workspaceId);
  await expect(fixture.service.resume(fixture.workspaceId)).rejects.toThrow(
    "Workspace helper subscribe acknowledgement timed out",
  );
  await expect(files.list(".")).rejects.toThrow(
    `Workspace runtime is recovering: ${fixture.workspaceId}`,
  );
  await fixture.service.resume(fixture.workspaceId);

  observeChanges = true;
  await Promise.all([
    writeFile(path.join(fixture.source, "first.txt"), "after\n"),
    writeFile(path.join(fixture.source, "second.txt"), "after\n"),
  ]);
  await Promise.all([firstChange, secondChange]);
  expect(Number(await readFile(path.join(fixture.root, "watch-launches"), "utf8"))).toBe(4);

  await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
  expect(
    execFileSync("ps", ["-axo", "command="], { encoding: "utf8" })
      .split("\n")
      .some(
        (command) =>
          command.includes("workspace-helper-rebind-fixture.mjs") &&
          command.includes(path.basename(fixture.root)),
      ),
  ).toBe(false);
  await fixture.service.destroy(fixture.workspaceId);
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

test.each(["success", "error", "hang"] as const)(
  "a crashed pipes wrapper reaps its detached workload when the signal helper ends with %s",
  async (signalHelperResult) => {
    const fixture = await createFixture(`pipes-wrapper-crash-${signalHelperResult}`, false, "pty", {
      crashPipeWrapper: true,
      ...(signalHelperResult === "success" ? {} : { signalHelperFailure: signalHelperResult }),
    });
    const pidFile = path.join(fixture.source, `crashed-pipe-${signalHelperResult}.pid`);
    await fixture.service.create(fixture.createInput);
    const workload = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: [
        processExecPath(),
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
      ],
      env: {},
      purpose: { kind: "workspace-script", script: "wrapper-crash" },
    });
    workload.stdin.end();

    await expect(workload.exited).rejects.toThrow(
      signalHelperResult === "success"
        ? "pipes wrapper ended without a valid fd4 exit event"
        : "cleanup failed",
    );
    const workloadPid = Number(await readFile(pidFile, "utf8"));
    expect(processExists(workloadPid)).toBe(false);
    const later = await fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: [processExecPath(), "-e", "process.exit(0)"],
      env: {},
      purpose: { kind: "workspace-script", script: "later-execution" },
    });
    later.stdin.end();
    await expect(later.exited).resolves.toEqual({ code: 0, signal: null });
    await fixture.service.destroy(fixture.workspaceId);
  },
  5_000,
);

test("a command runtime protocol version mismatch fails with the authored and expected versions", async () => {
  const fixture = await createFixture("version-mismatch", false, "pty", {
    describeProtocolVersion: 2,
  });

  await expect(fixture.service.create(fixture.createInput)).rejects.toThrow(
    "unsupported command protocol version 2; expected 1",
  );
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

test.each([
  ["exit-before-eof", "pipes", ["started", "exit", "eof"], "exit before eof"],
  ["eof-before-started", "pipes", ["eof", "started", "exit"], "eof before started"],
  ["duplicate-started", "pipes", ["started", "started"], "duplicate started"],
  ["duplicate-eof", "pipes", ["started", "eof", "eof"], "duplicate eof"],
  ["duplicate-exit", "pipes", ["started", "eof", "exit", "exit"], "duplicate exit"],
  ["post-exit-event", "pipes", ["started", "eof", "exit", "eof"], "event after exit"],
  ["pty-resize-before-started", "pty", ["resized"], "resized before started"],
  ["pty-resize-after-eof", "pty", ["started", "eof", "resized"], "resized after eof"],
] as const)(
  "an external %s fd4 violation rejects only after its exact workload is absent",
  async (name, mode, processEventSequence, expected) => {
    const pidRoot = await mkdtemp(path.join(tmpdir(), `paseo-fd4-${name}-`));
    cleanupRoots.push(pidRoot);
    const pidFile = path.join(pidRoot, "workload.pid");
    const barrierFile = path.join(pidRoot, "release-events");
    const fixture = await createFixture(`fd4-${name}`, false, "pty", {
      processEventSequence,
      processEventPurposeKind: mode === "pty" ? "terminal" : "workspace-script",
      recordWorkloadPidAt: pidFile,
      processEventBarrierPath: barrierFile,
    });
    await fixture.service.create(fixture.createInput);
    let workloadPid: number | undefined;
    try {
      const workload =
        mode === "pty"
          ? await fixture.service.openTerminal({
              workspaceId: fixture.workspaceId,
              argv: [processExecPath(), "-e", "setInterval(()=>{},1000)"],
              env: {},
              purpose: { kind: "terminal", terminalId: name },
              rows: 24,
              cols: 80,
            })
          : await fixture.service.run({
              workspaceId: fixture.workspaceId,
              argv: [processExecPath(), "-e", "setInterval(()=>{},1000)"],
              env: {},
              purpose: { kind: "workspace-script", script: name },
            });
      if (workload.kind === "pipes") workload.stdin.end();
      await writeFile(barrierFile, "release");
      const failure = await workload.exited.then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(expected);
      workloadPid = Number(await readFile(pidFile, "utf8"));
      expect(processExists(workloadPid)).toBe(false);
    } finally {
      if (workloadPid && processExists(workloadPid)) {
        try {
          process.kill(-workloadPid, "SIGKILL");
        } catch {
          // The assertion above owns the cleanup verdict; this is failure-only containment.
        }
      }
      await fixture.service.destroy(fixture.workspaceId);
    }
  },
  8_000,
);

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

test("an invalid resize is rejected before PTY state or workload changes", async () => {
  const fixture = await createFixture("invalid-resize");
  await fixture.service.create(fixture.createInput);
  const terminal = await fixture.service.openTerminal({
    workspaceId: fixture.workspaceId,
    argv: [
      processExecPath(),
      "-e",
      "process.stdin.setEncoding('utf8');process.stdin.once('data',data=>{process.stdout.write(`${data.trim()}|${process.stdout.columns}x${process.stdout.rows}`);process.exit(0)})",
    ],
    env: {},
    purpose: { kind: "terminal", terminalId: "invalid-resize" },
    rows: 24,
    cols: 80,
  });
  let output = "";
  terminal.onData((data) => {
    output += data;
  });

  expect(() => terminal.resize(0, 40)).toThrow();
  terminal.resize(101, 37);
  terminal.write("alive\n");

  await expect(terminal.exited).resolves.toEqual({ code: 0, signal: null });
  expect(output).toContain("alive|101x37");
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
  helperCommand?: (root: string) => readonly [string, ...string[]],
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
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => {
      runtimeIds.delete(id);
    },
    externalRuntimes: {
      fixture: {
        type: "command",
        command: [
          processExecPath(),
          fixtureExecutable,
          ...(modes === "pipes" ? ["--modes", "pipes"] : []),
          ...(runtimeOptions.describeProtocolVersion === undefined
            ? []
            : ["--protocol-version", String(runtimeOptions.describeProtocolVersion)]),
        ],
        helperCommand: helperCommand?.(root) ?? [processExecPath(), helperExecutable],
        options: {
          stateDirectory,
          ...runtimeOptions,
          ...(withBarrier ? { inspectBarrierDirectory: barrierDirectory } : {}),
        },
      },
    },
  });
  return {
    root,
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

async function collectText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
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
