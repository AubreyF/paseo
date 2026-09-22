import { generateMessageId } from "@/types/stream";
import { queueAttachmentStore } from "./attachment-store";
import { createQueueEditDraftStorage } from "./edit-draft-storage";
import { QueueEditDraftSession } from "./edit-draft-session";
import { captureQueueEdit } from "./stage";
import { messageOutbox, flushMessageOutbox, refreshMessageOutbox } from "./runtime";

export const queueEditDraftStorage = createQueueEditDraftStorage();
export const queueEditDraftSession = new QueueEditDraftSession({
  storage: queueEditDraftStorage,
  identity: generateMessageId,
  cleanup: async (draft) => {
    await Promise.all(
      draft.localAttachments.map(({ metadata }) =>
        queueAttachmentStore.delete({ attachment: metadata }),
      ),
    );
  },
  commit: async (draft) => {
    if (!draft.submissionId) throw new Error("Missing queue edit submission identity.");
    const captured = await captureQueueEdit(
      {
        kind: "edit",
        operationId: draft.submissionId,
        messageId: draft.original.id,
        expectedRevision: draft.original.revision,
        text: draft.text,
        attachments: draft.attachments,
        context: draft.original.context,
      },
      draft.localAttachments.map(({ metadata }) => metadata),
      {
        original: queueAttachmentStore,
        owned: queueAttachmentStore,
        download: async () => {
          throw new Error("Queue edits retain existing file references.");
        },
      },
    );
    try {
      await messageOutbox.commit({
        serverId: draft.serverId,
        agentId: draft.agentId,
        createdAt: Date.now(),
        ...captured,
      });
    } catch (error) {
      await Promise.allSettled(
        captured.localAttachments.map(({ metadata }) =>
          queueAttachmentStore.delete({ attachment: metadata }),
        ),
      );
      throw error;
    }
    // The local durable commit is the Save boundary. Network work does not hold
    // the editor open or allow subsequent typing to alter the submitted copy.
    void refreshMessageOutbox(draft.serverId).catch(() => undefined);
    void flushMessageOutbox(draft.serverId);
  },
});

export async function reviewRejectedQueueEdit(
  record: import("./outbox-record").OutboxRecord,
  current: import("@getpaseo/protocol/message-queue").QueueItem | undefined,
): Promise<void> {
  if (record.operation.kind !== "edit" || !record.error)
    throw new Error("Only a rejected edit can be reviewed.");
  const original = current ?? {
    id: record.operation.messageId,
    revision: record.operation.expectedRevision,
    text: record.operation.text,
    attachments: record.operation.attachments,
    createdAt: new Date(record.createdAt).toISOString(),
    delivery: { status: "queued" as const },
  };
  const draft = await queueEditDraftSession.open(record.serverId, record.agentId, {
    ...original,
    context: record.operation.context,
  });
  const copies: import("./outbox-record").LocalQueueAttachment[] = [];
  try {
    for (const attachment of record.localAttachments) {
      const base64 = await queueAttachmentStore.encodeBase64({ attachment: attachment.metadata });
      const metadata = await queueAttachmentStore.save({
        mimeType: attachment.metadata.mimeType,
        fileName: attachment.metadata.fileName,
        source: {
          kind: "data_url",
          dataUrl: `data:${attachment.metadata.mimeType};base64,${base64}`,
        },
      });
      copies.push({ kind: attachment.kind, metadata });
    }
    await queueEditDraftSession.update(draft, {
      text: record.operation.text,
      attachments: record.operation.attachments,
      localAttachments: copies,
    });
  } catch (error) {
    await Promise.allSettled(
      copies.map(({ metadata }) => queueAttachmentStore.delete({ attachment: metadata })),
    );
    await queueEditDraftSession.discard(draft);
    throw error;
  }
  if (!record.dismissed)
    await messageOutbox.keepRejectedCopy({
      serverId: record.serverId,
      agentId: record.agentId,
      operationId: record.operation.operationId,
    });
  await refreshMessageOutbox(record.serverId);
}
