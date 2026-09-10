import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { expect, test, vi } from "vitest";
import { AgentStorage } from "./agent/agent-storage.js";
import { createPaseoDaemon } from "./bootstrap.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

test("daemon startup durably stops an interrupted protected team before accepting work", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-bootstrap-reserve-"));
  const paseoHome = join(root, "home");
  const staticDir = join(root, "static");
  const agentStoragePath = join(paseoHome, "agents");
  const logger = pino({ level: "silent" });
  const supervisorId = randomUUID();
  const workerId = randomUUID();
  const stamp = new Date(1000).toISOString();
  let daemon: Awaited<ReturnType<typeof createPaseoDaemon>> | undefined;
  try {
    await mkdir(staticDir, { recursive: true });
    const storage = new AgentStorage(agentStoragePath, logger);
    await storage.upsert({
      id: supervisorId,
      provider: "codex",
      cwd: root,
      createdAt: stamp,
      updatedAt: stamp,
      lastStatus: "idle",
      labels: {},
      config: {
        quotaReserve: {
          policy: { kind: "protected", cruisePct: 15, redlinePct: 10 },
          state: { kind: "ready", revision: 0, changedAt: stamp },
        },
      },
    });
    await storage.upsert({
      id: workerId,
      provider: "pi",
      cwd: root,
      createdAt: stamp,
      updatedAt: stamp,
      lastStatus: "running",
      labels: { [PARENT_AGENT_ID_LABEL]: supervisorId },
    });
    daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        staticDir,
        agentStoragePath,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        mcpDebug: false,
        agentClients: {},
        relayEnabled: false,
        appBaseUrl: "https://app.paseo.sh",
        providerOverrides: {
          claude: { enabled: false },
          codex: { enabled: false },
          copilot: { enabled: false },
          opencode: { enabled: false },
          pi: { enabled: false },
          omp: { enabled: false },
        },
      },
      logger,
    );
    const disk = new AgentStorage(agentStoragePath, logger);
    expect((await disk.get(supervisorId))?.config?.quotaReserve?.state).toMatchObject({
      kind: "stopped",
      reason: "recovery_uncertain",
      revision: 1,
    });
    expect(daemon.agentManager.listAgents()).toEqual([]);
    await daemon.start();
    await vi.waitFor(() =>
      expect(() => daemon!.agentManager.assertQuotaNotPaused(workerId)).toThrow(
        "outcome is uncertain",
      ),
    );
    const nowMs = Date.now();
    await daemon.agentManager.updateQuotaReserveState(supervisorId, {
      trigger: "observation",
      observation: {
        windows: [{ id: "weekly", label: "Weekly", remainingPct: 90 }],
        requiredWindowIds: ["weekly"],
        observedAtMs: nowMs,
        nowMs,
        maxAgeMs: 90000,
      },
    });
    await vi.waitFor(() =>
      expect(() => daemon!.agentManager.assertQuotaNotPaused(supervisorId)).toThrow(
        "outcome is uncertain",
      ),
    );
    expect((await daemon.agentStorage.get(workerId))?.config?.quotaReserve).toBeUndefined();
  } finally {
    await daemon?.stop();
    await daemon?.agentManager.flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
