import { expect, test } from "vitest";
import { CodexResetCreditSession } from "./reset-credits.js";
import { CodexAppServerRpcError } from "./app-server-transport.js";
import { CodexAppServerAgentClient } from "../codex-app-server-agent.js";
import pino from "pino";

test("a custom provider cannot fall back to the host account when its credential home is absent", async () => {
  const client = new CodexAppServerAgentClient(
    pino({ level: "silent" }),
    { command: { mode: "replace", argv: ["/nonexistent/reset-test-provider"] } },
    { customProvider: { id: "codex-second", label: "Second account", extends: "codex" } },
  );
  await expect(client.openResetCreditSession()).rejects.toMatchObject({
    code: "unavailable",
    message: "Configure an explicit CODEX_HOME for this provider before managing account resets.",
  });
});

test("reads the authoritative reset count without counting a capped detail list", async () => {
  const calls: string[] = [];
  const session = new CodexResetCreditSession({
    request: async (method) => {
      calls.push(method);
      if (method === "account/read") {
        return { account: { type: "chatgpt", email: "first@example.test" } };
      }
      return {
        accountId: "account-first",
        rateLimitResetCredits: { availableCount: 3, credits: [] },
      };
    },
    dispose: async () => {},
  });
  expect(await session.read()).toEqual({
    status: "available",
    accountId: "account-first",
    accountLabel: "first@example.test",
    availableCount: 3,
    credits: [],
  });
  expect(calls).toEqual(["account/read", "account/rateLimits/read"]);
});

test.each([undefined, null])("does not invent a count when the summary is %s", async (summary) => {
  const session = new CodexResetCreditSession({
    request: async (method) =>
      method === "account/read"
        ? { account: { type: "chatgpt", email: null } }
        : { accountId: "account-first", rateLimitResetCredits: summary },
    dispose: async () => {},
  });
  expect(await session.read()).toEqual({
    status: "unavailable",
    reason: "The provider did not report reset-credit availability.",
  });
});

test("does not enable redemption without a provider-reported account identity", async () => {
  const calls: string[] = [];
  const session = new CodexResetCreditSession(
    {
      request: async (method) => {
        calls.push(method);
        if (method === "account/read")
          return { account: { type: "chatgpt", email: "first@example.test" } };
        return { rateLimitResetCredits: { availableCount: 2 } };
      },
      dispose: async () => {},
    },
    true,
  );
  await expect(
    session.consume({
      accountId: "account-first",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(calls).toEqual(["account/read", "account/rateLimits/read"]);
});

test.each(["apiKey", "amazonBedrock"])(
  "does not request reset credits for %s accounts",
  async (type) => {
    const calls: string[] = [];
    const session = new CodexResetCreditSession({
      request: async (method) => {
        calls.push(method);
        return { account: { type } };
      },
      dispose: async () => {},
    });
    expect(await session.read()).toEqual({
      status: "unsupported",
      reason: "Reset credits require a ChatGPT account.",
    });
    expect(calls).toEqual(["account/read"]);
  },
);

test("classifies an absent RPC as unsupported, but propagates a transport failure", async () => {
  const session = new CodexResetCreditSession({
    request: async () => {
      throw new CodexAppServerRpcError("Missing method", -32601, null);
    },
    dispose: async () => {},
  });
  expect(await session.read()).toEqual({
    status: "unsupported",
    reason: "Update this provider's Codex CLI to read reset credits.",
  });
  const failed = new CodexResetCreditSession({
    request: async () => {
      throw new Error("transport unavailable");
    },
    dispose: async () => {},
  });
  await expect(failed.read()).rejects.toThrow("transport unavailable");
});

test.each(["reset", "noCredit", "nothingToReset", "alreadyRedeemed"])(
  "preserves the %s provider outcome and the caller's logical attempt",
  async (outcome) => {
    const mutations: unknown[] = [];
    const session = new CodexResetCreditSession(
      {
        request: async (method, params) => {
          if (method === "account/read") return { account: { type: "chatgpt", email: null } };
          if (method === "account/rateLimits/read") {
            return { accountId: "account-first", rateLimitResetCredits: { availableCount: 0 } };
          }
          mutations.push(params);
          return { outcome };
        },
        dispose: async () => {},
      },
      true,
    );
    expect(
      await session.consume({
        accountId: "account-first",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        creditId: "credit-first",
      }),
    ).toBe(outcome);
    expect(mutations).toEqual([
      { idempotencyKey: "00000000-0000-4000-8000-000000000001", creditId: "credit-first" },
    ]);
  },
);

test("does not turn an ambiguous redemption response into success or retry it internally", async () => {
  let mutations = 0;
  const session = new CodexResetCreditSession(
    {
      request: async (method) => {
        if (method === "account/read") return { account: { type: "chatgpt", email: null } };
        if (method === "account/rateLimits/read") {
          return { accountId: "account-first", rateLimitResetCredits: { availableCount: 1 } };
        }
        mutations += 1;
        return { outcome: "unrecognized" };
      },
      dispose: async () => {},
    },
    true,
  );
  await expect(
    session.consume({
      accountId: "account-first",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    }),
  ).rejects.toThrow();
  expect(mutations).toBe(1);
});

test("rejects a confirmation for another account without sending a redemption", async () => {
  const calls: string[] = [];
  const session = new CodexResetCreditSession(
    {
      request: async (method) => {
        calls.push(method);
        if (method === "account/read") return { account: { type: "chatgpt", email: null } };
        return { accountId: "account-second", rateLimitResetCredits: { availableCount: 1 } };
      },
      dispose: async () => {},
    },
    true,
  );
  await expect(
    session.consume({
      accountId: "account-first",
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    }),
  ).rejects.toMatchObject({ code: "account_changed" });
  expect(calls).toEqual(["account/read", "account/rateLimits/read"]);
});
