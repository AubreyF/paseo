import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { AgentStorage, type StoredAgentRecord } from "../agent-storage.js";
import { reconcileQuotaReserveStartup } from "./reconcile-startup.js";

const logger = pino({ level: "silent" });
const stamp = new Date(1000).toISOString();
function record(directory: string, overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return {
    id: "protected-task",
    provider: "codex-secondary",
    cwd: directory,
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
    ...overrides,
  };
}
async function withStorage(run: (storage: AgentStorage, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "reserve-startup-"));
  try {
    await run(new AgentStorage(directory, logger), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it.each(["running", "initializing"] as const)(
  "durably stops an interrupted %s task once",
  async (lastStatus) => {
    await withStorage(async (storage, directory) => {
      await storage.upsert(record(directory, { lastStatus }));
      expect(await reconcileQuotaReserveStartup(storage, 2000)).toBe(1);
      const reloaded = new AgentStorage(directory, logger);
      expect((await reloaded.get("protected-task"))?.config?.quotaReserve?.state).toEqual({
        kind: "stopped",
        reason: "recovery_uncertain",
        revision: 1,
        changedAt: new Date(2000).toISOString(),
      });
      expect(await reconcileQuotaReserveStartup(reloaded, 3000)).toBe(0);
      expect((await reloaded.get("protected-task"))?.config?.quotaReserve?.state.revision).toBe(1);
    });
  },
);

it.each(["idle", "closed", "error"] as const)(
  "does not invent interrupted work for an %s task",
  async (lastStatus) => {
    await withStorage(async (storage, directory) => {
      const saved = record(directory, { lastStatus });
      await storage.upsert(saved);
      expect(await reconcileQuotaReserveStartup(storage, 2000)).toBe(0);
      expect(await storage.get(saved.id)).toEqual(saved);
    });
  },
);

it("stops an idle supervisor with an interrupted worker without attaching policy to the worker", async () => {
  await withStorage(async (storage, directory) => {
    await storage.upsert(record(directory));
    const child = record(directory, {
      id: "worker",
      lastStatus: "running",
      config: undefined,
      labels: { [PARENT_AGENT_ID_LABEL]: "protected-task" },
    });
    await storage.upsert(child);
    expect(await reconcileQuotaReserveStartup(storage, 2000)).toBe(1);
    expect((await storage.get("protected-task"))?.config?.quotaReserve?.state.kind).toBe("stopped");
    expect(await storage.get(child.id)).toEqual(child);
  });
});

it("ignores archived workers and tasks with reserve off or quota exhaustion", async () => {
  await withStorage(async (storage, directory) => {
    const root = record(directory);
    const archivedChild = record(directory, {
      id: "archived-worker",
      lastStatus: "running",
      archivedAt: stamp,
      labels: { [PARENT_AGENT_ID_LABEL]: root.id },
    });
    const off = record(directory, {
      id: "off",
      lastStatus: "running",
      config: {
        quotaReserve: {
          policy: { kind: "off" },
          state: { kind: "ready", revision: 0, changedAt: stamp },
        },
      },
    });
    const exhausted = record(directory, {
      id: "exhausted",
      lastStatus: "running",
      config: { ...root.config, quotaPausedAt: stamp },
    });
    for (const saved of [root, archivedChild, off, exhausted]) await storage.upsert(saved);
    expect(await reconcileQuotaReserveStartup(storage, 2000)).toBe(0);
    expect(await storage.list()).toEqual([root, archivedChild, off, exhausted]);
  });
});

it.each(["manual", "redline", "recovery_uncertain"] as const)(
  "preserves an existing %s stop",
  async (reason) => {
    await withStorage(async (storage, directory) => {
      const saved = record(directory, {
        lastStatus: "running",
        config: {
          quotaReserve: {
            policy: { kind: "protected", cruisePct: 15, redlinePct: 10 },
            state: { kind: "stopped", reason, revision: 5, changedAt: stamp },
          },
        },
      });
      await storage.upsert(saved);
      expect(await reconcileQuotaReserveStartup(storage, 2000)).toBe(0);
      expect(await storage.get(saved.id)).toEqual(saved);
    });
  },
);

it("does not report reconciliation success when the review stop cannot be persisted", async () => {
  await withStorage(async (storage, directory) => {
    const saved = record(directory, { lastStatus: "running" });
    await storage.upsert(saved);
    const files = await readdir(directory, { recursive: true });
    const relative = files.find((file) => file.endsWith("protected-task.json"));
    if (!relative) throw new Error("Test record file missing");
    const target = join(directory, relative);
    await rm(target);
    await mkdir(target);
    await expect(reconcileQuotaReserveStartup(storage, 2000)).rejects.toThrow();
    expect((await storage.get(saved.id))?.config?.quotaReserve?.state.kind).toBe("ready");
  });
});
