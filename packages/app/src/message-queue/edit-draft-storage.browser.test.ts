import { expect, it } from "vitest";
import { createQueueEditDraftStorage } from "./edit-draft-storage.web";
import { QueueEditDraftSession } from "./edit-draft-session";
import { createIndexedDbAttachmentStore } from "@/attachments/web/indexeddb-attachment-store";

it("retains unsaved image edits after reopening IndexedDB and isolates stale writes", async () => {
  const name = `queue-draft-${crypto.randomUUID()}`;
  const storage = createQueueEditDraftStorage(name);
  const bytes = createIndexedDbAttachmentStore(`${name}-bytes`);
  const session = new QueueEditDraftSession({
    storage,
    identity: () => crypto.randomUUID(),
    commit: async () => {},
    cleanup: async () => {},
  });
  const original = await session.open("host", "agent", {
    id: "message",
    revision: 3,
    text: "original",
    attachments: [],
    createdAt: new Date().toISOString(),
    delivery: { status: "queued" },
  });
  const image = await bytes.save({
    fileName: "image.png",
    mimeType: "image/png",
    source: { kind: "bytes", bytes: new Uint8Array([97, 98, 99]) },
  });
  const edited = await session.update(original, {
    text: "unsaved dictation",
    attachments: [],
    localAttachments: [{ kind: "image", metadata: image }],
  });
  const reopened = createQueueEditDraftStorage(name);
  const restored = (await reopened.list())[0];
  expect(restored).toEqual(edited);
  expect(
    await createIndexedDbAttachmentStore(`${name}-bytes`).encodeBase64({
      attachment: restored.localAttachments[0].metadata,
    }),
  ).toBe("YWJj");
  const outcomes = await Promise.all([
    storage.exchange({ ...edited, revision: 2, text: "first" }, 1),
    reopened.exchange({ ...edited, revision: 2, text: "second" }, 1),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  const winner = (await reopened.list())[0];
  expect(await storage.remove(winner.id, 1)).toBe(false);
  expect(await storage.remove(winner.id, 2)).toBe(true);
  expect(await reopened.list()).toEqual([]);
  await bytes.delete({ attachment: image });
});
