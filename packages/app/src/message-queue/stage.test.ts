import { expect, it } from "vitest";
import type { QueueOperation } from "@getpaseo/protocol/message-queue";
import type { AttachmentMetadata, SaveAttachmentInput } from "../attachments/types";
import { captureQueueEdit, captureQueueSubmission, type QueueAttachmentCapturePort } from "./stage";

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

const retained = {
  id: "remote-image",
  kind: "image" as const,
  fileName: "existing.png",
  mimeType: "image/png",
  size: 3,
};
const edit: Extract<QueueOperation, { kind: "edit" }> = {
  kind: "edit" as const,
  operationId: "edit-op",
  messageId: "message",
  expectedRevision: 7,
  text: "",
  attachments: [retained],
  context: [{ type: "text" as const, text: "Context", title: "Notes", mimeType: "text/plain" }],
};

it("captures new edit media without recopying retained media or changing its revision", async () => {
  const { port, saved, removed } = fixture();
  const result = await captureQueueEdit(edit, [image], port);
  expect(result.operation).toEqual(edit);
  expect(saved).toHaveLength(1);
  expect(result.localAttachments).toEqual([
    { kind: "image", metadata: { ...image, id: "copy-1", storageKey: "copy-1" } },
  ]);
  expect(removed).toEqual([]);
});

it("allows removing every old attachment without restoring original references", async () => {
  const { port, saved } = fixture();
  const result = await captureQueueEdit(
    { ...edit, text: "Text remains", attachments: [] },
    [],
    port,
  );
  expect(result.operation).toMatchObject({ attachments: [], expectedRevision: 7 });
  expect(result.localAttachments).toEqual([]);
  expect(saved).toEqual([]);
});

it("counts retained and new attachments together before making private copies", async () => {
  const { port, saved } = fixture();
  await expect(
    captureQueueEdit(
      {
        ...edit,
        attachments: Array.from({ length: 32 }, (_, i) => ({ ...retained, id: String(i) })),
      },
      [image],
      port,
    ),
  ).rejects.toThrow("at most 32");
  expect(saved).toEqual([]);
});

it("includes retained bytes in the total and cleans only partial new copies on overflow", async () => {
  const { port, removed } = fixture();
  const attachments = [
    { ...retained, id: "one", size: 25 * 1024 * 1024 },
    { ...retained, id: "two", size: 25 * 1024 * 1024 - 3 },
  ];
  await expect(captureQueueEdit({ ...edit, attachments }, [image, image], port)).rejects.toThrow(
    "50 MB",
  );
  expect(removed).toEqual(["copy-1"]);
});
