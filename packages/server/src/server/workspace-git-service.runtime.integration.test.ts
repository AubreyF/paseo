import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { observeWorkspaceGit } from "./workspace-git-observation.js";
import { createWorkspaceRuntimeService } from "./workspace-runtime/index.js";

const fixtureExecutable = fileURLToPath(
  new URL("./test-utils/fixtures/workspace-runtime-command-fixture.mjs", import.meta.url),
);
const helperExecutable = fileURLToPath(
  new URL("./workspace-helper/executable.mjs", import.meta.url),
);
const cleanupRoots: string[] = [];

function eventWithin(event: Promise<void>, label: string): Promise<void> {
  return Promise.race([
    event,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000),
    ),
  ]);
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.each(["local", "worktree"] as const)(
  "selected %s workspace Git uses the same bound runtime journey",
  async (runtimeId) => {
    const root = await mkdtemp(path.join(tmpdir(), `paseo-${runtimeId}-git-`));
    cleanupRoots.push(root);
    const source = await createRepository(path.join(root, "source"));
    const publicAddress = path.join(root, "public-workspace-address");
    const workspaceId = `${runtimeId}-git-workspace`;
    const runtimeIds = new Map<string, string>();
    const workspaceRuntime = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "paseo-home"),
      worktreesRoot: path.join(root, "worktrees"),
      resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
      persistRuntimeId: async (id, selectedRuntimeId) => {
        runtimeIds.set(id, selectedRuntimeId);
      },
    });
    await workspaceRuntime.create({
      workspaceId,
      runtimeId,
      project: { id: `${runtimeId}-project`, source: { kind: "host-directory", path: source } },
      placement:
        runtimeId === "local"
          ? { kind: "existing" }
          : {
              kind: "branch",
              branchName: "slice-4-worktree",
              baseRef: "main",
              worktreeSlug: "slice-4-worktree",
            },
    });
    const workspaceGit = new WorkspaceGitServiceImpl({
      logger: createLogger(),
      paseoHome: path.join(root, "paseo-home"),
      worktreesRoot: path.join(root, "worktrees"),
      workspaceRuntime,
    });
    const selectedGit = workspaceGit.bindWorkspace({ workspaceId, cwd: publicAddress });

    await workspaceRuntime.files(workspaceId).write({
      path: "tracked.txt",
      contents: Buffer.from(`${runtimeId} edit\n`),
    });
    const dirty = await selectedGit.getSnapshot({
      force: true,
      includeForge: false,
      reason: `${runtimeId}-edit`,
    });
    const diff = await selectedGit.getCheckoutDiff(
      { mode: "uncommitted", includeStructured: true },
      { force: true, reason: `${runtimeId}-edit` },
    );
    expect(dirty.git).toMatchObject({ isGit: true, isDirty: true });
    expect(JSON.stringify(diff)).toContain(`${runtimeId} edit`);

    const originalBranch = runtimeId === "local" ? "main" : "slice-4-worktree";
    await selectedGit.commit({ message: `${runtimeId} commit`, addAll: true });
    await selectedGit.createBranch({
      branch: `${runtimeId}-next`,
      baseRef: originalBranch,
    });
    await selectedGit.switchBranch(originalBranch);
    const clean = await selectedGit.getSnapshot();
    expect(clean.git).toMatchObject({ isDirty: false, currentBranch: originalBranch });

    await workspaceGit.dispose();
    await workspaceRuntime.destroy(workspaceId);
  },
  20_000,
);

