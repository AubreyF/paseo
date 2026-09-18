import { describe, expect, it } from "vitest";
import { createLocalFileAttachmentStore } from "./local-file-attachment-store";
import { createTestAttachmentFileSystem } from "./test-attachment-file-system";

describe("local file attachment store", () => {
  it("stores durable outbox copies in documents even when the cache is unavailable", async () => {
    const fileSystem = {
      ...createTestAttachmentFileSystem({ cacheDirectory: null }),
      documentDirectory: "file:///documents/",
    };
    const store = createLocalFileAttachmentStore({
      storageType: "native-file",
      baseDirectoryName: "outbox",
      persistent: true,
      fileSystem,
      resolvePreviewUrl: async (attachment) => attachment.storageKey,
    });
    const attachment = await store.save({
      id: "queued",
      mimeType: "image/png",
      source: { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) },
    });
    expect(attachment.storageKey).toBe("/documents/outbox/queued.png");
    expect(fileSystem.files.get("file:///documents/outbox/queued.png")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("writes raw byte sources directly to the managed file path", async () => {
    const fileSystem = createTestAttachmentFileSystem();
    const store = createLocalFileAttachmentStore({
      storageType: "native-file",
      baseDirectoryName: "preview-assets",
      fileSystem,
      resolvePreviewUrl: async (attachment) => `file://${attachment.storageKey}`,
    });

    const attachment = await store.save({
      id: "preview_8_test",
      mimeType: "image/png",
      fileName: "result.png",
      source: { kind: "bytes", bytes: new Uint8Array([0, 1, 2, 3]) },
    });

    expect(attachment).toMatchObject({
      id: "preview_8_test",
      mimeType: "image/png",
      storageType: "native-file",
      storageKey: "/cache/preview-assets/preview_8_test.png",
      fileName: "result.png",
      byteSize: 4,
    });
    expect(fileSystem.files.get("file:///cache/preview-assets/preview_8_test.png")).toEqual(
      new Uint8Array([0, 1, 2, 3]),
    );
    expect(fileSystem.directories.has("file:///cache/preview-assets")).toBe(true);
  });
});
