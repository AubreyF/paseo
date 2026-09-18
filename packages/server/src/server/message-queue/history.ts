import type { QueueAcceptedMessage } from "@getpaseo/protocol/message-queue";
import type { AgentStreamEvent, AgentProvider } from "../agent/agent-sdk-types.js";

/** Provider history owns ordering. Identity or an unambiguous turn joins a
 * captured prompt to its echo; repeated prompt text is never an identity. */
export function mergeQueueHistory(
  history: AgentStreamEvent[],
  accepted: QueueAcceptedMessage[],
  provider: AgentProvider,
): AgentStreamEvent[] {
  const events = [...history];
  for (const submission of accepted) {
    let index = events.findIndex(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "user_message" &&
        (event.item.clientMessageId === submission.item.id ||
          event.item.messageId === submission.item.id ||
          (!!submission.providerMessageId &&
            event.item.messageId === submission.providerMessageId)),
    );
    if (index < 0 && submission.turnId) {
      const candidates = events.flatMap((event, position) =>
        event.type === "timeline" &&
        event.item.type === "user_message" &&
        event.turnId === submission.turnId
          ? [position]
          : [],
      );
      if (candidates.length === 1) index = candidates[0];
    }
    const existing = index >= 0 ? events[index] : null;
    const nativeMessageId =
      existing?.type === "timeline" && existing.item.type === "user_message"
        ? existing.item.messageId
        : submission.providerMessageId;
    const event: AgentStreamEvent = {
      type: "timeline",
      provider,
      timestamp:
        existing?.type === "timeline"
          ? (existing.timestamp ?? submission.acceptedAt)
          : submission.acceptedAt,
      ...(submission.turnId ? { turnId: submission.turnId } : {}),
      item: {
        type: "user_message",
        text: submission.item.text,
        clientMessageId: submission.item.id,
        messageId: nativeMessageId ?? submission.item.id,
        queue: {
          attachments: submission.item.attachments,
          ...(submission.item.context ? { context: submission.item.context } : {}),
        },
      },
    };
    if (index >= 0) {
      events[index] = event;
      continue;
    }
    const after = events.findIndex(
      (entry) =>
        entry.type === "timeline" && entry.timestamp && entry.timestamp > submission.acceptedAt,
    );
    if (after < 0) events.push(event);
    else events.splice(after, 0, event);
  }
  return events;
}