test("selected sibling worktrees share common-ref fan-out without touching an unrelated workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-runtime-git-fanout-"));
  cleanupRoots.push(root);
  const source = await createRepository(path.join(root, "source"));
  const unrelated = await createRepository(path.join(root, "unrelated"));
  const runtimeIds = new Map<string, string>();
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    worktreesRoot: path.join(root, "worktrees"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
  });
  for (const [workspaceId, branchName] of [
    ["sibling-a", "sibling-a"],
    ["sibling-b", "sibling-b"],
  ] as const) {
    await service.create({
      workspaceId,
      runtimeId: "worktree",
      project: { id: "fanout-project", source: { kind: "host-directory", path: source } },
      placement: { kind: "branch", branchName, baseRef: "main", worktreeSlug: branchName },
    });
  }
  await service.create({
    workspaceId: "unrelated",
    runtimeId: "local",
    project: { id: "unrelated-project", source: { kind: "host-directory", path: unrelated } },
    placement: { kind: "existing" },
  });

  let resolveFirst!: () => void;
  let resolveSibling!: () => void;
  const firstChanged = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const siblingChanged = new Promise<void>((resolve) => {
    resolveSibling = resolve;
  });
  let phase: "initial" | "first-change" | "owner-reselected" | "after-pause-change" = "initial";
  let resolveSiblingOwnerReselected!: () => void;
  const siblingOwnerReselected = new Promise<void>((resolve) => {
    resolveSiblingOwnerReselected = resolve;
  });
  let resolveSiblingAfterOwnerPause!: () => void;
  const siblingChangedAfterOwnerPause = new Promise<void>((resolve) => {
    resolveSiblingAfterOwnerPause = resolve;
  });
  let unrelatedChanges = 0;
  const siblingA = await service.bind("sibling-a");
  const siblingB = await service.bind("sibling-b");
  const unrelatedGit = await service.bind("unrelated");
  const subscriptions = [
    await observeWorkspaceGit(siblingA, () => {
      if (phase === "first-change") resolveFirst();
    }),
    await observeWorkspaceGit(siblingB, () => {
      if (phase === "first-change") resolveSibling();
      if (phase === "owner-reselected") resolveSiblingOwnerReselected();
      if (phase === "after-pause-change") resolveSiblingAfterOwnerPause();
    }),
    await observeWorkspaceGit(unrelatedGit, () => {
      unrelatedChanges += 1;
    }),
  ];
  unrelatedChanges = 0;
  phase = "first-change";
  const branch = await service.run({
    workspaceId: "sibling-a",
    argv: ["git", "branch", "shared-ref-change"],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    purpose: { kind: "git" },
  });
  branch.stdin.end();
  await expect(branch.exited).resolves.toEqual({ code: 0, signal: null });
  await Promise.all([
    eventWithin(firstChanged, "first sibling ref update"),
    eventWithin(siblingChanged, "second sibling ref update"),
  ]);
  expect(unrelatedChanges).toBe(0);

  phase = "owner-reselected";
  await service.pause("sibling-a");
  await eventWithin(siblingOwnerReselected, "common-ref observer owner re-selection");
  phase = "after-pause-change";
  const branchAfterPause = await service.run({
    workspaceId: "sibling-b",
    argv: ["git", "branch", "shared-ref-after-owner-pause"],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    purpose: { kind: "git" },
  });
  branchAfterPause.stdin.end();
  await expect(branchAfterPause.exited).resolves.toEqual({ code: 0, signal: null });
  await eventWithin(siblingChangedAfterOwnerPause, "sibling ref update after owner pause");
  expect(unrelatedChanges).toBe(0);

  await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
  await Promise.all([service.destroy("sibling-a"), service.destroy("sibling-b")]);
  await service.destroy("unrelated");
}, 20_000);

