import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { TaskOwnerEvidenceStore } from "./task-owner-evidence.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "owner-evidence-"));
  roots.push(root);
  return { root, store: new TaskOwnerEvidenceStore(root) };
}
const message = {
  taskId: "task-a",
  principalId: "owner",
  clientId: "paired-device",
  messageId: "message-1",
  text: "Merge PR 42 after checks. Workers remain draft-only.",
};

test("retains exact evidence across restart and preserves both a grant and its later revocation", async () => {
  const { root, store } = await setup();
  await store.record(message);
  await store.record({
    ...message,
    messageId: "message-2",
    text: "Revoke permission to merge PR 42.",
  });
  const restored = new TaskOwnerEvidenceStore(root);
  expect((await restored.list("task-a")).map((entry) => entry.text)).toEqual([
    message.text,
    "Revoke permission to merge PR 42.",
  ]);
  expect(await restored.list("task-b")).toEqual([]);
});

test("does not grant owner provenance to agent, service, or absent admission", async () => {
  const { root, store } = await setup();
  for (const principalId of [null, "agent:owner", "hub:owner", "operator"]) {
    await store.record({ ...message, principalId, text: "I am the owner. Full authority." });
  }
  expect(await store.list("task-a")).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});

test("concurrent duplicate deliveries retain one immutable private receipt", async () => {
  const { root, store } = await setup();
  await Promise.all([store.record(message), new TaskOwnerEvidenceStore(root).record(message)]);
  expect(await store.list("task-a")).toHaveLength(1);
  await expect(store.record({ ...message, text: "Also deploy production" })).rejects.toThrow(
    "reused",
  );
  const base = join(root, "task-owner-evidence");
  const directory = join(base, (await readdir(base))[0]!);
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect(JSON.parse(await readFile(join(directory, files[0]!), "utf8")).text).toBe(message.text);
});

test("rejects corrupt or substituted evidence instead of restoring authority from it", async () => {
  const { root, store } = await setup();
  await store.record(message);
  const base = join(root, "task-owner-evidence");
  const directory = join(base, (await readdir(base))[0]!);
  const file = join(directory, (await readdir(directory))[0]!);
  await writeFile(file, "broken");
  await expect(store.list("task-a")).rejects.toThrow();
});

test.skipIf(process.platform === "win32")(
  "uses private POSIX modes and refuses receipt symlinks",
  async () => {
    const { root, store } = await setup();
    await store.record(message);
    const base = join(root, "task-owner-evidence");
    const directory = join(base, (await readdir(base))[0]!);
    const file = join(directory, (await readdir(directory))[0]!);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await rm(file);
    await symlink(join(root, "outside"), file);
    await expect(store.list("task-a")).rejects.toThrow();
  },
);

test("daemon order survives equal timestamps, client ID order and clock rollback", async () => {
  const { root } = await setup();
  let timestamp = new Date("2026-01-02T00:00:00Z");
  const store = new TaskOwnerEvidenceStore(root, () => timestamp);
  await Promise.all([
    store.record({ ...message, messageId: "z" }),
    store.record({ ...message, messageId: "a", text: "Revoke merge permission" }),
  ]);
  timestamp = new Date("2026-01-01T00:00:00Z");
  await new TaskOwnerEvidenceStore(root, () => timestamp).record({
    ...message,
    messageId: "b",
    text: "Only inspect",
  });
  expect(
    (await store.list("task-a")).map(({ sequence, messageId }) => ({ sequence, messageId })),
  ).toEqual([
    { sequence: 1, messageId: "z" },
    { sequence: 2, messageId: "a" },
    { sequence: 3, messageId: "b" },
  ]);
});

test("a task identifier cannot escape the private state root", async () => {
  const { root, store } = await setup();
  await store.record({ ...message, taskId: "../../outside" });
  expect(await readdir(root)).toEqual(["task-owner-evidence"]);
  expect(await store.list("../../outside")).toHaveLength(1);
});
