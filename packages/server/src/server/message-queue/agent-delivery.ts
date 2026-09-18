import type { Logger } from "pino";
import type { QueueAttachmentStore } from "./attachments.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { ensureUnarchivedAgentLoaded } from "../agent/agent-loading.js";
import type { QueueDeliveryPort } from "./delivery.js";

interface AgentDeliveryOptions {
  attachments: QueueAttachmentStore;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

export function createAgentQueueDelivery(
  options: AgentDeliveryOptions,
): Omit<QueueDeliveryPort, "changed"> {
  const { agentManager, agentStorage, logger } = options;
  return {
    async history(agentId) {
      const record = await agentStorage.get(agentId);
      if (!record || record.archivedAt) return [];
      const agent = await ensureUnarchivedAgentLoaded(agentId, options);
      if (!agent.session) return [];
      const events: AgentStreamEvent[] = [];
      for await (const event of agent.session.streamHistory()) events.push(event);
      return events;
    },
    async prepare(agentId, item) {
      const record = await agentStorage.get(agentId);
      if (!record || record.archivedAt) return false;
      const agent = await ensureUnarchivedAgentLoaded(agentId, options);
      if (item.sendNow && agent.activeTurnId !== item.sendNow.expectedTurnId)
        throw new Error("The active turn changed. Review the task before sending now.");
      if (agent.session?.goals) {
        const state = await agentManager.readAgentGoal(agentId);
        if (state.status !== "ready") return false;
        if (state.goal?.status === "active")
          await agentManager.setAgentGoal(agentId, { status: "paused" });
      }
      await agentManager.prepareQuotaReserveAdmission(agentId);
      return !!item.sendNow || (agent.lifecycle === "idle" && agent.pendingPermissions.size === 0);
    },
    load: (item) => options.attachments.prompt(item),
    start(agentId, item, prompt, canStart) {
      if (item.sendNow) return agentManager.startQueuedMessageNow(agentId, prompt, item, canStart);
      return agentManager.startQueuedMessage(agentId, prompt, item);
    },
    failed(error, agentId) {
      logger.error({ err: error, agentId }, "Queued message delivery stopped");
    },
  };
}