test("concurrent sibling subscriptions own exactly one common-ref watcher until final unsubscribe", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-runtime-git-watcher-race-"));
  cleanupRoots.push(root);
  const source = await createRepository(path.join(root, "source"));
  const runtimeIds = new Map<string, string>();
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    worktreesRoot: path.join(root, "worktrees"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
  });
  for (const workspaceId of ["race-a", "race-b"] as const) {
    await service.create({
      workspaceId,
      runtimeId: "worktree",
      project: { id: "race-project", source: { kind: "host-directory", path: source } },
      placement: {
        kind: "branch",
        branchName: workspaceId,
        baseRef: "main",
        worktreeSlug: workspaceId,
      },
    });
  }

  let releaseLaunch!: () => void;
  const launchReleased = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  let firstLaunchEntered!: () => void;
  const firstLaunch = new Promise<void>((resolve) => {
    firstLaunchEntered = resolve;
  });
  let watcherLaunches = 0;
  let activeWatchers = 0;
  let maximumActiveWatchers = 0;
  const instrument = async (workspaceId: string) => {
    const runtime = await service.bind(workspaceId);
    return {
      files: runtime.files,
      run: async (input: Parameters<typeof runtime.run>[0]) => {
        const isCommonRefWatcher =
          input.argv[0] === "node" &&
          input.argv[1] === "-e" &&
          input.argv[2]?.includes("fs.watch(process.argv[1]") === true;
        if (isCommonRefWatcher) {
          watcherLaunches += 1;
          firstLaunchEntered();
          await launchReleased;
        }
        const process = await runtime.run(input);
        if (isCommonRefWatcher) {
          activeWatchers += 1;
          maximumActiveWatchers = Math.max(maximumActiveWatchers, activeWatchers);
          void process.exited.finally(() => {
            activeWatchers -= 1;
          });
        }
        return process;
      },
    };
  };
  const [runtimeA, runtimeB] = await Promise.all([instrument("race-a"), instrument("race-b")]);
  const subscriptionsPromise = Promise.all([
    observeWorkspaceGit(runtimeA, () => undefined),
    observeWorkspaceGit(runtimeB, () => undefined),
  ]);

  await firstLaunch;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(watcherLaunches).toBe(1);
  releaseLaunch();
  const subscriptions = await subscriptionsPromise;
  expect(maximumActiveWatchers).toBe(1);

  await subscriptions[0].unsubscribe();
  expect(activeWatchers).toBe(1);
  await subscriptions[1].unsubscribe();
  expect(activeWatchers).toBe(0);

  await Promise.all([service.destroy("race-a"), service.destroy("race-b")]);
}, 20_000);

