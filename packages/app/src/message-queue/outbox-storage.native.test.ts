import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ReplicaSqliteConnection,
  SqliteValue,
} from "../runtime/replica-cache/row-store-sqlite";
import { createSqliteOutboxStorage } from "./outbox-storage-sqlite";
import { outboxStorageContract } from "./outbox-storage.contract";

outboxStorageContract(async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-outbox-"));
  const databases: DatabaseSync[] = [];
  return {
    open() {
      const database = new DatabaseSync(join(directory, "outbox.db"));
      databases.push(database);
      const connection: ReplicaSqliteConnection = {
        exec: async (sql) => {
          database.exec(sql);
        },
        run: async (sql, params = []) => {
          database.prepare(sql).run(...(params as SQLInputValue[]));
        },
        all: async <T>(sql: string, params: readonly SqliteValue[] = []) =>
          database.prepare(sql).all(...(params as SQLInputValue[])) as T[],
        transaction: async (run) => {
          database.exec("BEGIN IMMEDIATE");
          try {
            await run(connection);
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        },
      };
      return createSqliteOutboxStorage(async () => connection);
    },
    async close() {
      for (const database of databases) database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
