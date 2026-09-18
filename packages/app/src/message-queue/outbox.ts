import type {
  QueueAttachment,
  QueueOperation,
  QueueSnapshot,
} from "@getpaseo/protocol/message-queue";
import {
  OutboxRecordSchema,
  canKeepRejectedChange,
  outboxKey,
  type LocalQueueAttachment,
  type OutboxKey,
  type OutboxRecord,
  type OutboxStorage,
} from "./outbox-record";

export interface QueueOutboxPort {
  upload(serverId: string, attachment: LocalQueueAttachment): Promise<QueueAttachment>;
  mutate(
    serverId: string,
    agentId: string,
    operation: QueueOperation,
  ): Promise<{
    snapshot: QueueSnapshot | null;
    error: { code: string; message: string } | null;
  }>;
  changed(snapshot: QueueSnapshot, serverId: string): void;
  acknowledged?(record: OutboxRecord): Promise<void>;
}

export class QueueOutbox {
  constructor(
    private readonly storage: OutboxStorage,
    private readonly port: QueueOutboxPort,
  ) {}

  // Callers may clear the composer only after this transaction completes.
  async commit(input: {
    serverId: string;
    agentId: string;
    createdAt: number;
    operation: QueueOperation;
    localAttachments: LocalQueueAttachment[];
  }): Promise<void> {
    if (
      input.localAttachments.length &&
      input.operation.kind !== "enqueue" &&
      input.operation.kind !== "edit"
    ) {
      throw new Error("Only message content operations may include attachments");
    }
    const record = OutboxRecordSchema.parse({
      ...input,
      version: 1,
      revision: 0,
      error: null,
      prepared: input.localAttachments.length ? null : input.operation,
    });
    if (!(await this.storage.exchange(outboxKey(record), null, record))) {
      throw new Error("This operation is already in the message outbox");
    }
  }

  async list(): Promise<OutboxRecord[]> {
    return (await this.storage.list()).sort(
      (a, b) =>
        a.createdAt - b.createdAt || a.operation.operationId.localeCompare(b.operation.operationId),
    );
  }

  async retry(key: OutboxKey): Promise<void> {
    const record = await this.storage.read(key);
    if (!record?.error || record.dismissed) return;
    await this.storage.exchange(key, record.revision, {
      ...record,
      revision: record.revision + 1,
      error: null,
    });
  }

  async flush(serverId: string): Promise<void> {
    const blocked = new Set<string>();
    for (const candidate of await this.list()) {
      if (candidate.serverId !== serverId) continue;
      const canRepairQueue = ["delete", "pause", "resolve"].includes(candidate.operation.kind);
      if (blocked.has(candidate.agentId) && !canRepairQueue) continue;
      const record = await this.storage.read(outboxKey(candidate));
      if (!record || record.dismissed) continue;
      if (record.error || !(await this.deliver(record))) blocked.add(record.agentId);
    }
  }

  async keepRejectedCopy(key: OutboxKey): Promise<void> {
    const record = await this.storage.read(key);
    if (!record || !canKeepRejectedChange(record))
      throw new Error("Only a rejected change can be kept without synchronizing it.");
    if (
      !(await this.storage.exchange(key, record.revision, {
        ...record,
        revision: record.revision + 1,
        dismissed: true,
      }))
    )
      throw new Error("The pending change was updated on another tab. Review it again.");
  }

  async removeRejectedCopy(key: OutboxKey): Promise<void> {
    const record = await this.storage.read(key);
    if (!record?.dismissed || record.localAttachments.length)
      throw new Error("This operation still owns an unsynchronized message or attachment.");
    if (!(await this.storage.exchange(key, record.revision, null)))
      throw new Error("The local copy changed. Review it again.");
  }

  private async prepare(record: OutboxRecord): Promise<OutboxRecord | null> {
    if (record.prepared) return record;
    const operation = record.operation;
    if (operation.kind !== "enqueue" && operation.kind !== "edit")
      throw new Error("Invalid staged message operation");
    const attachments = [...operation.attachments];
    for (const local of record.localAttachments)
      attachments.push(await this.port.upload(record.serverId, local));
    const next: OutboxRecord = {
      ...record,
      revision: record.revision + 1,
      prepared: { ...operation, attachments },
    };
    const key = outboxKey(record);
    if (await this.storage.exchange(key, record.revision, next)) return next;
    // Another tab may have uploaded different remote IDs. Only the winner's exact
    // persisted operation can be sent with this idempotency key.
    return this.storage.read(key);
  }

  private async deliver(pending: OutboxRecord): Promise<boolean> {
    const record = await this.prepare(pending);
    if (!record) return true;
    if (record.error || !record.prepared) return false;
    const result = await this.port.mutate(record.serverId, record.agentId, record.prepared);
    const key = outboxKey(record);
    if (result.error) {
      await this.storage.exchange(key, record.revision, {
        ...record,
        revision: record.revision + 1,
        error: result.error,
      });
      return false;
    }
    if (!result.snapshot) throw new Error("Host did not acknowledge the queue operation");
    const removed = await this.storage.exchange(key, record.revision, null);
    this.port.changed(result.snapshot, record.serverId);
    if (removed) await this.port.acknowledged?.(record);
    return true;
  }
}
