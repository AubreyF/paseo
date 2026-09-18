import { expect, test, vi, onTestFinished } from "vitest";
import pino from "pino";
import { AgentManager } from "./agent-manager.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import type { AgentClient, QuotaGovernedSessionInput } from "./agent-sdk-types.js";
import { AgentStorage } from "./agent-storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.each(["before startup", "during startup"])(
  "invalid placement %s prevents registration and settles opened custody",
  async (timing) => {
    const client = createTestAgentClient("codex");
    let opened = 0;
    let settled = false;
    client.openQuotaGovernedSession = async (input) => {
      opened++;
      const session = await client.createSession(input.config);
      const close = session.close.bind(session);
      session.close = async () => {
        await close();
        settled = true;
      };
      return session;
    };
    const manager = new AgentManager({
      logger: pino({ level: "silent" }),
      clients: { codex: client },
    });
    const id = randomUUID();
    const validate = vi.fn(async () => {
      if (timing === "before startup" || opened) throw new Error("Placement removed");
    });
    await expect(
      manager.captureGovernedExecutionClient("codex", validate).openSession({
        config: { provider: "codex", cwd: "/fixture" },
        placement: {
          hostId: "srv_fixture",
          projectId: "prj_product",
          projectRoot: "/product",
          projectKey: "remote:github.com/example/product",
          workspaceId: "wks_task",
        },
        account: { issuer: "openai", accountId: "fixture" },
        guard: async () => {
          throw new Error("No inference");
        },
        inspection: {
          executionId: id,
          title: "Fixture",
          async stop() {},
          async assertSettled() {
            expect(settled).toBe(true);
          },
        },
      }),
    ).rejects.toThrow("Placement removed");
    expect(opened).toBe(timing === "before startup" ? 0 : 1);
    expect(settled).toBe(timing === "during startup");
    expect(manager.getAgent(id)).toBeNull();
  },
);

