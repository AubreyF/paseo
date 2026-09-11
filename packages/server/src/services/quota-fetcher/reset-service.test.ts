import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type { ProviderResetAttempt, ProviderResetOutcome } from "@getpaseo/protocol/provider-reset";
import { ResetCreditStore } from "./reset-store.js";
import { ProviderResetService } from "./reset-service.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-reset-service-"));
  directories.push(directory);
  const state = {
    accountId: "first",
    count: 2,
    canRedeem: true,
    enabled: true,
    failRead: false,
    failRefresh: false,
    failDispose: false,
    disposals: 0,
    refreshes: 0,
  };
  const attempts: ProviderResetAttempt[] = [];
  let consume: (attempt: ProviderResetAttempt) => Promise<ProviderResetOutcome> = async () =>
    "reset";
  const store = new ResetCreditStore(directory);
  const service = new ProviderResetService({
    store,
    logger: pino({ level: "silent" }),
    refreshUsage: async () => {
      state.refreshes += 1;
      if (state.failRefresh) throw new Error("offline");
    },
    getClient: () =>
      state.enabled
        ? {
            openResetCreditSession: async () => ({
              canRedeem: state.canRedeem,
              read: async () => {
                if (state.failRead) throw new Error("offline");
                return {
                  status: "available",
                  accountId: state.accountId,
                  accountLabel: null,
                  availableCount: state.count,
                  credits: null,
                };
              },
              consume: async (attempt) => {
                attempts.push(attempt);
                return consume(attempt);
              },
              dispose: async () => {
                state.disposals += 1;
                if (state.failDispose) throw new Error("cleanup failed");
              },
            }),
          }
        : null,
  });
  return {
    state,
    attempts,
    store,
    service,
    setConsume: (callback: typeof consume) => {
      consume = callback;
    },
  };
}

test("unsupported providers refresh normally but cannot prepare a reset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-reset-service-"));
  directories.push(directory);
  const service = new ProviderResetService({
    store: new ResetCreditStore(directory),
    logger: pino({ level: "silent" }),
    getClient: () => ({}),
    refreshUsage: async () => {},
  });
  expect(await service.read("pi")).toMatchObject({
    providerId: "pi",
    snapshot: { status: "unsupported" },
    canRedeem: false,
    operation: null,
  });
  await expect(service.prepare("pi", "first")).rejects.toThrow("unavailable");
});

test("reading and preparing never consume; duplicate confirmations share one outcome", async () => {
  const { service, attempts, state } = await setup();
  expect((await service.read("primary")).snapshot).toMatchObject({ availableCount: 2 });
  const prepared = await service.prepare("primary", "first");
  expect(attempts).toHaveLength(0);
  const id = prepared.operation!.operationId;
  const results = await Promise.all([
    service.confirm("primary", "first", id),
    service.confirm("alias", "first", id),
  ]);
  expect(results.map((result) => result.outcome)).toEqual(["reset", "reset"]);
  expect(attempts).toHaveLength(1);
  expect(state.disposals).toBe(4);
});

