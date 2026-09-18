import type { ReplicaSqliteConnection } from "@/runtime/replica-cache/row-store-sqlite";
import {
  encodeOutboxKey,
  nextOutboxOrder,
  OutboxRecordSchema,
  validateOutboxExchange,
  type OutboxStorage,
} from "./outbox-record";

export function createSqliteOutboxStorage(
  open: () => Promise<ReplicaSqliteConnection>,
): OutboxStorage {
  let opening: Promise<ReplicaSqliteConnection> | null = null;
  function database(): Promise<ReplicaSqliteConnection> {
    opening ??= (async () => {
      const db = await open();
      await db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      await db.exec(
        "CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)",
      );
      return db;
    })().catch((error: unknown) => {
      opening = null;
      throw error;
    });
    return opening;
  }
  return {
    async list() {
      const rows = await (
        await database()
      ).all<{ payload: string }>("SELECT payload FROM operations ORDER BY key");
      return rows.map((row) => OutboxRecordSchema.parse(JSON.parse(row.payload)));
    },
    async read(key) {
      const rows = await (
        await database()
      ).all<{ payload: string }>("SELECT payload FROM operations WHERE key = ?", [
        encodeOutboxKey(key),
      ]);
      return rows.length ? OutboxRecordSchema.parse(JSON.parse(rows[0].payload)) : null;
    },
    async exchange(key, expectedRevision, value) {
      validateOutboxExchange(key, expectedRevision, value);
      let exchanged = false;
      await (
        await database()
      ).transaction(async (tx) => {
        const encoded = encodeOutboxKey(key);
        const rows = await tx.all<{ payload: string }>(
          "SELECT payload FROM operations WHERE key = ?",
          [encoded],
        );
        const current = rows.length ? OutboxRecordSchema.parse(JSON.parse(rows[0].payload)) : null;
        const revision = current?.revision ?? null;
        if (revision !== expectedRevision) return;
        if (value) {
          const order =
            current?.order ??
            (current
              ? undefined
              : nextOutboxOrder(
                  (await tx.all<{ payload: string }>("SELECT payload FROM operations")).map((row) =>
                    OutboxRecordSchema.parse(JSON.parse(row.payload)),
                  ),
                ));
          await tx.run("INSERT OR REPLACE INTO operations (key, payload) VALUES (?, ?)", [
            encoded,
            JSON.stringify({ ...value, order }),
          ]);
        } else await tx.run("DELETE FROM operations WHERE key = ?", [encoded]);
        exchanged = true;
      });
      return exchanged;
    },
  };
}
