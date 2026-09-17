import { expect, test } from "vitest";
import pino from "pino";
import { AgentManager } from "./agent-manager.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import type { AgentClient, QuotaGovernedSessionInput } from "./agent-sdk-types.js";

test("captured governed clients reject replacement and disabled providers without fallback", async () => {
  const client = createTestAgentClient("codex");
  const opened: AgentClient[] = [];
  client.openQuotaGovernedSession = async function (input) {
    opened.push(this);
    return this.createSession(input.config);
  };
  const manager = new AgentManager({
    logger: pino({ level: "silent" }),
    clients: { codex: client },
  });
  const input: QuotaGovernedSessionInput = {
    config: { provider: "codex", cwd: "/fixture" },
    account: { issuer: "openai", accountId: "fixture" },
    guard: async () => {
      throw new Error("No inference");
    },
  };
  const captured = manager.captureGovernedExecutionClient("codex");
  const session = await captured.openSession(input);
  await session.close();
  expect(opened).toEqual([client]);
  const replacement = createTestAgentClient("codex");
  manager.registerClient("codex", replacement);
  expect(() => captured.assertCurrent()).toThrow("changed");
  expect(() => captured.openSession(input)).toThrow("changed");
  expect(() => manager.captureGovernedExecutionClient("codex")).toThrow("unavailable");
  manager.updateProviderRegistry({
    clients: { codex: client },
    providerDefinitions: { codex: { enabled: false } },
  });
  expect(() => manager.captureGovernedExecutionClient("codex")).toThrow("unavailable");
  expect(() => captured.assertCurrent()).toThrow("changed");
  expect(opened).toHaveLength(1);
  manager.updateProviderRegistry({
    clients: { codex: client },
    providerDefinitions: { codex: { enabled: true } },
  });
  expect(() => captured.assertCurrent()).toThrow("changed");
  expect(() => manager.captureGovernedExecutionClient("codex").assertCurrent()).not.toThrow();
  const active = manager.captureGovernedExecutionClient("codex");
  manager.prepareForShutdown();
  expect(() => active.assertCurrent()).toThrow("changed");
  expect(() => manager.captureGovernedExecutionClient("codex")).toThrow("unavailable");
});