test("selected workspace Git reads and mutations stay inside its command runtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-runtime-git-"));
  cleanupRoots.push(root);
  const runtimeRepository = await createRepository(path.join(root, "runtime-repository"));
  const hostDecoy = await createRepository(path.join(root, "host-decoy"));
  const remoteRepository = path.join(root, "remote.git");
  await mkdir(remoteRepository);
  git(remoteRepository, "init", "--bare", "--initial-branch=main");
  git(runtimeRepository, "remote", "add", "origin", remoteRepository);
  git(runtimeRepository, "push", "-u", "origin", "main");
  const stateDirectory = path.join(root, "runtime-state");
  await mkdir(stateDirectory);
  const workspaceId = "runtime-git-workspace";
  const runtimeIds = new Map<string, string>();
  const workspaceRuntime = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    externalRuntimes: {
      fixture: {
        type: "command",
        command: [process.execPath, fixtureExecutable],
        helperCommand: [process.execPath, helperExecutable],
        options: { stateDirectory, recordLaunchInWorkspace: false },
      },
    },
  });
  await workspaceRuntime.create({
    workspaceId,
    runtimeId: "fixture",
    project: {
      id: "runtime-git-project",
      source: { kind: "host-directory", path: runtimeRepository },
    },
    placement: { kind: "existing" },
  });
  const service = new WorkspaceGitServiceImpl({
    logger: createLogger(),
    paseoHome: path.join(root, "paseo-home"),
    workspaceRuntime,
  });
  const selectedGit = service.bindWorkspace({ workspaceId, cwd: hostDecoy });

  await workspaceRuntime.files(workspaceId).write({
    path: "tracked.txt",
    contents: Buffer.from("runtime edit\n"),
  });
  await writeFile(path.join(hostDecoy, "tracked.txt"), "host edit\n");
  git(hostDecoy, "branch", "host-only");

  const dirty = await selectedGit.getSnapshot({
    force: true,
    includeForge: false,
    reason: "runtime-edit",
  });
  const diff = await selectedGit.getCheckoutDiff(
    { mode: "uncommitted", includeStructured: true },
    { force: true, reason: "runtime-edit" },
  );
  expect(dirty.git).toMatchObject({ isGit: true, isDirty: true, currentBranch: "main" });
  expect(dirty.git.repoRoot).toBe(hostDecoy);
  expect(JSON.stringify(dirty)).not.toContain(runtimeRepository);
  expect(JSON.stringify(diff)).toContain("runtime edit");
  expect(JSON.stringify(diff)).not.toContain("host edit");
  await expect(selectedGit.switchBranch("host-only")).rejects.toThrow(
    "Branch not found: host-only",
  );
  await selectedGit.stashPush("paseo-runtime-stash");
  expect((await selectedGit.getSnapshot({ force: true, reason: "stash-push" })).git.isDirty).toBe(
    false,
  );
  await selectedGit.stashPop(0);
  expect((await selectedGit.getSnapshot({ force: true, reason: "stash-pop" })).git.isDirty).toBe(
    true,
  );

  await expect(selectedGit.mergeToBase({ baseRef: "main" })).rejects.toThrow(
    "Selected workspace Git does not support merge to base",
  );
  await expect(selectedGit.mergeFromBase({ baseRef: "main" })).rejects.toThrow(
    "Selected workspace Git does not support merge from base",
  );
  await expect(selectedGit.renameBranch("selected-rename")).rejects.toThrow(
    "Selected workspace Git does not support branch rename",
  );
  await expect(selectedGit.push()).rejects.toThrow("Selected workspace Git does not support push");

  await selectedGit.commit({ message: "runtime commit", addAll: true });
  await selectedGit.createBranch({ branch: "runtime-branch", baseRef: "main" });
  await selectedGit.switchBranch("main");
  const clean = await selectedGit.getSnapshot({
    force: true,
    includeForge: false,
    reason: "runtime-mutations",
  });

  expect(clean.git).toMatchObject({ isDirty: false, currentBranch: "main" });
  expect(await readFile(path.join(runtimeRepository, "tracked.txt"), "utf8")).toBe(
    "runtime edit\n",
  );
  expect(await readFile(path.join(hostDecoy, "tracked.txt"), "utf8")).toBe("host edit\n");
  expect(git(runtimeRepository, "log", "-1", "--format=%s")).toBe("runtime commit");
  expect(git(runtimeRepository, "branch", "--list", "runtime-branch")).toBe("runtime-branch");

  const upstream = path.join(root, "upstream");
  execFileSync("git", ["clone", remoteRepository, upstream], { stdio: "pipe" });
  git(upstream, "config", "user.email", "test@example.com");
  git(upstream, "config", "user.name", "Paseo Test");
  await writeFile(path.join(upstream, "upstream.txt"), "upstream\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "upstream commit");
  git(upstream, "push", "origin", "main");
  await selectedGit.fetch();
  const fetched = await selectedGit.getSnapshot();
  expect(fetched.git.behindOfOrigin).toBe(1);

  await workspaceRuntime.destroy(workspaceId);
  git(runtimeRepository, "checkout", "runtime-branch");
  await workspaceRuntime.create({
    workspaceId,
    runtimeId: "fixture",
    project: {
      id: "runtime-git-project",
      source: { kind: "host-directory", path: runtimeRepository },
    },
    placement: { kind: "existing" },
  });
  const reconstructed = await selectedGit.getSnapshot();
  expect(reconstructed.git.currentBranch).toBe("runtime-branch");

  await service.dispose();
  await workspaceRuntime.destroy(workspaceId);
}, 20_000);

