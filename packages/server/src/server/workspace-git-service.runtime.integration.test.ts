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
  new URL("../../../../runtimes/fixture/src/index.mjs", import.meta.url),
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

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
      beginWorkspaceDeletion: async () => {},
      removeWorkspaceRecord: async (id) => {
        runtimeIds.delete(id);
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

test("workspace Git disposal waits for runtime observation teardown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-runtime-git-dispose-"));
  cleanupRoots.push(root);
  const source = await createRepository(path.join(root, "source"));
  const workspaceId = "runtime-git-dispose";
  const runtimeIds = new Map<string, string>();
  const workspaceRuntime = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => {
      runtimeIds.delete(id);
    },
  });
  await workspaceRuntime.create({
    workspaceId,
    runtimeId: "local",
    project: { id: "dispose-project", source: { kind: "host-directory", path: source } },
    placement: { kind: "existing" },
  });

  const boundRuntime = await workspaceRuntime.bind(workspaceId);
  const originalSubscribe = boundRuntime.files.subscribe.bind(boundRuntime.files);
  const unsubscribeStarted = createDeferred();
  const unsubscribeReleased = createDeferred();
  boundRuntime.files.subscribe = async (...args) => {
    const subscription = await originalSubscribe(...args);
    return {
      unsubscribe: async () => {
        unsubscribeStarted.resolve();
        await unsubscribeReleased.promise;
        await subscription.unsubscribe();
      },
    };
  };

  const workspaceGit = new WorkspaceGitServiceImpl({
    logger: createLogger(),
    paseoHome: path.join(root, "paseo-home"),
    workspaceRuntime,
  });
  const selectedGit = workspaceGit.bindWorkspace({ workspaceId, cwd: source });
  await selectedGit.observe(() => undefined);

  const disposal = workspaceGit.dispose();
  try {
    await eventWithin(unsubscribeStarted.promise, "runtime observation teardown");
    expect(
      await Promise.race([
        disposal.then(() => "disposed" as const),
        Promise.resolve("pending" as const),
      ]),
    ).toBe("pending");
  } finally {
    unsubscribeReleased.resolve();
  }
  await disposal;
  await workspaceRuntime.destroy(workspaceId);
});

test.each([
  ["local", "pause", "resume"],
  ["worktree", "archive", "restore"],
] as const)(
  "sole selected %s common-ref observation survives %s/%s",
  async (runtimeId, suspend, awaken) => {
    const root = await mkdtemp(path.join(tmpdir(), `paseo-${runtimeId}-git-lifecycle-`));
    cleanupRoots.push(root);
    const source = await createRepository(path.join(root, "source"));
    const workspaceId = `${runtimeId}-lifecycle`;
    const records = new Map<string, { runtimeId: string; archived: boolean }>();
    const service = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "paseo-home"),
      worktreesRoot: path.join(root, "worktrees"),
      resolveRuntimeId: async (id) => records.get(id)?.runtimeId ?? null,
      persistRuntimeId: async (id, selectedRuntimeId) => {
        records.set(id, { runtimeId: selectedRuntimeId, archived: false });
      },
      archiveWorkspaceRecord: async (id) => {
        const record = records.get(id);
        if (record) record.archived = true;
      },
      restoreWorkspaceRecord: async (id) => {
        const record = records.get(id);
        if (record) record.archived = false;
      },
      beginWorkspaceDeletion: async () => {},
      removeWorkspaceRecord: async (id) => {
        records.delete(id);
      },
    });
    await service.create({
      workspaceId,
      runtimeId,
      project: { id: "lifecycle-project", source: { kind: "host-directory", path: source } },
      placement:
        runtimeId === "local"
          ? { kind: "existing" }
          : {
              kind: "branch",
              branchName: "lifecycle-worktree",
              baseRef: "main",
              worktreeSlug: "lifecycle-worktree",
            },
    });

    let observeChanges = false;
    let resolveChanged!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve;
    });
    const subscription = await observeWorkspaceGit(await service.bind(workspaceId), () => {
      if (observeChanges) resolveChanged();
    });

    await service[suspend](workspaceId);
    await service[awaken](workspaceId);
    observeChanges = true;
    await createBranchThroughRuntime(service, workspaceId, `${runtimeId}-after-lifecycle`);
    await eventWithin(changed, `${runtimeId} common-ref update after lifecycle transition`);

    await subscription.unsubscribe();
    await service.destroy(workspaceId);
  },
  20_000,
);

