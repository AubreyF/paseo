import type { OutboxRecord } from "./outbox-record";

const lanes = new Map<string, Promise<unknown>>();

// A mode change may overlap an attachment capture or a legacy send. Give those
// operations one owner until the durable import or the old send finishes.
export function withLegacyQueueLane<T>(
  serverId: string,
  agentId: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([serverId, agentId]);
  const previous = lanes.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(run);
  lanes.set(key, operation);
  return operation.finally(() => {
    if (lanes.get(key) === operation) lanes.delete(key);
  });
}

export function legacyImportOperationId(messageId: string): string {
  return `legacy-import:${messageId}`;
}

export function isLegacyImportPending(
  records: readonly OutboxRecord[],
  serverId: string,
  agentId: string,
  messageId: string,
): boolean {
  return records.some(
    (record) =>
      record.serverId === serverId &&
      record.agentId === agentId &&
      record.operation.operationId === legacyImportOperationId(messageId),
  );
}
