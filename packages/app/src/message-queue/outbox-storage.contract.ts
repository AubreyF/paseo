import { expect, it } from "vitest";
import { outboxKey, type OutboxRecord, type OutboxStorage } from "./outbox-record";

export function outboxStorageContract(
  create: () => Promise<{ open: () => OutboxStorage; close: () => Promise<void> }>,
) {
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
      expect(await reloaded.list()).toEqual([record]);
      expect(await reloaded.exchange(key, null, record)).toBe(false);
      const changed = { ...record, revision: 1, prepared: record.operation };
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
