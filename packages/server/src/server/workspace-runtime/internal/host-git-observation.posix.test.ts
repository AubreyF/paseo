import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import {
  createFileObserver,
  type FileObserver,
  type FileObserverCallback,
  type FileObserverOptions,
} from "../../file-observer/index.js";
import { createHostGitObservationOwner } from "./host-git-observation.js";

test("sibling host worktrees share one physical common-Git observation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-host-git-observation-"));
  try {
    const source = await repository(path.join(root, "source"));
    const sibling = path.join(root, "sibling");
    git(source, ["branch", "sibling"]);
    git(source, ["worktree", "add", sibling, "sibling"]);
    const unrelated = await repository(path.join(root, "unrelated"));
    const owner = createHostGitObservationOwner();

    const [sourceSubscription, siblingSubscription] = await Promise.all([
      owner.observe(source, () => undefined),
      owner.observe(sibling, () => undefined),
    ]);
    expect(owner.getDiagnostics().activeObservationCount).toBe(1);

    const unrelatedSubscription = await owner.observe(unrelated, () => undefined);
    expect(owner.getDiagnostics().activeObservationCount).toBe(2);

    await sourceSubscription.unsubscribe();
    expect(owner.getDiagnostics().activeObservationCount).toBe(2);
    await siblingSubscription.unsubscribe();
    expect(owner.getDiagnostics().activeObservationCount).toBe(1);
    await unrelatedSubscription.unsubscribe();
    expect(owner.getDiagnostics().activeObservationCount).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed physical common watcher rebinds once without changing logical ownership", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-host-git-rebind-"));
  try {
    const source = await repository(path.join(root, "source"));
    const sibling = path.join(root, "sibling");
    git(source, ["branch", "sibling"]);
    git(source, ["worktree", "add", sibling, "sibling"]);
    const observer = new InstrumentedFileObserver();
    const owner = createHostGitObservationOwner(observer);
    let notifications = 0;
    const subscriptions = await Promise.all([
      owner.observe(source, () => {
        notifications += 1;
      }),
      owner.observe(sibling, () => {
        notifications += 1;
      }),
    ]);
    expect(observer.subscribeCount).toBe(1);
    expect(observer.getDiagnostics().activeObservationCount).toBe(1);

    observer.failActive(new Error("physical watcher failed"));
    const barrier = await owner.observe(sibling, () => undefined);
    expect(notifications).toBe(2);
    expect(observer.subscribeCount).toBe(2);
    expect(observer.getDiagnostics().activeObservationCount).toBe(1);

    await Promise.all([
      ...subscriptions.map((subscription) => subscription.unsubscribe()),
      barrier.unsubscribe(),
    ]);
    expect(observer.getDiagnostics().activeObservationCount).toBe(0);
    await observer.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class InstrumentedFileObserver implements FileObserver {
  readonly observer = createFileObserver();
  readonly callbacks = new Set<FileObserverCallback>();
  subscribeCount = 0;

  async subscribe(
    directory: string,
    callback: FileObserverCallback,
    options?: FileObserverOptions,
  ) {
    this.subscribeCount += 1;
    this.callbacks.add(callback);
    const subscription = await this.observer.subscribe(directory, callback, options);
    let active = true;
    return {
      updateIgnore: (paths: string[]) => subscription.updateIgnore(paths),
      unsubscribe: async () => {
        if (!active) return;
        active = false;
        this.callbacks.delete(callback);
        await subscription.unsubscribe();
      },
    };
  }

  failActive(error: Error): void {
    for (const callback of this.callbacks) callback(error, []);
  }

  getDiagnostics() {
    return this.observer.getDiagnostics();
  }

  close(): Promise<void> {
    return this.observer.close();
  }
}

async function repository(directory: string): Promise<string> {
  await mkdir(directory);
  git(directory, ["init", "-b", "main"]);
  git(directory, ["config", "user.email", "test@getpaseo.local"]);
  git(directory, ["config", "user.name", "Paseo Test"]);
  await writeFile(path.join(directory, "tracked.txt"), "tracked\n");
  git(directory, ["add", "."]);
  git(directory, ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
  return directory;
}

function git(cwd: string, argv: string[]): void {
  execFileSync("git", argv, { cwd, stdio: "pipe" });
}