test("replayed common-ref observation survives runtime service reconstruction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-git-observation-reconstruction-"));
  cleanupRoots.push(root);
  const source = await createRepository(path.join(root, "source"));
  const workspaceId = "reconstructed-observation";
  const records = new Map<string, { runtimeId: string; archived: boolean }>();
  const options = {
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id: string) => records.get(id)?.runtimeId ?? null,
    persistRuntimeId: async (id: string, runtimeId: string) => {
      records.set(id, { runtimeId, archived: false });
    },
    archiveWorkspaceRecord: async (id: string) => {
      const record = records.get(id);
      if (record) record.archived = true;
    },
    restoreWorkspaceRecord: async (id: string) => {
      const record = records.get(id);
      if (record) record.archived = false;
    },
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id: string) => {
      records.delete(id);
    },
  };
  const original = createWorkspaceRuntimeService(options);
  await original.create({
    workspaceId,
    runtimeId: "local",
    project: { id: "reconstructed-project", source: { kind: "host-directory", path: source } },
    placement: { kind: "existing" },
  });
  const originalSubscription = await observeWorkspaceGit(
    await original.bind(workspaceId),
    () => undefined,
  );
  await original.archive(workspaceId);

  const reconstructed = createWorkspaceRuntimeService(options);
  await reconstructed.restore(workspaceId);
  let resolveChanged!: () => void;
  const changed = new Promise<void>((resolve) => {
    resolveChanged = resolve;
  });
  const replayed = await observeWorkspaceGit(await reconstructed.bind(workspaceId), resolveChanged);
  await createBranchThroughRuntime(reconstructed, workspaceId, "after-reconstruction");
  await eventWithin(changed, "common-ref update after reconstruction replay");

  await originalSubscription.unsubscribe();
  await replayed.unsubscribe();
  await reconstructed.destroy(workspaceId);
}, 20_000);

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
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => {
      runtimeIds.delete(id);
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
  let phase: "first-change" | "after-pause-change" | "after-destroy-change" = "first-change";
  let resolveSiblingAfterOwnerPause!: () => void;
  const siblingChangedAfterOwnerPause = new Promise<void>((resolve) => {
    resolveSiblingAfterOwnerPause = resolve;
  });
  let resolveSiblingAfterOwnerDestroy!: () => void;
  const siblingChangedAfterOwnerDestroy = new Promise<void>((resolve) => {
    resolveSiblingAfterOwnerDestroy = resolve;
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
      if (phase === "after-pause-change") resolveSiblingAfterOwnerPause();
      if (phase === "after-destroy-change") resolveSiblingAfterOwnerDestroy();
    }),
    await observeWorkspaceGit(unrelatedGit, () => {
      unrelatedChanges += 1;
    }),
  ];
  await createBranchThroughRuntime(service, "sibling-a", "shared-ref-change");
  await Promise.all([
    eventWithin(firstChanged, "first sibling ref update"),
    eventWithin(siblingChanged, "second sibling ref update"),
  ]);
  expect(unrelatedChanges).toBe(0);

  await service.pause("sibling-a");
  phase = "after-pause-change";
  await createBranchThroughRuntime(service, "sibling-b", "shared-ref-after-owner-pause");
  await eventWithin(siblingChangedAfterOwnerPause, "sibling ref update after owner pause");
  expect(unrelatedChanges).toBe(0);

  await service.destroy("sibling-a");
  phase = "after-destroy-change";
  await createBranchThroughRuntime(service, "sibling-b", "shared-ref-after-owner-destroy");
  await eventWithin(siblingChangedAfterOwnerDestroy, "sibling ref update after owner destroy");
  expect(unrelatedChanges).toBe(0);

  await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
  await Promise.all([service.destroy("sibling-a"), service.destroy("sibling-b")]);
  await service.destroy("unrelated");
}, 20_000);

