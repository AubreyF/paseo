import { mkdtemp, rm, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ResetCreditStore } from "./reset-store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("an ambiguous call stays pending across restart and another alias retains the same key", async () => {
  const { directory, store } = await createStore();
  const operation = await store.prepare({ accountId: "first", providerId: "primary" });
  const input = { accountId: "first", operationId: operation.idempotencyKey };
  await expect(
    store.confirm(input, async (attempt) => {
      expect(await new ResetCreditStore(directory).read("first")).toMatchObject({
        state: "pending",
        idempotencyKey: attempt.idempotencyKey,
      });
      throw new Error("response lost");
    }),
  ).rejects.toThrow("response lost");
  const restarted = new ResetCreditStore(directory);
  const pending = await restarted.prepare({ accountId: "first", providerId: "alias" });
  expect(pending).toEqual({ ...operation, state: "pending" });
  expect(
    await restarted.confirm(input, async (attempt) => {
      expect(attempt.idempotencyKey).toBe(operation.idempotencyKey);
      return "alreadyRedeemed";
    }),
  ).toBe("alreadyRedeemed");
});

test("concurrent aliases prepare one confirmation while another account stays independent", async () => {
  const { store } = await createStore();
  const [first, alias, second] = await Promise.all([
    store.prepare({ accountId: "first", providerId: "primary" }),
    store.prepare({ accountId: "first", providerId: "alias" }),
    store.prepare({ accountId: "second", providerId: "secondary" }),
  ]);
  expect(alias.idempotencyKey).toBe(first.idempotencyKey);
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  let spent = 0;
  await expect(
    store.confirm({ accountId: "second", operationId: first.idempotencyKey }, async () => {
      spent += 1;
      return "reset";
    }),
  ).rejects.toMatchObject({ code: "stale_operation" });
  expect(spent).toBe(0);
});

test("a superseded confirmation cannot spend a later credit", async () => {
  const { store } = await createStore();
  const first = await store.prepare({ accountId: "first", providerId: "primary" });
  const input = { accountId: "first", operationId: first.idempotencyKey };
  await store.confirm(input, async () => "reset");
  const next = await store.prepare({ accountId: "first", providerId: "primary" });
  expect(next.idempotencyKey).not.toBe(first.idempotencyKey);
  let spent = 0;
  await expect(
    store.confirm(input, async () => {
      spent += 1;
      return "reset";
    }),
  ).rejects.toMatchObject({ code: "stale_operation" });
  expect(spent).toBe(0);
});

test("a damaged operation file fails closed instead of allocating a fresh attempt", async () => {
  const { directory, store } = await createStore();
  await store.prepare({ accountId: "first", providerId: "primary" });
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  await writeFile(join(directory, files[0]), "{broken");
  const restarted = new ResetCreditStore(directory);
  await expect(restarted.prepare({ accountId: "first", providerId: "alias" })).rejects.toThrow();
  expect(await readFile(join(directory, files[0]), "utf8")).toBe("{broken");
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-reset-store-"));
  directories.push(directory);
  return { directory, store: new ResetCreditStore(directory) };
}

test("duplicate confirmations spend once and return the persisted result after restart", async () => {
  const { directory, store } = await createStore();
  const operation = await store.prepare({ accountId: "first", providerId: "primary" });
  let spent = 0;
  const consume = async () => {
    spent += 1;
    return "reset" as const;
  };
  const input = { accountId: "first", operationId: operation.idempotencyKey };
  expect(await Promise.all([store.confirm(input, consume), store.confirm(input, consume)])).toEqual(
    ["reset", "reset"],
  );
  expect(await new ResetCreditStore(directory).confirm(input, consume)).toBe("reset");
  expect(spent).toBe(1);
});
