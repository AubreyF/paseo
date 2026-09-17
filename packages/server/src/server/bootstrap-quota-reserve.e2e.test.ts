import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import pino from "pino";
import { expect, test, vi } from "vitest";
import { AgentStorage } from "./agent/agent-storage.js";
import { createPaseoDaemon } from "./bootstrap.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { ScheduleStore } from "./schedule/store.js";
import { QuotaGovernorStore } from "./agent/quota-reserve/governor-store.js";
import type { QuotaGovernorPolicy, QuotaObservation } from "@getpaseo/protocol/quota-governor";

test.each([false, true])(
  "daemon finalizes successive governed occurrences and cleans up after stop rejection=%s",
  async (rejectStop) => {
    const root = await mkdtemp(join(tmpdir(), "paseo-governed-backend-"));
    const paseoHome = join(root, "home");
    const staticDir = join(root, "static");
    const logger = pino({ level: "silent" });
    const policy: QuotaGovernorPolicy = {
      version: 1,
      account: { issuer: "openai", accountId: "fixture" },
      launchFloorPercent: 30,
      freezeFloorPercent: 25,
      maxObservationAgeSeconds: 120,
      requiredWindows: [{ bucketId: "coding", windowId: "weekly", durationMinutes: 10080 }],
      consumptionLimits: [],
      recovery: "automatic_after_reconciliation",
      estimatedHourly: { bucketId: "coding", windowId: "weekly", maxConsumedPoints: 10 },
    };
    const sample = (stamp: number): QuotaObservation => ({
      status: "available",
      account: policy.account,
      observedAt: new Date(stamp).toISOString(),
      windows: [
        { ...policy.requiredWindows[0]!, usedPercent: 20, resetsAt: null, semantics: "unknown" },
      ],
      consumptionMeters: [],
    });
    // Seed controlled historical observations through the real store. This is
    // fixture accounting, not a claim that an hour elapsed in this test.
    let time = Date.now() - 3_600_000;
    const history = new QuotaGovernorStore(join(paseoHome, "quota-governor"), {
      nowMs: () => time,
    });
    const record = (store: QuotaGovernorStore, observation: QuotaObservation) =>
      store.observeEstimatedUsage({
        observation,
        authenticationGeneration: "fixture-generation",
        bucketId: "coding",
        windowId: "weekly",
        maxObservationAgeSeconds: 120,
      });
    const events: string[] = [];
    const reservations: string[] = [];
    let daemon: Awaited<ReturnType<typeof createPaseoDaemon>> | undefined;
    try {
      await mkdir(staticDir, { recursive: true });
      await history.configureAccountingContract({ policy, expectedRevision: null });
      for (let minute = 0; minute <= 60; minute++) {
        await record(history, sample(time));
        if (minute < 60) time += 60_000;
      }
      const stamp = new Date(time).toISOString();
      const schedules = new ScheduleStore(join(paseoHome, "schedules"));
      const schedule = await schedules.create({
        name: "Controlled governed dispatch",
        prompt: "Fixture",
        cadence: { type: "every", everyMs: 1000 },
        target: {
          type: "new-agent",
          config: { provider: "codex", cwd: root, quotaPolicy: policy },
        },
        status: "active",
        createdAt: stamp,
        updatedAt: stamp,
        nextRunAt: stamp,
        lastRunAt: null,
        pausedAt: null,
        expiresAt: null,
        maxRuns: 2,
        runs: [],
      });
      daemon = await createPaseoDaemon(
        {
          listen: "127.0.0.1:0",
          paseoHome,
          staticDir,
          agentStoragePath: join(paseoHome, "agents"),
          corsAllowedOrigins: [],
          hostnames: true,
          mcpEnabled: false,
          mcpDebug: false,
          agentClients: {},
          relayEnabled: false,
          appBaseUrl: "https://app.paseo.sh",
          providerOverrides: Object.fromEntries(
            ["claude", "codex", "copilot", "opencode", "pi", "omp"].map((provider) => [
              provider,
              { enabled: false },
            ]),
          ),
        },
        logger,
        {
          createGovernedScheduleRuntime: async (context) => {
            expect(() => context.captureClient("codex")).toThrow("unavailable");
            const read = () => record(context.store, sample(Date.now()));
            return {
              readObservation: read,
              reconcile: async () => {
                events.push("reconcile");
              },
              reconcilePreparation: async () => "clear",
              prepare: async (current, occurrence) => {
                events.push("prepare");
                const reserved = await context.store.reserve({
                  policy,
                  observation: await read(),
                  scheduleId: current.id,
                  occurrenceId: occurrence,
                  providerId: "codex",
                });
                if (reserved.kind !== "admitted")
                  throw new Error(`Fixture reservation failed: ${reserved.kind}`);
                reservations.push(reserved.reservation.id);
                return {
                  kind: "ready",
                  binding: { account: policy.account, reservationId: reserved.reservation.id },
                  freezeBeforeDispatch: async () => {
                    events.push("freeze");
                  },
                  run: async () => {
                    events.push("run");
                    const identity = {
                      account: policy.account,
                      reservationId: reserved.reservation.id,
                    };
                    const executionId = randomUUID();
                    const execution = await context.store.execution(
                      identity.account,
                      identity.reservationId,
                    );
                    const starting = await context.store.transition({
                      ...identity,
                      expectedGeneration: execution.generation,
                      event: {
                        type: "start",
                        executionId,
                        authenticationGeneration: "fixture-generation",
                      },
                      observation: await read(),
                    });
                    if (starting.kind !== "transitioned")
                      throw new Error(`Fixture start failed: ${starting.reason}`);
                    const running = await context.store.transition({
                      ...identity,
                      expectedGeneration: starting.execution.generation,
                      event: { type: "started", executionId },
                    });
                    if (running.kind !== "transitioned")
                      throw new Error(`Fixture running transition failed: ${running.reason}`);
                    // No process is launched in this fixture. This synthetic
                    // receipt tests accounting integration, not native custody.
                    await context.store.transition({
                      ...identity,
                      expectedGeneration: running.execution.generation,
                      event: { type: "complete", executionId, settlementId: randomUUID() },
                    });
                    expect(
                      await context.store.finalize({ ...identity, observation: await read() }),
                    ).toEqual({ kind: "finalized" });
                    events.push("finalized");
                    return { agentId: null, output: "controlled backend" };
                  },
                };
              },
              stop: async () => {
                events.push("stop");
                if (rejectStop) throw new Error("Fixture custody remains unresolved");
              },
            };
          },
        },
      );
      await daemon.start();
      await vi.waitFor(
        async () => {
          const current = await schedules.get(schedule.id);
          if (!current?.runs.length) throw new Error(JSON.stringify({ current, events }));
          expect(current.runs).toMatchObject([
            { status: "succeeded", output: "controlled backend" },
            { status: "succeeded", output: "controlled backend" },
          ]);
        },
        { timeout: 10_000 },
      );
      expect(events).toEqual([
        "reconcile",
        "prepare",
        "run",
        "finalized",
        "reconcile",
        "prepare",
        "run",
        "finalized",
      ]);
      expect(new Set(reservations).size).toBe(2);
      expect(daemon.agentManager.listAgents()).toEqual([]);
      const bound = daemon.getListenTarget();
      if (!bound || bound.type !== "tcp") throw new Error("Fixture TCP listener is missing");
      if (rejectStop) await expect(daemon.stop()).rejects.toThrow("shutdown requires recovery");
      else await daemon.stop();
      daemon = undefined;
      const replacement = createServer();
      await new Promise<void>((resolve, reject) => {
        replacement.once("error", reject);
        replacement.listen(bound.port, bound.host, () => replacement.close(() => resolve()));
      });
      expect(events.at(-1)).toBe("stop");
      const retained = await record(
        new QuotaGovernorStore(join(paseoHome, "quota-governor")),
        sample(Date.now()),
      );
      expect(retained).toMatchObject({
        status: "available",
        estimatedHourlyUsage: { consumedPoints: 0, authenticationGeneration: "fixture-generation" },
      });
    } finally {
      await daemon?.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

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
