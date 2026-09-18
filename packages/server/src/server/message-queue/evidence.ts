import type { QueueItem } from "@getpaseo/protocol/message-queue";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";

export interface QueueAcceptanceEvidence {
  turnId: string | null;
  providerMessageId?: string;
  acceptedAt: string;
}

// Only raw provider history is evidence. An app timeline can include optimistic
// rows and daemon overlays, neither of which proves provider acceptance.
export function findQueueAcceptanceEvidence(
  item: QueueItem,
  providerMessageId: string | undefined,
  history: readonly AgentStreamEvent[],
): QueueAcceptanceEvidence | null {
  if (item.delivery.status !== "uncertain") return null;
  const matches = new Map<string, QueueAcceptanceEvidence>();
  for (const event of history) {
    if (event.type !== "timeline" || event.item.type !== "user_message") continue;
    const message = event.item;
    const identified =
      message.clientMessageId === item.id ||
      message.messageId === item.id ||
      (providerMessageId !== undefined && message.messageId === providerMessageId);
    if (!identified) continue;
    const turnId = event.turnId ?? null;
    const nativeId = message.messageId;
    const acceptedAt =
      event.timestamp && Number.isFinite(Date.parse(event.timestamp))
        ? event.timestamp
        : item.delivery.startedAt;
    matches.set(JSON.stringify([nativeId ?? null, turnId]), {
      turnId,
      ...(nativeId ? { providerMessageId: nativeId } : {}),
      acceptedAt,
    });
  }
  // Repeated observations of one native message are fine. Multiple distinct
  // provider messages with the same client ID require explicit review.
  return matches.size === 1 ? [...matches.values()][0] : null;
}
