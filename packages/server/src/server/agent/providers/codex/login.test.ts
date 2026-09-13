import { expect, it } from "vitest";
import { CodexLoginSession } from "./login.js";
import { CodexAppServerAgentClient } from "../codex-app-server-agent.js";
import pino from "pino";

it("refuses sign-in for a custom account without its own credential directory", async () => {
  const client = new CodexAppServerAgentClient(
    pino({ level: "silent" }),
    { command: { mode: "replace", argv: ["/nonexistent/login-test-provider"] } },
    { customProvider: { id: "codex-second", label: "Second account", extends: "codex" } },
  );
  await expect(client.openAccountLoginSession()).rejects.toThrow(
    "Configure this account’s CODEX_HOME before signing in.",
  );
});

function transport(input: { early?: boolean; url?: string } = {}) {
  let notify = (_method: string, _params: unknown) => {};
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    setNotificationHandler: (handler: typeof notify) => {
      notify = handler;
    },
    setUnexpectedTerminationHandler: () => {},
    dispose: async () => {},
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "account/login/start") {
        if (input.early) notify("account/login/completed", { loginId: "login", success: true });
        return {
          type: "chatgptDeviceCode",
          loginId: "login",
          verificationUrl: input.url ?? "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
        };
      }
      return { account: { type: "chatgpt", email: "one@example.test" } };
    },
    complete: (loginId: string) => notify("account/login/completed", { loginId, success: true }),
  };
}
it("handles completion before the start response and uses the returned login id to cancel", async () => {
  const rpc = transport({ early: true });
  const session = new CodexLoginSession(rpc, "/account-one");
  const completions: boolean[] = [];
  expect(
    await session.start((success) => {
      completions.push(success);
    }),
  ).toEqual({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" });
  expect(completions).toEqual([true]);
  rpc.complete("someone-else");
  expect(completions).toEqual([true]);
  expect(await session.readAccountLabel()).toBe("one@example.test");
  await session.cancel();
  expect(rpc.calls).toEqual([
    { method: "account/login/start", params: { type: "chatgptDeviceCode" } },
    { method: "account/read", params: { refreshToken: false } },
    { method: "account/login/cancel", params: { loginId: "login" } },
  ]);
});
it.each([
  "http://auth.openai.com/codex/device",
  "https://attacker.test/codex/device",
  "https://auth.openai.com@attacker.test/codex/device",
])("rejects an unexpected sign-in destination %s", async (url) => {
  await expect(
    new CodexLoginSession(transport({ url }), "/account-one").start(() => {}),
  ).rejects.toThrow("Unexpected device sign-in destination");
});
