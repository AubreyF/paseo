import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentStorage } from "../agent-storage.js";
import { advanceQuotaReserve } from "./transition.js";

// Run before admitting schedules or client requests, without loading providers.
export async function reconcileQuotaReserveStartup(
  storage: AgentStorage,
  nowMs = Date.now(),
): Promise<number> {
  const records = await storage.list();
  const uncertain = new Set<string>();
  for (const record of records) {
    if (record.archivedAt) continue;
    if (record.lastStatus !== "running" && record.lastStatus !== "initializing") continue;
    uncertain.add(record.id);
    const parentId = record.labels[PARENT_AGENT_ID_LABEL];
    if (parentId) uncertain.add(parentId);
  }

  let stopped = 0;
  for (const record of records) {
    const reserve = record.config?.quotaReserve;
    if (!uncertain.has(record.id) || record.archivedAt || record.config?.quotaPausedAt) continue;
    if (reserve?.policy.kind !== "protected" || reserve.state.kind === "stopped") continue;
    const committed = await storage.updateQuotaReserve(record.id, (config) =>
      advanceQuotaReserve({
        config,
        trigger: "recovery_uncertain",
        observation: {
          windows: [],
          requiredWindowIds: [],
          observedAtMs: null,
          nowMs,
          maxAgeMs: 0,
        },
      }),
    );
    if (committed) stopped += 1;
  }
  return stopped;
}
