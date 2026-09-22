import { openDatabaseAsync } from "expo-sqlite";
import { QueueEditDraftSchema, type QueueEditDraftStorage } from "./edit-draft";

export function createQueueEditDraftStorage(): QueueEditDraftStorage {
  const database = async () => {
    const db = await openDatabaseAsync("paseo-queue-edit-drafts.db");
    await db.execAsync(
      "CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)",
    );
    return db;
  };
  return {
    list: async () => {
      const rows = await (
        await database()
      ).getAllAsync<{ value: string }>("SELECT value FROM drafts");
      return rows.map((row) => QueueEditDraftSchema.parse(JSON.parse(row.value)));
    },
    exchange: async (draft, expected) => {
      QueueEditDraftSchema.parse(draft);
      if (draft.revision !== (expected === null ? 0 : expected + 1))
        throw new Error("Invalid queue draft revision.");
      const db = await database();
      let changed = false;
      await db.withExclusiveTransactionAsync(async (tx) => {
        const row = await tx.getFirstAsync<{ revision: number }>(
          "SELECT revision FROM drafts WHERE id = ?",
          draft.id,
        );
        if ((row?.revision ?? null) !== expected) return;
        await tx.runAsync(
          "INSERT OR REPLACE INTO drafts VALUES (?, ?, ?)",
          draft.id,
          draft.revision,
          JSON.stringify(draft),
        );
        changed = true;
      });
      return changed;
    },
    remove: async (id, revision) =>
      (
        await (
          await database()
        ).runAsync("DELETE FROM drafts WHERE id = ? AND revision = ?", id, revision)
      ).changes === 1,
  };
}
