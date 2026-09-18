import { createExpoAttachmentFileSystem } from "@/attachments/attachment-file-system";
import { createLocalFileAttachmentStore } from "@/attachments/local-file-attachment-store";
import { isAbsolutePath } from "@/utils/path";

export function createNativeFileAttachmentStore(
  baseDirectoryName = "paseo-native-attachments",
  persistent = false,
) {
  return createLocalFileAttachmentStore({
    storageType: "native-file",
    baseDirectoryName,
    persistent,
    fileSystem: createExpoAttachmentFileSystem(),
    resolvePreviewUrl: async (attachment) => {
      if (attachment.storageKey.startsWith("file://")) {
        return attachment.storageKey;
      }
      if (isAbsolutePath(attachment.storageKey)) {
        if (attachment.storageKey.startsWith("/")) {
          return `file://${attachment.storageKey}`;
        }

        // UNC paths: \\server\share -> file://server/share
        if (attachment.storageKey.startsWith("\\\\")) {
          return `file:${attachment.storageKey.replace(/\\/g, "/")}`;
        }

        return `file:///${attachment.storageKey.replace(/\\/g, "/")}`;
      }
      return attachment.storageKey;
    },
  });
}
