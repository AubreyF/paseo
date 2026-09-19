import type { QueueItem, QueueSnapshot } from "@getpaseo/protocol/message-queue";

export function queueReorderAction(
  snapshot: QueueSnapshot,
  startedRevision: number | null,
  items: QueueItem[],
) {
  if (startedRevision !== snapshot.revision) {
    throw new Error("The queue changed while dragging. Try again.");
  }
  if (snapshot.items.some((item) => item.delivery.status !== "queued")) {
    throw new Error("Wait for message delivery to finish before reordering.");
  }
  const messageIds = items.map((item) => item.id);
  const existing = new Set(snapshot.items.map((item) => item.id));
  if (
    messageIds.length !== existing.size ||
    new Set(messageIds).size !== existing.size ||
    messageIds.some((id) => !existing.has(id))
  ) {
    throw new Error("The queue changed while dragging. Try again.");
  }
  if (messageIds.every((id, index) => id === snapshot.items[index].id)) return null;
  return { kind: "reorder" as const, expectedRevision: startedRevision, messageIds };
}
