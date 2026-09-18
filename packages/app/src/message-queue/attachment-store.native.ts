import { createNativeFileAttachmentStore } from "@/attachments/native/native-file-attachment-store";

export const queueAttachmentStore = createNativeFileAttachmentStore(
  "paseo-message-outbox-bytes",
  true,
);