test("selected commit history highlighting never reads a deleted file from the host cwd", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-runtime-git-history-"));
  cleanupRoots.push(root);
  const runtimeRepository = await createRepository(path.join(root, "runtime-repository"));
  await writeFile(path.join(runtimeRepository, "deleted.ts"), "export const runtimeOnly = 1;\n");
  git(runtimeRepository, "add", "deleted.ts");
  git(runtimeRepository, "commit", "-m", "add runtime history file");
  await rm(path.join(runtimeRepository, "deleted.ts"));
  git(runtimeRepository, "add", "deleted.ts");
  git(runtimeRepository, "commit", "-m", "delete runtime history file");
  const deletionSha = git(runtimeRepository, "rev-parse", "HEAD");
  const hostDecoy = await createRepository(path.join(root, "host-decoy"));
  const hostTrap = path.join(hostDecoy, "deleted.ts");
  execFileSync("mkfifo", [hostTrap]);

  const stateDirectory = path.join(root, "runtime-state");
  await mkdir(stateDirectory);
  const runtimeIds = new Map<string, string>();
  const workspaceRuntime = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    externalRuntimes: {
      fixture: {
        type: "command",
        command: [process.execPath, fixtureExecutable],
        helperCommand: [process.execPath, helperExecutable],
        options: { stateDirectory, recordLaunchInWorkspace: false },
      },
    },
  });
  await workspaceRuntime.create({
    workspaceId: "history-workspace",
    runtimeId: "fixture",
    project: { id: "history-project", source: { kind: "host-directory", path: runtimeRepository } },
    placement: { kind: "existing" },
  });
  const service = new WorkspaceGitServiceImpl({
    logger: createLogger(),
    paseoHome: path.join(root, "paseo-home"),
    workspaceRuntime,
  });
  const selectedGit = service.bindWorkspace({
    workspaceId: "history-workspace",
    cwd: hostDecoy,
  });
  const hostWriter = spawn("/bin/sh", ["-c", "printf 'host trap\\n' > deleted.ts"], {
    cwd: hostDecoy,
    stdio: "ignore",
  });

  const file = await selectedGit.getCommitFileDiff({ sha: deletionSha, path: "deleted.ts" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(file?.isDeleted).toBe(true);
  expect(hostWriter.exitCode).toBeNull();

  hostWriter.kill("SIGKILL");
  await new Promise<void>((resolve) => hostWriter.once("exit", () => resolve()));
  await service.dispose();
  await workspaceRuntime.destroy("history-workspace");
}, 20_000);

