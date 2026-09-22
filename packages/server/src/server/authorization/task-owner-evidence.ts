import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { QueueOperationSchema, type QueueOperation } from "@getpaseo/protocol/message-queue";

const ReceiptSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string().min(1),
    principalId: z.literal("owner"),
    clientId: z.string().min(1),
    messageId: z.string().min(1),
    receivedAt: z.string().datetime(),
    sequence: z.number().int().positive().safe(),
    text: z.string(),
    queueOperation: QueueOperationSchema.optional(),
  })
  .strict();

type Receipt = z.infer<typeof ReceiptSchema>;

// All sessions in the single owning daemon share a task writer. The persisted
// sequence, rather than a wall clock or client ID, determines receipt order.
const writers = new Map<string, Promise<void>>();

export interface OwnerMessageEvidence {
  taskId: string;
  /** Transport admission supplies this value, never a message or agent label. */
  principalId?: string | null;
  clientId: string;
  messageId: string;
  text: string;
  /** Queue ingress, including edits and deletions; never proof of delivery. */
  queueOperation?: QueueOperation;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Exact owner-principal messages, not inferred grants. The daemon state must
 * remain inaccessible to untrusted workers, just like its credentials. File
 * modes protect against other users, not arbitrary code running as the daemon.
 */
export class TaskOwnerEvidenceStore {
  private readonly root: string;

  constructor(
    paseoHome: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.root = resolve(paseoHome, "task-owner-evidence");
  }

  private directory(taskId: string): string {
    return join(this.root, digest(taskId));
  }

  private async privateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      throw new Error("Owner evidence directory is not private");
    }
  }

  private async readReceipt(path: string): Promise<Receipt> {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Owner evidence file is a symlink");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
        throw new Error("Owner evidence file is not private");
      }
      return ReceiptSchema.parse(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  }

  async record(input: OwnerMessageEvidence): Promise<void> {
    if (input.principalId !== "owner") return;
    const key = this.directory(input.taskId);
    const pending = (writers.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.append(input));
    writers.set(key, pending);
    try {
      await pending;
    } finally {
      if (writers.get(key) === pending) writers.delete(key);
    }
  }

  private async append(input: OwnerMessageEvidence): Promise<void> {
    const previousReceipts = await this.list(input.taskId);
    const receipt = ReceiptSchema.parse({
      ...input,
      version: 1,
      receivedAt: this.now().toISOString(),
      sequence: (previousReceipts.at(-1)?.sequence ?? 0) + 1,
    });
    await this.privateDirectory(this.root);
    const directory = this.directory(input.taskId);
    await this.privateDirectory(directory);
    const name = digest(JSON.stringify([input.clientId, input.messageId]));
    const target = join(directory, `${name}.json`);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(receipt));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      try {
        // Atomic publish without replacement: replay cannot overwrite evidence.
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = await this.readReceipt(target);
        if (
          previous.taskId !== input.taskId ||
          previous.clientId !== input.clientId ||
          previous.messageId !== input.messageId ||
          previous.text !== input.text ||
          !isDeepStrictEqual(previous.queueOperation, input.queueOperation)
        ) {
          throw new Error("Owner message identity was reused with different evidence", {
            cause: error,
          });
        }
      }
      // Windows does not support opening directories for fsync through Node.
      // Files are flushed before publication; private home ACLs remain the
      // Windows access boundary rather than POSIX permission bits.
      if (process.platform !== "win32") {
        const handle = await open(directory, constants.O_RDONLY);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async list(taskId: string): Promise<Receipt[]> {
    const directory = this.directory(taskId);
    let names: string[];
    try {
      // Refuse symlinks and permissive state rather than trusting substituted text.
      for (const path of [this.root, directory]) {
        const stat = await lstat(path);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
        ) {
          throw new Error("Owner evidence directory is not private");
        }
      }
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const receipts = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map(async (name) => {
          const receipt = await this.readReceipt(join(directory, name));
          if (
            receipt.taskId !== taskId ||
            name !== `${digest(JSON.stringify([receipt.clientId, receipt.messageId]))}.json`
          ) {
            throw new Error("Owner evidence task or message binding changed");
          }
          return receipt;
        }),
    );
    receipts.sort((a, b) => a.sequence - b.sequence);
    if (receipts.some((receipt, index) => receipt.sequence !== index + 1)) {
      throw new Error("Owner evidence sequence is incomplete or conflicting");
    }
    return receipts;
  }
}
