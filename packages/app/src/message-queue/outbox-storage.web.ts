import {
  encodeOutboxKey,
  OutboxRecordSchema,
  validateOutboxExchange,
  type OutboxStorage,
  type OutboxRecord,
} from "./outbox-record";

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Outbox storage request failed")),
    );
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Outbox transaction aborted")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("Outbox transaction failed")),
    );
  });
}

export function createOutboxStorage(databaseName = "paseo-message-outbox"): OutboxStorage {
  let opening: Promise<IDBDatabase> | null = null;
  function database(): Promise<IDBDatabase> {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.addEventListener("upgradeneeded", () =>
        request.result.createObjectStore("operations"),
      );
      request.addEventListener("success", () => {
        request.result.addEventListener("versionchange", () => {
          request.result.close();
          opening = null;
        });
        resolve(request.result);
      });
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("Cannot open message outbox")),
      );
      request.addEventListener("blocked", () =>
        reject(new Error("Close other Paseo tabs to upgrade the message outbox.")),
      );
    }).catch((error: unknown) => {
      opening = null;
      throw error;
    });
    return opening;
  }

  async function transact<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await database();
    const transaction = db.transaction("operations", mode, { durability: "strict" });
    const done = completed(transaction);
    try {
      const result = await run(transaction.objectStore("operations"));
      await done;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already completed or aborted. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  return {
    list: () =>
      transact("readonly", async (store) => {
        const records: unknown[] = await requestValue(store.getAll());
        return records.map((record) => OutboxRecordSchema.parse(record));
      }),
    read: (key) =>
      transact("readonly", async (store) => {
        const record: unknown = await requestValue(store.get(encodeOutboxKey(key)));
        return record === undefined ? null : OutboxRecordSchema.parse(record);
      }),
    exchange: (key, expectedRevision, value) => {
      validateOutboxExchange(key, expectedRevision, value);
      return transact("readwrite", async (store) => {
        const encoded = encodeOutboxKey(key);
        const current: OutboxRecord | undefined = await requestValue(store.get(encoded));
        const revision = current === undefined ? null : OutboxRecordSchema.parse(current).revision;
        if (revision !== expectedRevision) return false;
        if (value) await requestValue(store.put(value, encoded));
        else await requestValue(store.delete(encoded));
        return true;
      });
    },
  };
}
