import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { WorkspaceWatchEvent } from "./index.js";
import { bindWorkspaceHelper, type WorkspaceHelperProcess } from "./integration/index.js";

const posixDescribe = describe.runIf(process.platform !== "win32");
const cleanupRoots: string[] = [];
const adversarialHelper = fileURLToPath(
  new URL("./fixtures/adversarial-helper.mjs", import.meta.url),
);
const workspaceHelper = fileURLToPath(new URL("./executable.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), "paseo-workspace-helper-"));
  cleanupRoots.push(parent);
  const root = path.join(parent, "workspace");
  await mkdir(root);
  const client = bindWorkspaceHelper({
    root,
    command: [process.execPath, workspaceHelper],
    launch: launchTestProcess,
  });
  return { client, parent, root };
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const collected: Buffer[] = [];
  for await (const chunk of chunks) collected.push(Buffer.from(chunk));
  return Buffer.concat(collected);
}

posixDescribe("workspace-helper public capability", () => {
  test("watch rejects a second root authority supplied by a subscriber", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "paseo-workspace-helper-root-"));
    cleanupRoots.push(parent);
    const trustedRoot = path.join(parent, "trusted");
    const untrustedRoot = path.join(parent, "untrusted");
    await mkdir(trustedRoot);
    await mkdir(untrustedRoot);
    await writeFile(path.join(untrustedRoot, "outside.txt"), "outside\n");
    const child = spawn(process.execPath, [workspaceHelper, "watch", "--root", trustedRoot], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    child.stdin.end(
      `${JSON.stringify({
        protocolVersion: 1,
        type: "subscribe",
        id: "malicious",
        root: untrustedRoot,
        paths: ["outside.txt"],
      })}\n${JSON.stringify({ protocolVersion: 1, type: "close" })}\n`,
    );

    await expect(
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }),
    ).resolves.toEqual({ code: 1, signal: null });
    expect((await stderr).toString()).toContain("Watch subscriptions cannot supply a root");
    expect((await stdout).toString()).not.toContain("subscribed");
  });

  test("multi-path watches preserve exact paths for matching basenames", async () => {
    const { client, root } = await fixture();
    await mkdir(path.join(root, "a"));
    await mkdir(path.join(root, "b"));
    await writeFile(path.join(root, "a", "file.txt"), "a\n");
    await writeFile(path.join(root, "b", "file.txt"), "b\n");
    let resolveChanged!: (paths: string[]) => void;
    const changed = new Promise<string[]>((resolve) => {
      resolveChanged = resolve;
    });
    const subscription = await client.files.subscribe(
      { paths: ["a/file.txt", "b/file.txt"] },
      (event) => {
        if (event.type === "changed") resolveChanged(event.paths);
      },
    );

    await writeFile(path.join(root, "a", "file.txt"), "changed\n");
    await expect(changed).resolves.toEqual(["a/file.txt"]);
    await subscription.unsubscribe();
    await client.close();
  });

  test("a clean watcher restart does not replay a stale file version", async () => {
    const { client, root } = await fixture();
    const first = await client.files.subscribe({ paths: ["later.txt"] }, () => undefined);
    await first.unsubscribe();
    const events: WorkspaceWatchEvent[] = [];
    let resolveChanged!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve;
    });
    const second = await client.files.subscribe({ paths: ["later.txt"] }, (event) => {
      events.push(event);
      if (event.type === "changed") resolveChanged();
    });

    expect(events).toEqual([]);
    await writeFile(path.join(root, "later.txt"), "created\n");
    await changed;
    expect(events).toContainEqual({ type: "changed", paths: ["later.txt"] });

    await second.unsubscribe();
    await client.close();
  });

  test("a helper crash relaunches the watcher and replays live subscriptions", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "paseo-workspace-helper-replay-"));
    cleanupRoots.push(parent);
    const root = path.join(parent, "workspace");
    await mkdir(root);
    await writeFile(path.join(root, "watched.txt"), "before\n");
    const watcherChildren: ReturnType<typeof spawn>[] = [];
    let resolveSecondSubscription!: () => void;
    const secondSubscription = new Promise<void>((resolve) => {
      resolveSecondSubscription = resolve;
    });
    const client = bindWorkspaceHelper({
      root,
      command: [process.execPath, workspaceHelper],
      launch: async (argv) => {
        const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
        if (argv.includes("watch")) {
          watcherChildren.push(child);
          if (watcherChildren.length === 2) {
            child.stdout.on("data", (chunk) => {
              if (chunk.toString().includes('"type":"subscribed"')) {
                resolveSecondSubscription();
              }
            });
          }
        }
        return childProcess(child);
      },
    });
    let resolveChanged!: (paths: string[]) => void;
    const changed = new Promise<string[]>((resolve) => {
      resolveChanged = resolve;
    });
    const subscription = await client.files.subscribe({ paths: ["watched.txt"] }, (event) => {
      if (event.type === "changed") resolveChanged(event.paths);
    });

    watcherChildren[0]?.kill("SIGKILL");
    await secondSubscription;
    await writeFile(path.join(root, "watched.txt"), "after\n");

    await expect(changed).resolves.toEqual(["watched.txt"]);
    await subscription.unsubscribe();
    await client.close();
  });

  test("cancelling a partially-consumed read waits for the helper to exit", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "paseo-workspace-helper-cancel-"));
    cleanupRoots.push(parent);
    const children: ReturnType<typeof spawn>[] = [];
    const exits: WorkspaceHelperProcess["exited"][] = [];
    const client = bindWorkspaceHelper({
      root: parent,
      command: [process.execPath, adversarialHelper, "endless-read"],
      launch: async (argv): Promise<WorkspaceHelperProcess> => {
        const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
        children.push(child);
        const exited = new Promise<Awaited<WorkspaceHelperProcess["exited"]>>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        exits.push(exited);
        return {
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          exited,
          kill: (signal) => child.kill(signal),
        };
      },
    });

    try {
      const file = await client.files.read("large.bin");
      const iterator = file.chunks[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ done: false });
      await file.chunks.cancel();
      await expect(exits[1]).resolves.toMatchObject({ signal: "SIGTERM" });
      expect(() => process.kill(children[1]?.pid ?? 0, 0)).toThrow();

      const returned = await client.files.read("large.bin");
      for await (const _chunk of returned.chunks) break;
      await expect(exits[3]).resolves.toMatchObject({ signal: "SIGTERM" });
      expect(() => process.kill(children[3]?.pid ?? 0, 0)).toThrow();
    } finally {
      for (const child of children) child.kill("SIGKILL");
      await client.close();
    }
  });

  test("malformed watcher output rejects only after terminating the helper", async () => {
    const recorded = await recordedClient("malformed-watch");
    try {
      await expect(
        recorded.client.files.subscribe({ paths: ["notes.txt"] }, () => undefined),
      ).rejects.toThrow(/JSON|Unexpected token/);
      await expect(recorded.exits[0]).resolves.toMatchObject({ signal: "SIGTERM" });
      expect(() => process.kill(recorded.pids[0] ?? 0, 0)).toThrow();
    } finally {
      await recorded.cleanup();
    }
  });

  test.each([
    ["no-ready", "ready acknowledgement timed out"],
    ["no-subscribed", "subscribe acknowledgement timed out"],
    ["no-unsubscribed", "unsubscribe acknowledgement timed out"],
  ])("%s watcher acknowledgements fail after bounded cleanup", async (mode, expectedError) => {
    const recorded = await recordedClient(mode);
    try {
      if (mode === "no-unsubscribed") {
        const subscription = await recorded.client.files.subscribe(
          { paths: ["notes.txt"] },
          () => undefined,
        );
        await expect(subscription.unsubscribe()).rejects.toThrow(expectedError);
      } else {
        await expect(
          recorded.client.files.subscribe({ paths: ["notes.txt"] }, () => undefined),
        ).rejects.toThrow(expectedError);
      }
      await expect(recorded.exits[0]).resolves.toMatchObject({ signal: "SIGTERM" });
      expect(() => process.kill(recorded.pids[0] ?? 0, 0)).toThrow();
    } finally {
      await recorded.cleanup();
    }
  });

  test("watcher close escalates through TERM to KILL before unsubscribe settles", async () => {
    const recorded = await recordedClient("resists-close");
    try {
      const subscription = await recorded.client.files.subscribe(
        { paths: ["notes.txt"] },
        () => undefined,
      );
      await subscription.unsubscribe();
      await expect(recorded.exits[0]).resolves.toMatchObject({ signal: "SIGKILL" });
      expect(() => process.kill(recorded.pids[0] ?? 0, 0)).toThrow();
    } finally {
      await recorded.cleanup();
    }
  });

  test("lists, streams, writes optimistically, confines symlinks, and observes changes", async () => {
    const { client, parent, root } = await fixture();
    const binary = Buffer.alloc(700_000, 0xa5);
    await writeFile(path.join(root, "large.bin"), binary);
    await writeFile(path.join(root, "notes.txt"), "before\n");
    await writeFile(path.join(root, "upload.bin"), new Uint8Array());

    const listing = await client.files.list(".");
    expect(listing.entries.map((entry) => entry.name).sort()).toEqual([
      "large.bin",
      "notes.txt",
      "upload.bin",
    ]);

    const streamed = await client.files.read("large.bin");
    expect(streamed).toMatchObject({ path: "large.bin", kind: "binary", size: binary.byteLength });
    expect(await collect(streamed.chunks)).toEqual(binary);

    const upload = await client.files.write({
      path: "upload.bin",
      contents: (async function* () {
        for (let offset = 0; offset < binary.byteLength; offset += 64 * 1024) {
          yield binary.subarray(offset, Math.min(offset + 64 * 1024, binary.byteLength));
        }
      })(),
    });
    expect(upload).toMatchObject({ status: "written", size: binary.byteLength });
    expect(await readFile(path.join(root, "upload.bin"))).toEqual(binary);

    const initial = await client.files.stat("notes.txt");
    expect(initial).toMatchObject({ status: "ready", path: "notes.txt", size: 7 });
    if (initial.status !== "ready") throw new Error("Expected notes.txt to exist");

    let resolveChanged!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve;
    });
    const changeSubscription = await client.files.subscribe({ paths: ["notes.txt"] }, (event) => {
      if (event.type === "changed" && event.paths.includes("notes.txt")) resolveChanged();
    });
    const subscription = await client.files.subscribe({ paths: ["notes.txt"] }, () => undefined);
    const written = await client.files.write({
      path: "notes.txt",
      contents: Buffer.from("after\n"),
      expectedRevision: initial.revision,
    });
    expect(written).toMatchObject({ status: "written", size: 6 });
    await expect(changed).resolves.toBeUndefined();
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("after\n");

    const conflict = await client.files.write({
      path: "notes.txt",
      contents: Buffer.from("stale\n"),
      expectedRevision: initial.revision,
    });
    expect(conflict).toMatchObject({ status: "conflict" });

    await writeFile(path.join(parent, "outside.txt"), "secret\n");
    await symlink(path.join(parent, "outside.txt"), path.join(root, "escape.txt"));
    await expect(client.files.read("escape.txt")).rejects.toThrow(
      "Access outside of workspace is not allowed",
    );

    await subscription.unsubscribe();
    await changeSubscription.unsubscribe();
    await client.close();
  }, 15_000);
});

