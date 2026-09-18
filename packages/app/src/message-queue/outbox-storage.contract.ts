import { expect, it } from "vitest";
import { QueueOutbox } from "./outbox";
import { outboxKey, type OutboxRecord, type OutboxStorage } from "./outbox-record";

export function outboxStorageContract(
  create: () => Promise<{ open: () => OutboxStorage; close: () => Promise<void> }>,
) {
  it("preserves commit order across connections despite identical or decreasing timestamps", async () => {
    const fixture = await create();
    try {
      const first = fixture.open();
      const second = fixture.open();
      for (const [id, createdAt] of [
        ["z", 10],
        ["a", 10],
        ["b", 1],
      ] as const) {
        const record: OutboxRecord = {
          version: 1,
          serverId: "host",
          agentId: "agent",
          revision: 0,
          createdAt,
          operation: { kind: "enqueue", operationId: id, messageId: id, text: id, attachments: [] },
          prepared: null,
          localAttachments: [],
          error: null,
        };
        await (id === "a" ? second : first).exchange(outboxKey(record), null, record);
      }
      const outbox = new QueueOutbox(fixture.open(), {
        upload: async () => {
          throw new Error("Unexpected upload");
        },
        mutate: async () => {
          throw new Error("Unexpected network request");
        },
        changed: () => {},
      });
      const records = await outbox.list();
      expect(records.map((record) => record.operation.operationId)).toEqual(["z", "a", "b"]);
      expect(records.map((record) => record.order)).toEqual([1, 2, 3]);
      const saved = records[0];
      await second.exchange(outboxKey(saved), 0, { ...saved, revision: 1, order: 999 });
      expect((await first.read(outboxKey(saved)))?.order).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("retains messages across connections and rejects stale updates and acknowledgements", async () => {
    const fixture = await create();
    try {
      const first = fixture.open();
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
          text: "Retain me",
          attachments: [],
        },
        prepared: null,
        localAttachments: [],
        error: null,
      };
      const key = outboxKey(record);
      expect(await first.exchange(key, null, record)).toBe(true);
      const reloaded = fixture.open();
      const saved = { ...record, order: 1 };
      expect(await reloaded.list()).toEqual([saved]);
      expect(await reloaded.exchange(key, null, record)).toBe(false);
      const changed = { ...saved, revision: 1, prepared: record.operation };
      expect(await reloaded.exchange(key, 0, changed)).toBe(true);
      expect(
        await first.exchange(key, 0, { ...changed, error: { code: "stale", message: "stale" } }),
      ).toBe(false);
      expect(await first.exchange(key, 0, null)).toBe(false);
      expect(await first.read(key)).toEqual(changed);
      expect(await first.exchange(key, 1, null)).toBe(true);
      expect(await reloaded.list()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
}
