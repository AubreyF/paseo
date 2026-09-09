import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ProviderResetAttemptSchema,
  ProviderResetOutcomeSchema,
  type ProviderResetAttempt,
  type ProviderResetOutcome,
} from "@getpaseo/protocol/provider-reset";
import { writeJsonFileAtomic } from "../../server/atomic-file.js";

const OperationFields = {
  ...ProviderResetAttemptSchema.shape,
  providerId: z.string().min(1),
  createdAt: z.string(),
};
const OperationSchema = z.discriminatedUnion("state", [
  z.object({ ...OperationFields, state: z.literal("prepared") }),
  z.object({ ...OperationFields, state: z.literal("pending") }),
  z.object({
    ...OperationFields,
    state: z.literal("completed"),
    outcome: ProviderResetOutcomeSchema,
  }),
]);
export type ResetCreditOperation = z.infer<typeof OperationSchema>;
interface PrepareReset {
  accountId: string;
  providerId: string;
  creditId?: string;
}
interface ConfirmReset {
  accountId: string;
  operationId: string;
}

export class ResetCreditStoreError extends Error {
  constructor(
    readonly code: "stale_operation" | "identity_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ResetCreditStoreError";
  }
}

/** One store per daemon; the daemon home lock excludes another writer process. */
export class ResetCreditStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  prepare(input: PrepareReset): Promise<ResetCreditOperation> {
    return this.withAccount(input.accountId, async () => {
      const existing = await this.read(input.accountId);
      // A second device or alias must join the unresolved operation. It cannot
      // allocate another key just because the first device lost its response.
      if (existing && existing.state !== "completed") return existing;
      const operation = OperationSchema.parse({
        ...input,
        idempotencyKey: randomUUID(),
        createdAt: new Date().toISOString(),
        state: "prepared",
      });
      await this.write(operation);
      return operation;
    });
  }

  confirm(
    input: ConfirmReset,
    consume: (attempt: ProviderResetAttempt) => Promise<ProviderResetOutcome>,
  ): Promise<ProviderResetOutcome> {
    return this.withAccount(input.accountId, async () => {
      const operation = await this.read(input.accountId);
      if (!operation || operation.idempotencyKey !== input.operationId) {
        throw new ResetCreditStoreError(
          "stale_operation",
          "This reset confirmation is no longer current. Refresh the account.",
        );
      }
      if (operation.state === "completed") return operation.outcome;
      const pending = OperationSchema.parse({ ...operation, state: "pending" });
      // Persist before the provider call. A crash or ambiguous failure leaves
      // this same key pending; neither startup nor reads retry it automatically.
      await this.write(pending);
      const attempt = ProviderResetAttemptSchema.parse(pending);
      const outcome = ProviderResetOutcomeSchema.parse(await consume(attempt));
      await this.write(OperationSchema.parse({ ...pending, state: "completed", outcome }));
      return outcome;
    });
  }

  async read(accountId: string): Promise<ResetCreditOperation | null> {
    let contents: string;
    try {
      contents = await fs.readFile(this.path(accountId), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    const operation = OperationSchema.parse(JSON.parse(contents));
    if (operation.accountId !== accountId) {
      throw new ResetCreditStoreError(
        "identity_mismatch",
        "The saved reset operation does not match this account.",
      );
    }
    return operation;
  }

  private path(accountId: string): string {
    const fingerprint = createHash("sha256").update(accountId).digest("hex");
    return join(this.directory, `${fingerprint}.json`);
  }

  private async write(operation: ResetCreditOperation): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.path(operation.accountId);
    await writeJsonFileAtomic(file, operation);
    await fs.chmod(file, 0o600);
  }

  private async withAccount<T>(accountId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(accountId) ?? Promise.resolve();
    const running = previous.then(action);
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(accountId, settled);
    try {
      return await running;
    } finally {
      if (this.queues.get(accountId) === settled) this.queues.delete(accountId);
    }
  }
}