test("changed accounts and disabled providers cannot redeem a prepared operation", async () => {
  const { service, attempts, state } = await setup();
  const prepared = await service.prepare("primary", "first");
  state.accountId = "second";
  await expect(
    service.confirm("primary", "first", prepared.operation!.operationId),
  ).rejects.toMatchObject({ code: "account_changed" });
  state.enabled = false;
  await expect(
    service.confirm("primary", "first", prepared.operation!.operationId),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(attempts).toHaveLength(0);
});

test("unknown mutation results stay pending and explicitly retry the same key even at zero credits", async () => {
  const { service, attempts, state, setConsume } = await setup();
  const prepared = await service.prepare("primary", "first");
  const id = prepared.operation!.operationId;
  setConsume(async () => {
    throw new Error("response lost");
  });
  await expect(service.confirm("primary", "first", id)).rejects.toThrow("response lost");
  state.count = 0;
  expect((await service.read("primary")).operation?.state).toBe("pending");
  expect((await service.prepare("alias", "first")).operation?.operationId).toBe(id);
  expect(attempts).toHaveLength(1);
  setConsume(async () => "alreadyRedeemed");
  expect((await service.confirm("alias", "first", id)).outcome).toBe("alreadyRedeemed");
  expect(attempts.map((attempt) => attempt.idempotencyKey)).toEqual([id, id]);
});

test("refresh and cleanup failures cannot erase a known result", async () => {
  const { service, state, store, setConsume } = await setup();
  const prepared = await service.prepare("primary", "first");
  setConsume(async () => {
    state.failRead = true;
    state.failRefresh = true;
    state.failDispose = true;
    return "reset";
  });
  const result = await service.confirm("primary", "first", prepared.operation!.operationId);
  expect(result).toMatchObject({ outcome: "reset", view: null });
  expect(result.refreshError).toBeTruthy();
  expect(await store.read("first")).toMatchObject({ state: "completed", outcome: "reset" });
});

test("zero credits and unverified capabilities cannot prepare a new reset", async () => {
  const { service, state, store } = await setup();
  state.count = 0;
  await expect(service.prepare("primary", "first")).rejects.toMatchObject({ code: "no_credit" });
  state.count = 2;
  state.canRedeem = false;
  expect((await service.read("primary")).canRedeem).toBe(false);
  await expect(service.prepare("primary", "first")).rejects.toMatchObject({ code: "unavailable" });
  expect(await store.read("first")).toBeNull();
});

test.each(["reset", "alreadyRedeemed", "noCredit", "nothingToReset"] as const)(
  "only confirmed recovery outcomes unlock tasks: %s",
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-reset-unlock-"));
    directories.push(directory);
    const unlocked: string[] = [];
    const service = new ProviderResetService({
      store: new ResetCreditStore(directory),
      logger: pino({ level: "silent" }),
      refreshUsage: async () => {},
      onResetApplied: async (providerId) => {
        unlocked.push(providerId);
      },
      getClient: () => ({
        openResetCreditSession: async () => ({
          canRedeem: true,
          read: async () => ({
            status: "available",
            accountId: "account",
            accountLabel: null,
            availableCount: 1,
            credits: null,
          }),
          consume: async () => outcome,
          dispose: async () => {},
        }),
      }),
    });
    const prepared = await service.prepare("codex", "account");
    expect(unlocked).toEqual([]);
    if (!prepared.operation) throw new Error("Missing operation");
    await service.confirm("codex", "account", prepared.operation.operationId);
    expect(unlocked).toEqual(outcome === "reset" || outcome === "alreadyRedeemed" ? ["codex"] : []);
  },
);

test("retrying a saved reset repairs recovery without spending another credit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-reset-retry-"));
  directories.push(directory);
  let consumes = 0;
  let recoveryAttempts = 0;
  const service = new ProviderResetService({
    store: new ResetCreditStore(directory),
    logger: pino({ level: "silent" }),
    refreshUsage: async () => {},
    onResetApplied: async () => {
      recoveryAttempts += 1;
      if (recoveryAttempts === 1) throw new Error("Disk unavailable");
    },
    getClient: () => ({
      openResetCreditSession: async () => ({
        canRedeem: true,
        read: async () => ({
          status: "available",
          accountId: "account",
          accountLabel: null,
          availableCount: 1 - consumes,
          credits: null,
        }),
        consume: async () => {
          consumes += 1;
          return "reset";
        },
        dispose: async () => {},
      }),
    }),
  });
  const prepared = await service.prepare("codex", "account");
  if (!prepared.operation) throw new Error("Missing operation");
  const failed = await service.confirm("codex", "account", prepared.operation.operationId);
  expect(failed.outcome).toBe("reset");
  expect(failed.refreshError).toContain("threads could not be unlocked");
  const retried = await service.confirm("codex", "account", prepared.operation.operationId);
  expect(retried.refreshError).toBeNull();
  expect(consumes).toBe(1);
  expect(recoveryAttempts).toBe(2);
});
