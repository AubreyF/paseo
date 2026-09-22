import { expect, it } from "vitest";
import type { QueueItem } from "@getpaseo/protocol/message-queue";
import type { QueueEditDraft, QueueEditDraftStorage } from "./edit-draft";
import { QueueEditDraftSession } from "./edit-draft-session";

const item: QueueItem = {
  id: "message",
  revision: 0,
  text: "original",
  attachments: [],
  createdAt: "2026-09-19T00:00:00Z",
  delivery: { status: "queued" },
};
function fixture() {
  const records = new Map<string, QueueEditDraft>();
  const storage: QueueEditDraftStorage = {
    list: async () => [...records.values()],
    exchange: async (draft, revision) => {
      if ((records.get(draft.id)?.revision ?? null) !== revision) return false;
      records.set(draft.id, structuredClone(draft));
      return true;
    },
    remove: async (id, revision) => {
      if (records.get(id)?.revision !== revision) return false;
      return records.delete(id);
    },
  };
  let identity = 0;
  const committed: QueueEditDraft[] = [];
  const cleaned: string[] = [];
  const port = {
    storage,
    identity: () => String(++identity),
    commit: async (draft: QueueEditDraft) => {
      committed.push(draft);
    },
    cleanup: async (draft: QueueEditDraft) => {
      cleaned.push(draft.id);
    },
  };
  return { records, storage, committed, cleaned, port, session: new QueueEditDraftSession(port) };
}

it("restores a draft with its original revision after the session is replaced", async () => {
  const f = fixture();
  const original = await f.session.open("host", "agent", item);
  const edited = await f.session.update(original, {
    text: "dictated edit",
    attachments: [],
    localAttachments: [],
  });
  const restored = (await f.storage.list())[0];
  expect(restored).toEqual(edited);
  await new QueueEditDraftSession(f.port).save(restored);
  expect(f.committed[0]).toMatchObject({ text: "dictated edit", original: { revision: 0 } });
  expect(await f.storage.list()).toEqual([]);
});

it("rejects stale local writes and isolates concurrent drafts for the same message", async () => {
  const f = fixture();
  const first = await f.session.open("host", "agent", item);
  const second = await f.session.open("host", "agent", item);
  await f.session.update(first, { text: "first edit", attachments: [], localAttachments: [] });
  await expect(
    f.session.update(first, { text: "stale edit", attachments: [], localAttachments: [] }),
  ).rejects.toThrow("another tab");
  await f.session.discard(second);
  expect((await f.storage.list())[0].text).toBe("first edit");
  expect(f.committed).toEqual([]);
});

it("retains an interrupted submission without automatically replaying it", async () => {
  const f = fixture();
  f.port.commit = async () => {
    throw new Error("storage full");
  };
  const draft = await f.session.open("host", "agent", item);
  await expect(f.session.save(draft)).rejects.toThrow("storage full");
  const saved = (await f.storage.list())[0];
  expect(saved.submissionId).not.toBeNull();
  await expect(f.session.save(saved)).rejects.toThrow("may already be saved");
  expect(f.cleaned).toEqual([]);
});

it("refuses an empty edited message before creating a submission", async () => {
  const f = fixture();
  const draft = await f.session.open("host", "agent", item);
  const empty = await f.session.update(draft, { text: " ", attachments: [], localAttachments: [] });
  await expect(f.session.save(empty)).rejects.toThrow("Add text");
  expect((await f.storage.list())[0].submissionId).toBeNull();
});
