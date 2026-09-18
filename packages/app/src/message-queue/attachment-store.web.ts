import { createIndexedDbAttachmentStore } from "@/attachments/web/indexeddb-attachment-store";

// Browser and Electron outbox bytes have a separate lifetime from draft previews.
export const queueAttachmentStore = createIndexedDbAttachmentStore("paseo-message-outbox-bytes");
