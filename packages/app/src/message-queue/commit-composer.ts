import type { ComposerAttachment } from "@/attachments/types";
import { getAttachmentStore } from "@/attachments/store";
import { retainAttachmentForGarbageCollection } from "@/attachments/gc-retention";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import { generateMessageId } from "@/types/stream";
import { queueAttachmentStore } from "./attachment-store";
import { captureQueueSubmission } from "./stage";
import { flushMessageOutbox, messageOutbox, requireQueueClient } from "./runtime";

export async function commitComposerQueue(input: {
  serverId: string;
  agentId: string;
  cwd: string;
  text: string;
  attachments: ComposerAttachment[];
  identity?: { operationId: string; messageId: string };
}): Promise<void> {
  const split = splitComposerAttachmentsForSubmit(input.attachments);
  const release = split.images.map(({ id }) => retainAttachmentForGarbageCollection(id));
  try {
    const submission = await captureQueueSubmission(
      {
        operationId: input.identity?.operationId ?? generateMessageId(),
        messageId: input.identity?.messageId ?? generateMessageId(),
        text: input.text,
        images: split.images,
        attachments: split.attachments,
      },
      {
        original: await getAttachmentStore(),
        owned: queueAttachmentStore,
        download: async (file) =>
          (
            await requireQueueClient(input.serverId).readFile(
              input.cwd,
              file.path,
              undefined,
              file.size + 1,
            )
          ).bytes,
      },
    );
    await messageOutbox.commit({
      ...submission,
      serverId: input.serverId,
      agentId: input.agentId,
      createdAt: Date.now(),
    });
    // Network and replica refresh happen after the durable local commit. Their
    // failures must not restore the draft and invite a second submission.
    void flushMessageOutbox(input.serverId);
  } finally {
    for (const dispose of release) dispose();
  }
}
