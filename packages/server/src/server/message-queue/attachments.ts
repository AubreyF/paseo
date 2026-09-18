import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import {
  QueueAttachmentSchema,
  type QueueAttachment,
  type QueueItem,
} from "@getpaseo/protocol/message-queue";
import type { AgentPromptContentBlock, AgentPromptInput } from "../agent/agent-sdk-types.js";

const ManifestSchema = z.object({ attachment: QueueAttachmentSchema, digest: z.string() });

export class QueueAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueAttachmentError";
  }
}

/** Uploaded files can be replaced or cleaned up independently of a queue. Only
 * the immutable captured copy may satisfy durable enqueue acknowledgement. */
export class QueueAttachmentStore {
  private readonly writes = new Map<string, Promise<void>>();
  private readonly root: string;
  constructor(private readonly home: string) {
    this.root = join(home, "message-queue-attachments");
  }

  private directory(attachment: QueueAttachment): string {
    return join(this.root, createHash("sha256").update(attachment.id).digest("hex"));
  }

  private metadata(attachment: QueueAttachment): string {
    return JSON.stringify({
      ...QueueAttachmentSchema.parse(attachment),
      kind: attachment.kind ?? "file",
    });
  }

  async capture(attachments: QueueAttachment[]): Promise<void> {
    let total = 0;
    for (const input of attachments) {
      const attachment = QueueAttachmentSchema.parse(input);
      total += attachment.size;
      if (total > 50 * 1024 * 1024)
        throw new QueueAttachmentError("Queued attachments exceed 50 MB.");
      const previous = this.writes.get(attachment.id) ?? Promise.resolve();
      const write = previous.catch(() => undefined).then(() => this.captureOne(attachment));
      this.writes.set(attachment.id, write);
      try {
        await write;
      } finally {
        if (this.writes.get(attachment.id) === write) this.writes.delete(attachment.id);
      }
    }
  }

  private async manifest(
    attachment: QueueAttachment,
  ): Promise<z.infer<typeof ManifestSchema> | null> {
    let content: string;
    try {
      content = await readFile(join(this.directory(attachment), "metadata.json"), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    const manifest = ManifestSchema.parse(JSON.parse(content));
    if (this.metadata(manifest.attachment) !== this.metadata(attachment))
      throw new QueueAttachmentError("Attachment metadata does not match the captured upload.");
    return manifest;
  }

  private async captureOne(attachment: QueueAttachment): Promise<void> {
    const validId = /^upload_[a-zA-Z0-9._-]+$/.test(attachment.id);
    const validName =
      attachment.fileName.length > 0 &&
      attachment.fileName !== "." &&
      attachment.fileName !== ".." &&
      basename(attachment.fileName) === attachment.fileName &&
      !attachment.fileName.includes("\\");
    if (!validId || !validName)
      throw new QueueAttachmentError("Invalid uploaded attachment reference.");
    if (await this.manifest(attachment)) {
      await this.read(attachment);
      return;
    }
    const uploadRoot = await realpath(join(this.home, "uploads"));
    const source = await realpath(join(uploadRoot, attachment.id, attachment.fileName));
    const sourceRelative = relative(uploadRoot, source);
    if (sourceRelative === ".." || sourceRelative.startsWith(`..${sep}`))
      throw new QueueAttachmentError("Attachment reference escapes the upload directory.");
    const file = await open(source, "r");
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== attachment.size)
        throw new QueueAttachmentError("Uploaded attachment size does not match its metadata.");
      bytes = await file.readFile();
      if (bytes.length !== attachment.size)
        throw new QueueAttachmentError("The upload changed during capture.");
    } finally {
      await file.close();
    }
    const directory = this.directory(attachment);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.write(join(directory, "content"), bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await this.write(
      join(directory, "metadata.json"),
      Buffer.from(JSON.stringify({ attachment, digest })),
    );
    await this.syncDirectory(directory);
    await this.syncDirectory(this.root);
    await this.syncDirectory(this.home);
  }

  private async write(destination: string, bytes: Buffer): Promise<void> {
    const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async read(attachment: QueueAttachment): Promise<Buffer> {
    const manifest = await this.manifest(attachment);
    if (!manifest) throw new QueueAttachmentError("The queued attachment is missing.");
    const bytes = await readFile(join(this.directory(attachment), "content"));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== attachment.size || digest !== manifest.digest)
      throw new QueueAttachmentError("The queued attachment failed its integrity check.");
    return bytes;
  }

  async location(attachment: QueueAttachment): Promise<{ cwd: string; path: string }> {
    await this.read(attachment);
    return { cwd: this.directory(attachment), path: "content" };
  }

  async prompt(item: QueueItem): Promise<AgentPromptInput> {
    if (item.attachments.length === 0 && !item.context?.length) return item.text;
    const blocks: AgentPromptContentBlock[] = [
      { type: "text", text: item.text },
      ...(item.context ?? []),
    ];
    for (const attachment of item.attachments) {
      const bytes = await this.read(attachment);
      if (attachment.kind === "image") {
        blocks.push({
          type: "image",
          data: bytes.toString("base64"),
          mimeType: attachment.mimeType,
        });
      } else {
        blocks.push({
          type: "uploaded_file",
          id: attachment.id,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          size: attachment.size,
          path: join(this.directory(attachment), "content"),
        });
      }
    }
    return blocks;
  }
}