test("selected workspaces with the same public cwd keep Git state, mutations, and caches isolated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-runtime-git-same-cwd-"));
  cleanupRoots.push(root);
  const runtimeARepository = await createRepository(path.join(root, "runtime-a"));
  const runtimeBRepository = await createRepository(path.join(root, "runtime-b"));
  git(runtimeBRepository, "branch", "-m", "runtime-b");
  const publicCwd = await createRepository(path.join(root, "shared-public-cwd"));
  git(publicCwd, "branch", "-m", "host-decoy");
  await writeFile(path.join(publicCwd, "selected-proof.txt"), Buffer.alloc(32, 0));
  const stateDirectory = path.join(root, "runtime-state");
  await mkdir(stateDirectory);
  const runtimeIds = new Map<string, string>();
  const workspaceRuntime = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    externalRuntimes: {
      fixture: {
        type: "command",
        command: [process.execPath, fixtureExecutable],
        helperCommand: [process.execPath, helperExecutable],
        options: { stateDirectory, recordLaunchInWorkspace: false },
      },
    },
  });
  for (const [workspaceId, source] of [
    ["same-cwd-a", runtimeARepository],
    ["same-cwd-b", runtimeBRepository],
  ] as const) {
    await workspaceRuntime.create({
      workspaceId,
      runtimeId: "fixture",
      project: { id: workspaceId, source: { kind: "host-directory", path: source } },
      placement: { kind: "existing" },
    });
  }
  const service = new WorkspaceGitServiceImpl({
    logger: createLogger(),
    paseoHome: path.join(root, "paseo-home"),
    workspaceRuntime,
    deps: { getWorkspaceGitSelfHealPhaseMs: () => 60_000 },
  });
  const workspaceA = service.bindWorkspace({ workspaceId: "same-cwd-a", cwd: publicCwd });
  const workspaceB = service.bindWorkspace({ workspaceId: "same-cwd-b", cwd: publicCwd });

  await workspaceRuntime.files("same-cwd-a").write({
    path: "tracked.txt",
    contents: Buffer.from("runtime a dirty\n"),
  });
  const createUntracked = await workspaceRuntime.run({
    workspaceId: "same-cwd-a",
    argv: ["/bin/sh", "-c", "printf 'runtime a untracked\\n' > selected-proof.txt"],
    env: {},
    purpose: { kind: "git" },
  });
  createUntracked.stdin.end();
  await expect(createUntracked.exited).resolves.toEqual({ code: 0, signal: null });
  const [snapshotA, snapshotB, diffA, diffB] = await Promise.all([
    workspaceA.getSnapshot({ force: true, includeForge: false, reason: "same-cwd-a" }),
    workspaceB.getSnapshot({ force: true, includeForge: false, reason: "same-cwd-b" }),
    workspaceA.getCheckoutDiff(
      { mode: "uncommitted", includeStructured: true },
      { force: true, reason: "same-cwd-a" },
    ),
    workspaceB.getCheckoutDiff(
      { mode: "uncommitted", includeStructured: true },
      { force: true, reason: "same-cwd-b" },
    ),
  ]);
  expect(snapshotA.git).toMatchObject({ currentBranch: "main", isDirty: true });
  expect(snapshotB.git).toMatchObject({ currentBranch: "runtime-b", isDirty: false });
  expect(JSON.stringify(diffA)).toContain("runtime a dirty");
  expect(JSON.stringify(diffA)).toContain("runtime a untracked");
  expect(JSON.stringify(diffB)).not.toContain("runtime a dirty");
  const removeUntracked = await workspaceRuntime.run({
    workspaceId: "same-cwd-a",
    argv: ["/bin/rm", "selected-proof.txt"],
    env: {},
    purpose: { kind: "git" },
  });
  removeUntracked.stdin.end();
  await expect(removeUntracked.exited).resolves.toEqual({ code: 0, signal: null });

  let observedAWaiter: { dirty: boolean; resolve: () => void } | null = null;
  let observedBWaiter: { dirty: boolean; resolve: () => void } | null = null;
  let workspaceAChanges = 0;
  let workspaceBChanges = 0;
  const workspaceBStates: Array<{ branch: string | null; dirty: boolean | null }> = [];
  const [observationA, observationB] = await Promise.all([
    workspaceA.observe((snapshot) => {
      workspaceAChanges += 1;
      if (observedAWaiter?.dirty === snapshot.git.isDirty) {
        observedAWaiter.resolve();
        observedAWaiter = null;
      }
    }),
    workspaceB.observe((snapshot) => {
      workspaceBChanges += 1;
      workspaceBStates.push({
        branch: snapshot.git.currentBranch,
        dirty: snapshot.git.isDirty,
      });
      if (observedBWaiter?.dirty === snapshot.git.isDirty) {
        observedBWaiter.resolve();
        observedBWaiter = null;
      }
    }),
  ]);

  const waitForObservedA = (dirty: boolean) =>
    new Promise<void>((resolve) => {
      observedAWaiter = { dirty, resolve };
    });
  const waitForObservedB = (dirty: boolean) =>
    new Promise<void>((resolve) => {
      observedBWaiter = { dirty, resolve };
    });
  const observedAClean = waitForObservedA(false);
  await workspaceRuntime.files("same-cwd-a").write({
    path: "tracked.txt",
    contents: Buffer.from("initial\n"),
  });
  await observedAClean;
  const observedBDirty = waitForObservedB(true);
  await workspaceRuntime.files("same-cwd-b").write({
    path: "tracked.txt",
    contents: Buffer.from("runtime b startup barrier\n"),
  });
  await observedBDirty;
  const observedBClean = waitForObservedB(false);
  await workspaceRuntime.files("same-cwd-b").write({
    path: "tracked.txt",
    contents: Buffer.from("initial\n"),
  });
  await observedBClean;
  workspaceAChanges = 0;
  workspaceBChanges = 0;
  workspaceBStates.length = 0;
  const observedA = waitForObservedA(true);
  const observedB = waitForObservedB(true);
  await workspaceRuntime.files("same-cwd-a").write({
    path: "tracked.txt",
    contents: Buffer.from("runtime a watched\n"),
  });
  await observedA;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(workspaceAChanges).toBeGreaterThan(0);
  expect(workspaceBStates).toEqual([]);
  await workspaceRuntime.files("same-cwd-b").write({
    path: "tracked.txt",
    contents: Buffer.from("runtime b watched\n"),
  });
  await observedB;
  expect(workspaceBChanges).toBeGreaterThan(0);
  const restoredB = waitForObservedB(false);
  await workspaceRuntime.files("same-cwd-b").write({
    path: "tracked.txt",
    contents: Buffer.from("initial\n"),
  });
  await restoredB;
  await Promise.all([observationA.unsubscribe(), observationB.unsubscribe()]);

  await Promise.all([
    workspaceA.commit({ message: "runtime a commit", addAll: true }),
    workspaceB.createBranch({ branch: "runtime-b-next", baseRef: "runtime-b" }),
  ]);
  const [mutatedA, mutatedB] = await Promise.all([
    workspaceA.getSnapshot({ force: true, includeForge: false, reason: "mutated-a" }),
    workspaceB.getSnapshot({ force: true, includeForge: false, reason: "mutated-b" }),
  ]);
  expect(mutatedA.git).toMatchObject({ currentBranch: "main", isDirty: false });
  expect(mutatedB.git).toMatchObject({ currentBranch: "runtime-b-next", isDirty: false });
  expect(git(runtimeARepository, "log", "-1", "--format=%s")).toBe("runtime a commit");
  expect(git(runtimeARepository, "branch", "--list", "runtime-b-next")).toBe("");
  expect(git(runtimeBRepository, "branch", "--show-current")).toBe("runtime-b-next");
  expect(git(publicCwd, "branch", "--show-current")).toBe("host-decoy");

  await workspaceRuntime.destroy("same-cwd-a");
  git(runtimeARepository, "branch", "-m", "runtime-a-rebuilt");
  await workspaceRuntime.create({
    workspaceId: "same-cwd-a",
    runtimeId: "fixture",
    project: {
      id: "same-cwd-a",
      source: { kind: "host-directory", path: runtimeARepository },
    },
    placement: { kind: "existing" },
  });
  const [rebuiltA, cachedB] = await Promise.all([
    workspaceA.getSnapshot(),
    workspaceB.getSnapshot(),
  ]);
  expect(rebuiltA.git.currentBranch).toBe("runtime-a-rebuilt");
  expect(cachedB.git.currentBranch).toBe("runtime-b-next");

  await service.dispose();
  await Promise.all([
    workspaceRuntime.destroy("same-cwd-a"),
    workspaceRuntime.destroy("same-cwd-b"),
  ]);
}, 20_000);

async function createRepository(directory: string): Promise<string> {
  await mkdir(directory);
  git(directory, "init", "-b", "main");
  git(directory, "config", "user.email", "test@example.com");
  git(directory, "config", "user.name", "Paseo Test");
  await writeFile(path.join(directory, ".git", "info", "exclude"), ".runtime-launch.json\n");
  await writeFile(path.join(directory, "tracked.txt"), "initial\n");
  git(directory, "add", ".");
  git(directory, "commit", "-m", "initial");
  return directory;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function createLogger() {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}