test("sibling Git observations stay workspace-bound across pause, resume, and unsubscribe", async () => {
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
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => {
      runtimeIds.delete(id);
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

  const [runtimeA, runtimeB] = await Promise.all([service.bind("race-a"), service.bind("race-b")]);
  let changesA = 0;
  let changesB = 0;
  let resolveA!: () => void;
  let resolveB!: () => void;
  const nextA = () =>
    new Promise<void>((resolve) => {
      resolveA = resolve;
    });
  const nextB = () =>
    new Promise<void>((resolve) => {
      resolveB = resolve;
    });
  const subscriptions = await Promise.all([
    observeWorkspaceGit(runtimeA, () => {
      changesA += 1;
      resolveA?.();
    }),
    observeWorkspaceGit(runtimeB, () => {
      changesB += 1;
      resolveB?.();
    }),
  ]);
  let eventA = nextA();
  let eventB = nextB();
  await createBranchThroughRuntime(service, "race-b", "race-both-active");
  await Promise.all([eventWithin(eventA, "sibling A"), eventWithin(eventB, "sibling B")]);

  await service.pause("race-a");
  const pausedChangesA = changesA;
  eventB = nextB();
  await createBranchThroughRuntime(service, "race-b", "race-a-paused");
  await eventWithin(eventB, "active sibling while A is paused");
  expect(changesA).toBe(pausedChangesA);

  await service.resume("race-a");
  eventA = nextA();
  eventB = nextB();
  await createBranchThroughRuntime(service, "race-b", "race-a-resumed");
  await Promise.all([eventWithin(eventA, "resumed sibling A"), eventWithin(eventB, "sibling B")]);

  await subscriptions[0].unsubscribe();
  const unsubscribedChangesA = changesA;
  eventB = nextB();
  await createBranchThroughRuntime(service, "race-b", "race-a-unsubscribed");
  await eventWithin(eventB, "remaining sibling B");
  expect(changesA).toBe(unsubscribedChangesA);
  await subscriptions[1].unsubscribe();

  await Promise.all([service.destroy("race-a"), service.destroy("race-b")]);
}, 20_000);

async function createBranchThroughRuntime(
  service: ReturnType<typeof createWorkspaceRuntimeService>,
  workspaceId: string,
  branch: string,
): Promise<void> {
  const runtime = await service.bind(workspaceId);
  const gitExecutable = await runtime.resolveCommand("git");
  expect(gitExecutable).not.toBeNull();
  const childProcess = await service.run({
    workspaceId,
    argv: [gitExecutable!, "branch", branch],
    env: { PATH: process.env.PATH ?? "" },
    purpose: { kind: "git" },
  });
  childProcess.stdin.end();
  await expect(childProcess.exited).resolves.toEqual({ code: 0, signal: null });
}

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
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => {
      runtimeIds.delete(id);
    },
    externalRuntimes: {
      fixture: {
        type: "command",
        command: [process.execPath, fixtureExecutable],
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
}, 40_000);

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
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => {
      runtimeIds.delete(id);
    },
    externalRuntimes: {
      fixture: {
        type: "command",
        command: [process.execPath, fixtureExecutable],
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
  const hostWriter = spawn(
    process.execPath,
    [
      "-e",
      "setTimeout(() => require('node:fs').writeFileSync('deleted.ts', 'host trap\\\\n'), 60000)",
    ],
    { cwd: hostDecoy, stdio: "ignore" },
  );

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
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (id) => {
      runtimeIds.delete(id);
    },
    externalRuntimes: {
      fixture: {
        type: "command",
        command: [process.execPath, fixtureExecutable],
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
  const runtimeA = await workspaceRuntime.bind("same-cwd-a");
  const nodeExecutable = await runtimeA.resolveCommand("node");
  expect(nodeExecutable).not.toBeNull();
  const createUntracked = await workspaceRuntime.run({
    workspaceId: "same-cwd-a",
    argv: [
      nodeExecutable!,
      "-e",
      "require('node:fs').writeFileSync('selected-proof.txt', 'runtime a untracked\\\\n')",
    ],
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
    argv: [
      nodeExecutable!,
      "-e",
      "require('node:fs').rmSync('selected-proof.txt', { force: true })",
    ],
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
}, 40_000);

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
