import type { AgentAttachment, UploadedFileAttachment } from "@getpaseo/protocol/messages";
import { QueueOperationSchema, type QueueOperation } from "@getpaseo/protocol/message-queue";
import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import type { LocalQueueAttachment } from "./outbox-record";

export interface QueueAttachmentCapturePort {
  original: Pick<AttachmentStore, "encodeBase64">;
  owned: Pick<AttachmentStore, "save" | "delete">;
  download(file: UploadedFileAttachment): Promise<Uint8Array>;
}

// Outbox bytes live outside draft garbage collection. The returned references
// become owned by the durable operation when its local commit succeeds.
export async function captureQueueSubmission(
  input: {
    operationId: string;
    messageId: string;
    text: string;
    images: AttachmentMetadata[];
    attachments: AgentAttachment[];
  },
  port: QueueAttachmentCapturePort,
): Promise<{ operation: QueueOperation; localAttachments: LocalQueueAttachment[] }> {
  const context = input.attachments.filter((attachment) => attachment.type !== "uploaded_file");
  const files = input.attachments.filter((attachment) => attachment.type === "uploaded_file");
  const operation = QueueOperationSchema.parse({
    kind: "enqueue",
    operationId: input.operationId,
    messageId: input.messageId,
    text: input.text,
    context,
    attachments: [],
  });
  return captureQueueContent(operation, input.images, files, port);
}

type QueueEditOperation = Extract<QueueOperation, { kind: "edit" }>;

export function captureQueueEdit(
  operation: QueueEditOperation,
  images: AttachmentMetadata[],
  port: QueueAttachmentCapturePort,
): Promise<{ operation: QueueOperation; localAttachments: LocalQueueAttachment[] }> {
  return captureQueueContent(QueueOperationSchema.parse(operation), images, [], port);
}

async function captureQueueContent(
  operation: QueueOperation,
  images: AttachmentMetadata[],
  files: UploadedFileAttachment[],
  port: QueueAttachmentCapturePort,
): Promise<{ operation: QueueOperation; localAttachments: LocalQueueAttachment[] }> {
  if (operation.kind !== "enqueue" && operation.kind !== "edit")
    throw new Error("Only queue content operations can capture attachments.");
  if (operation.attachments.length + images.length + files.length > 32)
    throw new Error("A queued message can include at most 32 files and images.");
  const localAttachments: LocalQueueAttachment[] = [];
  let totalBytes = 0;
  function countBytes(size: number): void {
    totalBytes += size;
    if (size > 25 * 1024 * 1024 || totalBytes > 50 * 1024 * 1024)
      throw new Error("Queued attachments exceed the 25 MB per file or 50 MB per message limit.");
  }
  // Retained host references contribute to limits without being copied or uploaded again.
  for (const attachment of operation.attachments) countBytes(attachment.size);
  try {
    for (const image of images) {
      const base64 = await port.original.encodeBase64({ attachment: image });
      countBytes(Math.floor((base64.replace(/=+$/, "").length * 3) / 4));
      const metadata = await port.owned.save({
        fileName: image.fileName,
        mimeType: image.mimeType,
        source: { kind: "data_url", dataUrl: `data:${image.mimeType};base64,${base64}` },
      });
      localAttachments.push({ kind: "image", metadata });
    }
    for (const file of files) {
      countBytes(file.size);
      const bytes = await port.download(file);
      if (bytes.byteLength !== file.size)
        throw new Error(`The file ${file.fileName} changed before it could be queued.`);
      const metadata = await port.owned.save({
        fileName: file.fileName,
        mimeType: file.mimeType,
        source: { kind: "bytes", bytes },
      });
      localAttachments.push({ kind: "file", metadata });
    }
    return { operation, localAttachments };
  } catch (error) {
    // No outbox operation exists yet, so these partial copies have no owner.
    await Promise.allSettled(
      localAttachments.map(({ metadata }) => port.owned.delete({ attachment: metadata })),
    );
    throw error;
  }
}
