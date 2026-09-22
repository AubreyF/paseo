import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexedDbAttachmentStore } from "./indexeddb-attachment-store";

describe("indexeddb attachment store", () => {
  beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
  afterEach(() => vi.unstubAllGlobals());

  it("stores raw byte sources as a Blob after the transaction commits", async () => {
    const store = createIndexedDbAttachmentStore();
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const attachment = await store.save({
      id: "att_bytes",
      mimeType: "image/png",
      fileName: "image.png",
      source: { kind: "bytes", bytes },
    });
    expect(attachment).toMatchObject({
      id: "att_bytes",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "att_bytes",
      fileName: "image.png",
      byteSize: 4,
    });
    // Reopen through a new store to verify the committed bytes.
    const reopened = createIndexedDbAttachmentStore();
    const url = await reopened.resolvePreviewUrl({ attachment });
    try {
      const blob = await (await fetch(url)).blob();
      expect(blob.type).toBe("image/png");
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    } finally {
      await reopened.releasePreviewUrl?.({ attachment, url });
    }
  });
});