async function recordedClient(mode: string) {
  const root = await mkdtemp(path.join(tmpdir(), `paseo-workspace-helper-${mode}-`));
  cleanupRoots.push(root);
  const children: ReturnType<typeof spawn>[] = [];
  const exits: WorkspaceHelperProcess["exited"][] = [];
  const pids: number[] = [];
  const client = bindWorkspaceHelper({
    root,
    command: [process.execPath, adversarialHelper, mode],
    launch: async (argv): Promise<WorkspaceHelperProcess> => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
      const exited = new Promise<Awaited<WorkspaceHelperProcess["exited"]>>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      children.push(child);
      exits.push(exited);
      if (child.pid) pids.push(child.pid);
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        exited,
        kill: (signal) => child.kill(signal),
      };
    },
  });
  return {
    client,
    exits,
    pids,
    async cleanup() {
      for (const child of children) child.kill("SIGKILL");
      await Promise.allSettled(exits);
      await client.close().catch(() => undefined);
    },
  };
}

async function launchTestProcess(
  argv: readonly [string, ...string[]],
): Promise<WorkspaceHelperProcess> {
  const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  return childProcess(child);
}

function childProcess(child: ReturnType<typeof spawn>): WorkspaceHelperProcess {
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    kill: (signal) => child.kill(signal),
  };
}
