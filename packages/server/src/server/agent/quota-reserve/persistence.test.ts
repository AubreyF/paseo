import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import { AgentStorage, parseStoredAgentRecord } from "../agent-storage.js";
import { InvalidQuotaReservePolicyError } from "@getpaseo/protocol/quota-reserve";
import { buildConfigOverrides, buildSessionConfig } from "../../persistence-hooks.js";

it.each(["redline", "manual", "recovery_uncertain"] as const)(
  "retains a %s stop and policy through storage reload and session reconstruction",
  async (reason) => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-reserve-storage-"));
    const logger = pino({ level: "silent" });
    const quotaReserve = {
      policy: { kind: "protected" as const, cruisePct: 50, redlinePct: 10 },
      state: {
        kind: "stopped" as const,
        reason,
        revision: 2,
        changedAt: "2026-09-10T00:00:00.000Z",
      },
    };
    try {
      const storage = new AgentStorage(directory, logger);
      await storage.upsert({
        id: "reserve-task",
        provider: "codex-secondary",
        cwd: directory,
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z",
        lastStatus: "idle",
        labels: {},
        config: { quotaReserve },
      });
      const restored = await new AgentStorage(directory, logger).get("reserve-task");
      if (!restored) throw new Error("Stored task missing");
      expect(restored.config?.quotaReserve).toEqual(quotaReserve);
      expect(buildConfigOverrides(restored).quotaReserve).toEqual(quotaReserve);
      expect(
        buildSessionConfig(restored, { validProviders: new Set(["codex-secondary"]) })
          ?.quotaReserve,
      ).toEqual(quotaReserve);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("rejects stored policies whose Redline is above Cruise Reserve", () => {
  expect(() =>
    parseStoredAgentRecord({
      id: "invalid-policy",
      provider: "codex-secondary",
      cwd: "/tmp",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
      config: {
        quotaReserve: {
          policy: { kind: "protected", cruisePct: 10, redlinePct: 15 },
          state: { kind: "ready", revision: 0, changedAt: "2026-09-10T00:00:00.000Z" },
        },
      },
    }),
  ).toThrow(InvalidQuotaReservePolicyError);
});
