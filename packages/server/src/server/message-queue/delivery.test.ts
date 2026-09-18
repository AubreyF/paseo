import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { expect, it } from "vitest";
import { MessageQueueStore } from "./store.js";
import { QueueDeliveryWorker, type QueueDeliveryPort } from "./delivery.js";

it("uses restart evidence to advance without resending the accepted message", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-delivery-recovery-"));
  try {
    const store = new MessageQueueStore(root);
    for (const id of ["accepted", "next"])
      await store.mutate("agent", {
        kind: "enqueue",
        operationId: id,
        messageId: id,
        text: id,
        attachments: [],
      });
    await store.claim("agent");
    await store.recover("agent");
    const started: string[] = [];
    const worker = new QueueDeliveryWorker(store, {
      history: async () => [
        {
          type: "timeline",
          provider: "codex",
          turnId: "accepted-turn",
          item: {
            type: "user_message",
            text: "accepted",
            messageId: "provider-id",
            clientMessageId: "accepted",
          },
        },
      ],
      prepare: async () => true,
      load: async (item) => item.text,
      start: (_agentId, item) =>
        (async function* () {
          started.push(item.id);
          yield { type: "turn_started", provider: "codex", turnId: item.id };
        })(),
      changed: () => {},
      failed: (error) => {
        throw error;
      },
    });
    await worker.wake("agent");
    expect(started).toEqual(["next"]);
    expect((await store.read("agent")).items).toEqual([]);
    expect((await store.acceptedHistory("agent")).map((entry) => entry.item.id)).toEqual([
      "accepted",
      "next",
    ]);
    worker.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("admits send now while an earlier queued turn is still streaming", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-delivery-immediate-"));
  let finishFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  let signalStreaming!: () => void;
  const streaming = new Promise<void>((resolve) => {
    signalStreaming = resolve;
  });
  const received: string[] = [];
  try {
    const store = new MessageQueueStore(root);
    await store.mutate("agent", {
      kind: "enqueue",
      operationId: "first",
      messageId: "first",
      text: "first",
      attachments: [],
    });
    const worker = new QueueDeliveryWorker(store, {
      prepare: async () => true,
      load: async (item) => item.text,
      start: (_agentId, item) =>
        (async function* () {
          received.push(item.id);
          if (item.id === "selected") finishFirst();
          yield { type: "turn_started", provider: "codex", turnId: item.id };
          if (item.id === "first") {
            signalStreaming();
            await firstGate;
          }
          yield { type: "turn_completed", provider: "codex", turnId: item.id };
        })(),
      changed: () => {},
      failed: (error) => {
        throw error;
      },
    });
    const firstRun = worker.wake("agent");
    await streaming;
    await store.mutate("agent", {
      kind: "enqueue",
      operationId: "selected",
      messageId: "selected",
      text: "selected",
      attachments: [],
    });
    await store.mutate("agent", {
      kind: "send_now",
      operationId: "send",
      messageId: "selected",
      expectedRevision: 0,
      expectedTurnId: "first",
    });
    await worker.wakeImmediate("agent");
    await firstRun;
    expect(received).toEqual(["first", "selected"]);
    expect((await store.read("agent")).items).toEqual([]);
    worker.close();
  } finally {
    finishFirst();
    await rm(root, { recursive: true, force: true });
  }
});

it("retains a wake received while a completed pump reports an admission error", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-delivery-wake-"));
  try {
    const store = new MessageQueueStore(root);
    await store.mutate("agent", {
      kind: "enqueue",
      operationId: "add",
      messageId: "message",
      text: "continue",
      attachments: [],
    });
    let ready = false;
    const received: string[] = [];
    const errors: unknown[] = [];
    const failure = new Error("Admission state unavailable");
    const worker = new QueueDeliveryWorker(store, {
      load: async (item) => item.text,
      prepare: async () => {
        if (!ready) throw failure;
        return true;
      },
      start: (_agentId, item) =>
        (async function* () {
          received.push(item.id);
          yield { type: "turn_started", provider: "codex", turnId: item.id };
        })(),
      changed: () => {},
      failed: (error, agentId) => {
        errors.push(error);
        ready = true;
        void worker.wake(agentId);
      },
    });
    await worker.wake("agent");
    expect(errors).toEqual([failure]);
    expect(received).toEqual(["message"]);
    expect((await store.read("agent")).items).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("delivers in order without clients and retains accepted content for timeline recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-delivery-"));
  try {
    const store = new MessageQueueStore(root);
    for (const id of ["first", "second"])
      await store.mutate("agent", {
        kind: "enqueue",
        operationId: id,
        messageId: id,
        text: id,
        attachments: [],
      });
    const received: string[] = [];
    const port: QueueDeliveryPort = {
      load: async (item) => item.text,
      prepare: async () => true,
      start: (_agentId, item) =>
        (async function* () {
          received.push(item.id);
          yield { type: "turn_started", provider: "codex", turnId: item.id };
          yield { type: "turn_completed", provider: "codex", turnId: item.id };
        })(),
      changed: () => {},
      failed: (error) => {
        throw error;
      },
    };
    const worker = new QueueDeliveryWorker(store, port);
    await Promise.all([worker.wake("agent"), worker.wake("agent")]);
    expect(received).toEqual(["first", "second"]);
    expect((await store.read("agent")).items).toEqual([]);
    expect(await store.acceptedHistory("agent")).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not retry provider ambiguity or advance to a dependent message", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-delivery-uncertain-"));
  try {
    const store = new MessageQueueStore(root);
    for (const id of ["first", "second"])
      await store.mutate("agent", {
        kind: "enqueue",
        operationId: id,
        messageId: id,
        text: id,
        attachments: [],
      });
    let starts = 0;
    const worker = new QueueDeliveryWorker(store, {
      load: async (item) => item.text,
      prepare: async () => true,
      start: () =>
        (async function* () {
          starts += 1;
          yield await Promise.reject<AgentStreamEvent>(
            new Error("Provider connection lost before acknowledgement"),
          );
        })(),
      changed: () => {},
      failed: (error) => {
        throw error;
      },
    });
    await worker.wake("agent");
    await worker.wake("agent");
    expect(starts).toBe(1);
    const snapshot = await store.read("agent");
    expect(snapshot.items.map((item) => item.delivery.status)).toEqual(["uncertain", "queued"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("honors a stop received while admission preparation is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-delivery-stop-"));
  try {
    const store = new MessageQueueStore(root);
    await store.mutate("agent", {
      kind: "enqueue",
      operationId: "add",
      messageId: "message",
      text: "continue",
      attachments: [],
    });
    let allowPreparation!: (ready: boolean) => void;
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<boolean>((resolve) => {
      allowPreparation = resolve;
    });
    let started = false;
    const worker = new QueueDeliveryWorker(store, {
      load: async (item) => item.text,
      prepare: () => {
        entered();
        return gate;
      },
      start: () => {
        started = true;
        return null;
      },
      changed: () => {},
      failed: (error) => {
        throw error;
      },
    });
    const delivery = worker.wake("agent");
    await preparing;
    worker.halt("agent");
    allowPreparation(true);
    await delivery;
    expect(started).toBe(false);
    expect((await store.read("agent")).items[0].delivery.status).toBe("queued");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
