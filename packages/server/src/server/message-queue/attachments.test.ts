import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { QueueAttachmentStore } from "./attachments.js";

it("keeps captured attachments after their upload source disappears", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-queue-attachment-"));
  try {
    const upload = join(home, "uploads", "upload_test");
    await mkdir(upload, { recursive: true });
    await writeFile(join(upload, "image.png"), "image bytes");
    const attachment = {
      id: "upload_test",
      fileName: "image.png",
      mimeType: "image/png",
      size: 11,
      kind: "image" as const,
    };
    const store = new QueueAttachmentStore(home);
    await store.capture([attachment]);
    await rm(upload, { recursive: true });
    const restarted = new QueueAttachmentStore(home);
    await restarted.capture([attachment]);
    expect(await restarted.read(attachment)).toEqual(Buffer.from("image bytes"));
    await expect(restarted.capture([{ ...attachment, size: 10 }])).rejects.toThrow("metadata");
    await expect(restarted.capture([{ ...attachment, id: "../escape" }])).rejects.toThrow(
      "reference",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
