import { expect, it } from "vitest";
import type { AttachmentMetadata, SaveAttachmentInput } from "../attachments/types";
import { captureQueueSubmission, type QueueAttachmentCapturePort } from "./stage";

const image: AttachmentMetadata = {
  id: "original",
  storageKey: "original",
  storageType: "web-indexeddb",
  mimeType: "image/png",
  fileName: "photo.png",
  byteSize: 3,
  createdAt: 0,
};

function fixture() {
  const saved: SaveAttachmentInput[] = [];
  const removed: string[] = [];
  const port: QueueAttachmentCapturePort = {
    original: { encodeBase64: async () => "YWJj" },
    owned: {
      save: async (input) => {
        saved.push(input);
        return { ...image, id: `copy-${saved.length}`, storageKey: `copy-${saved.length}` };
      },
      delete: async ({ attachment }) => {
        removed.push(attachment.id);
      },
    },
    download: async () => new Uint8Array([1, 2]),
  };
  return { port, saved, removed };
}

it("captures private image and file copies while retaining structured context", async () => {
  const { port, saved, removed } = fixture();
  const result = await captureQueueSubmission(
    {
      operationId: "op",
      messageId: "message",
      text: "Inspect",
      images: [image],
      attachments: [
        {
          type: "uploaded_file",
          id: "upload",
          path: "/upload",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 2,
        },
        { type: "text", text: "Context", title: "Notes", mimeType: "text/plain" },
      ],
    },
    port,
  );
  expect(result.operation).toMatchObject({
    kind: "enqueue",
    attachments: [],
    context: [{ type: "text", text: "Context" }],
  });
  expect(result.localAttachments.map(({ kind, metadata }) => [kind, metadata.id])).toEqual([
    ["image", "copy-1"],
    ["file", "copy-2"],
  ]);
  expect(saved.map(({ source }) => source)).toEqual([
    { kind: "data_url", dataUrl: "data:image/png;base64,YWJj" },
    { kind: "bytes", bytes: new Uint8Array([1, 2]) },
  ]);
  expect(removed).toEqual([]);
});

it("cleans partial copies when an uploaded file has changed before capture", async () => {
  const { port, removed } = fixture();
  await expect(
    captureQueueSubmission(
      {
        operationId: "op",
        messageId: "message",
        text: "Inspect",
        images: [image],
        attachments: [
          {
            type: "uploaded_file",
            id: "upload",
            path: "/upload",
            fileName: "notes.txt",
            mimeType: "text/plain",
            size: 10,
          },
        ],
      },
      port,
    ),
  ).rejects.toThrow("changed");
  expect(removed).toEqual(["copy-1"]);
});
