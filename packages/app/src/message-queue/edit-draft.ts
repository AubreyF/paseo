import { z } from "zod";
import { QueueItemSchema } from "@getpaseo/protocol/message-queue";
import { LocalQueueAttachmentSchema } from "./outbox-record";

export const QueueEditDraftSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  serverId: z.string(),
  agentId: z.string(),
  revision: z.number().int().nonnegative(),
  original: QueueItemSchema,
  text: z.string(),
  attachments: QueueItemSchema.shape.attachments,
  localAttachments: z.array(LocalQueueAttachmentSchema).max(32),
  // Reusing this identity after reload closes the local commit/acknowledgement gap.
  submissionId: z.string().nullable(),
});
export type QueueEditDraft = z.infer<typeof QueueEditDraftSchema>;

export interface QueueEditDraftStorage {
  list(): Promise<QueueEditDraft[]>;
  exchange(draft: QueueEditDraft, expectedRevision: number | null): Promise<boolean>;
  remove(id: string, expectedRevision: number): Promise<boolean>;
}

export function draftHasContent(draft: QueueEditDraft): boolean {
  return !!(
    draft.text.trim() ||
    draft.attachments.length ||
    draft.localAttachments.length ||
    draft.original.context?.length
  );
}

export function draftHasChanges(draft: QueueEditDraft): boolean {
  return (
    draft.text !== draft.original.text ||
    draft.localAttachments.length > 0 ||
    JSON.stringify(draft.attachments) !== JSON.stringify(draft.original.attachments)
  );
}

export function validateDraftAttachments(draft: QueueEditDraft): void {
  const sizes = [
    ...draft.attachments.map((file) => file.size),
    ...draft.localAttachments.map((file) => file.metadata.byteSize),
  ];
  if (sizes.length > 32) throw new Error("A queued message can include at most 32 attachments.");
  let total = 0;
  for (const size of sizes) {
    if (size === undefined || size === null)
      throw new Error("Attachment size is unavailable. Add the image again.");
    total += size;
    if (size > 25 * 1024 * 1024 || total > 50 * 1024 * 1024)
      throw new Error("Queued attachments exceed the 25 MB per file or 50 MB per message limit.");
  }
}
