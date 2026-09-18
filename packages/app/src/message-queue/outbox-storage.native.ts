import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import type { ReplicaSqliteConnection } from "@/runtime/replica-cache/row-store-sqlite";
import { createSqliteOutboxStorage } from "./outbox-storage-sqlite";

function connection(database: SQLiteDatabase): ReplicaSqliteConnection {
  return {
    exec: (sql) => database.execAsync(sql),
    run: async (sql, params = []) => {
      await database.runAsync(sql, [...params]);
    },
    all: (sql, params = []) => database.getAllAsync(sql, [...params]),
    transaction: (run) =>
      database.withExclusiveTransactionAsync(async (tx) => {
        await run(connection(tx));
      }),
  };
}

export function createOutboxStorage() {
  return createSqliteOutboxStorage(async () =>
    connection(await openDatabaseAsync("paseo-message-outbox.db")),
  );
}
