import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { QueueSnapshot } from "@getpaseo/protocol/message-queue";
import { QueueAttachmentStore } from "./attachments.js";
import { MessageQueueStore } from "./store.js";
import { MessageQueueService } from "./service.js";

it("shares committed changes across subscribers and preserves the queue after they close", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-service-"));
  try {
    const service = new MessageQueueService(
      new MessageQueueStore(root),
      new QueueAttachmentStore(root),
    );
    const first: QueueSnapshot[] = [];
    const second: QueueSnapshot[] = [];
    const closeFirst = service.subscribe("agent", (snapshot) => first.push(snapshot));
    const closeSecond = service.subscribe("agent", (snapshot) => second.push(snapshot));
    await service.mutate("agent", {
      kind: "enqueue",
      operationId: "add",
      messageId: "message",
      text: "continue",
      attachments: [],
    });
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    closeFirst();
    closeSecond();
    const restarted = new MessageQueueService(
      new MessageQueueStore(root),
      new QueueAttachmentStore(root),
    );
    expect((await restarted.read("agent")).items).toMatchObject([
      { id: "message", text: "continue" },
    ]);
    await restarted.mutate("agent", {
      kind: "edit",
      operationId: "edit",
      messageId: "message",
      expectedRevision: 0,
      text: "new content",
      attachments: [],
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reconciles unfinished delivery before exposing a restarted queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-queue-recovery-"));
  try {
    const store = new MessageQueueStore(root);
    await store.mutate("agent", {
      kind: "enqueue",
      operationId: "add",
      messageId: "message",
      text: "continue",
      attachments: [],
    });
    await store.claim("agent");
    const restarted = new MessageQueueService(
      new MessageQueueStore(root),
      new QueueAttachmentStore(root),
    );
    expect((await restarted.read("agent")).items[0].delivery.status).toBe("uncertain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
