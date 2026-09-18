import { expect, it } from "vitest";
import { createOutboxStorage } from "./outbox-storage.web";
import { outboxStorageContract } from "./outbox-storage.contract";
import { outboxKey, type OutboxRecord } from "./outbox-record";
import { createIndexedDbAttachmentStore } from "../attachments/web/indexeddb-attachment-store";

it("retains outbox attachment copies after draft cleanup and reopening storage", async () => {
  const suffix = crypto.randomUUID();
  const draft = createIndexedDbAttachmentStore(`draft-${suffix}`);
  const owned = createIndexedDbAttachmentStore(`outbox-bytes-${suffix}`);
  const original = await draft.save({
    mimeType: "image/png",
    source: { kind: "bytes", bytes: new Uint8Array([97, 98, 99]) },
  });
  const base64 = await draft.encodeBase64({ attachment: original });
  const copy = await owned.save({
    mimeType: original.mimeType,
    source: { kind: "data_url", dataUrl: `data:image/png;base64,${base64}` },
  });
  await draft.garbageCollect({ referencedIds: new Set() });
  await expect(draft.encodeBase64({ attachment: original })).rejects.toThrow();
  const reloaded = createIndexedDbAttachmentStore(`outbox-bytes-${suffix}`);
  expect(await reloaded.encodeBase64({ attachment: copy })).toBe("YWJj");
  await reloaded.delete({ attachment: copy });
  await expect(owned.encodeBase64({ attachment: copy })).rejects.toThrow();
});

outboxStorageContract(async () => {
  const databaseName = `paseo-outbox-test-${crypto.randomUUID()}`;
  return { open: () => createOutboxStorage(databaseName), close: async () => {} };
});

it("allows only one browser connection to prepare an operation", async () => {
  const databaseName = `paseo-outbox-race-${crypto.randomUUID()}`;
  const first = createOutboxStorage(databaseName);
  const second = createOutboxStorage(databaseName);
  const record: OutboxRecord = {
    version: 1,
    serverId: "host",
    agentId: "agent",
    revision: 0,
    createdAt: 1,
    operation: {
      kind: "enqueue",
      operationId: "op",
      messageId: "message",
      text: "Continue",
      attachments: [],
    },
    prepared: null,
    localAttachments: [],
    error: null,
  };
  const key = outboxKey(record);
  await first.exchange(key, null, record);
  const results = await Promise.all([
    first.exchange(key, 0, { ...record, revision: 1, prepared: record.operation }),
    second.exchange(key, 0, { ...record, revision: 1, prepared: record.operation }),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect((await second.read(key))?.revision).toBe(1);
});