test.each(["get", "applySnapshot"] as const)(
  "failed inspection registration cleans up after settlement (%s)",
  async (method) => {
    const root = await mkdtemp(join(tmpdir(), "governed-failure-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const logger = pino({ level: "silent" });
    const registry = new AgentStorage(root, logger);
    await registry.initialize();
    const client = createTestAgentClient("codex");
    let settled = false;
    client.openQuotaGovernedSession = async (input) => {
      const session = await client.createSession(input.config);
      const close = session.close.bind(session);
      session.close = async () => {
        await close();
        settled = true;
      };
      return session;
    };
    const manager = new AgentManager({ logger, registry, clients: { codex: client } });
    const id = randomUUID();
    const input: QuotaGovernedSessionInput = {
      config: { provider: "codex", cwd: root },
      account: { issuer: "openai", accountId: "fixture" },
      guard: async () => {
        throw new Error("No inference");
      },
      inspection: {
        executionId: id,
        title: "Factory fixture",
        async stop() {},
        async assertSettled() {
          if (!settled) throw new Error("Unsettled fixture");
        },
      },
    };
    vi.spyOn(registry, method).mockRejectedValueOnce(new Error("Registration failure"));
    await expect(
      manager.captureGovernedExecutionClient("codex").openSession(input),
    ).rejects.toThrow("Registration failure");
    expect(settled).toBe(true);
    expect(manager.getAgent(id)).toBeNull();
    if (method === "applySnapshot") expect((await registry.get(id))?.lastStatus).toBe("closed");
    const retry = await manager.captureGovernedExecutionClient("codex").openSession(input);
    await retry.close();
  },
);

test("governed sessions expose controller-run timeline but reject ordinary mutations", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "governed-view-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const logger = pino({ level: "silent" });
  const registry = new AgentStorage(root, logger);
  await registry.initialize();
  const client = createTestAgentClient("codex");
  client.openQuotaGovernedSession = async (input) => {
    const session = await client.createSession(input.config);
    const originalRun = session.run.bind(session);
    // This adapter's run() is intentionally nonstreaming. Exercise its actual
    // startTurn event path, matching the native provider's streaming run contract.
    session.run = async (prompt, options) => {
      let unsubscribe = () => {};
      const finished = new Promise<void>((resolve) => {
        unsubscribe = session.subscribe((event) => {
          if (event.type === "turn_completed") resolve();
        });
      });
      try {
        await session.startTurn(prompt, options);
        await finished;
        return originalRun(prompt, options);
      } finally {
        unsubscribe();
      }
    };
    return session;
  };
  const manager = new AgentManager({
    logger,
    registry,
    clients: { codex: client },
  });
  const id = randomUUID();
  const states: string[] = [];
  const unsubscribeState = manager.subscribe((event) => {
    if (event.type === "agent_state" && event.agent.id === id) states.push(event.agent.lifecycle);
  });
  context.onTestFinished(unsubscribeState);
  let settled = false;
  let stops = 0;
  const validatePlacement = vi.fn(async () => {});
  const raw = await manager.captureGovernedExecutionClient("codex", validatePlacement).openSession({
    placement: {
      hostId: "srv_fixture",
      projectId: "prj_product",
      projectRoot: "/product",
      projectKey: "remote:github.com/example/product",
      workspaceId: "wks_task",
    },
    config: { provider: "codex", cwd: "/fixture" },
    account: { issuer: "openai", accountId: "fixture" },
    guard: async () => {
      throw new Error("No provider inference in fixture");
    },
    inspection: {
      executionId: id,
      title: "Factory implementation",
      async stop() {
        stops++;
        await raw.interrupt();
        settled = true;
      },
      async assertSettled() {
        if (!settled) throw new Error("Native custody is not settled");
      },
    },
  });
  const inspected = manager.getAgent(id);
  expect(inspected?.workspaceId).toBe("wks_task");
  expect(validatePlacement).toHaveBeenCalledTimes(3);
  expect(inspected?.config.controllerExecutionId).toBe(id);
  expect(inspected?.session).not.toBe(raw);
  await expect(manager.createAgent({ provider: "codex", cwd: root }, id, {})).rejects.toThrow(
    "through its controller",
  );
  await expect(inspected!.session!.run("unauthorized")).rejects.toThrow("through its controller");
  await expect(manager.runAgent(id, "unauthorized")).rejects.toThrow("through its controller");
  await expect(manager.setAgentMode(id, "full-access")).rejects.toThrow("through its controller");
  await expect(manager.reloadAgentSession(id)).rejects.toThrow("through its controller");
  await expect(manager.closeAgent(id)).rejects.toThrow("not settled");
  const result = await raw.run("hello from controlled fixture");
  await expect.poll(() => manager.getTimeline(id).length).toBeGreaterThan(0);
  await expect.poll(() => manager.getAgent(id)?.lifecycle).toBe("idle");
  expect(states).toContain("running");
  expect(result.canceled).not.toBe(true);
  expect(await manager.cancelAgentRun(id, { reason: "manual" })).toEqual({ status: "settled" });
  expect(stops).toBe(1);
  await raw.close();
  await manager.closeAgent(id);
  expect((await registry.get(id))?.lastStatus).toBe("closed");
  expect((await registry.get(id))?.config?.controllerExecutionId).toBe(id);
  expect((await registry.get(id))?.workspaceId).toBe("wks_task");
  expect(states.at(-1)).toBe("closed");
});

test("stored controller sessions cannot resume or import through ordinary provider paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "governed-inspection-"));
  const logger = pino({ level: "silent" });
  const agentId = randomUUID();
  const executionId = randomUUID();
  const handle = { provider: "codex", sessionId: "controlled-native-session" };
  try {
    const original = new AgentStorage(root, logger);
    await original.initialize();
    await original.upsert({
      id: agentId,
      provider: "codex",
      cwd: root,
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
      labels: {},
      lastStatus: "closed",
      config: { controllerExecutionId: executionId },
      persistence: handle,
    });
    const registry = new AgentStorage(root, logger);
    await registry.initialize();
    expect((await registry.get(agentId))?.config?.controllerExecutionId).toBe(executionId);
    const client = createTestAgentClient("codex");
    let providerCalls = 0;
    client.resumeSession = async () => {
      providerCalls++;
      throw new Error("Unexpected resume");
    };
    client.importSession = async () => {
      providerCalls++;
      throw new Error("Unexpected import");
    };
    const manager = new AgentManager({ logger, registry, clients: { codex: client } });
    await expect(
      manager.createAgent({ provider: "codex", cwd: root }, agentId, {}),
    ).rejects.toThrow("through its controller");
    expect((await registry.get(agentId))?.config?.controllerExecutionId).toBe(executionId);
    await expect(
      manager.resumeAgentFromPersistence(
        { ...handle, sessionId: "ordinary-alias", nativeHandle: handle.sessionId },
        { cwd: root },
        randomUUID(),
      ),
    ).rejects.toThrow("through its controller");
    await expect(
      manager.resumeAgentFromPersistence(handle, { cwd: root }, agentId),
    ).rejects.toThrow("through its controller");
    // A fresh agent ID or omitted marker cannot launder the same provider session.
    await expect(
      manager.resumeAgentFromPersistence(handle, { cwd: root }, randomUUID()),
    ).rejects.toThrow("through its controller");
    await expect(
      manager.importProviderSession({
        provider: "codex",
        providerHandleId: handle.sessionId,
        cwd: root,
        workspaceId: "fixture",
      }),
    ).rejects.toThrow("cannot be imported");
    expect(providerCalls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
