import { expect, it } from "vitest";
import type { QueueItem, QueueSnapshot } from "@getpaseo/protocol/message-queue";
import { queueReorderAction } from "./reorder";

const item = (id: string): QueueItem => ({
  id,
  text: id,
  attachments: [],
  revision: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  delivery: { status: "queued" },
});
const items = [item("first"), item("second"), item("third")];
const snapshot: QueueSnapshot = { agentId: "agent", revision: 8, paused: true, items };

it("persists a drop against the revision captured at drag start", () => {
  expect(queueReorderAction(snapshot, 8, [items[2], items[0], items[1]])).toEqual({
    kind: "reorder",
    expectedRevision: 8,
    messageIds: ["third", "first", "second"],
  });
});
it("does not mutate after a no-op drop", () => {
  expect(queueReorderAction(snapshot, 8, items)).toBeNull();
});
it("rejects changes from another device during the drag", () => {
  expect(() => queueReorderAction({ ...snapshot, revision: 9 }, 8, items)).toThrow("queue changed");
});
it("rejects missing or duplicate rows instead of dropping a queued message", () => {
  expect(() => queueReorderAction(snapshot, 8, [items[0], items[1]])).toThrow("queue changed");
  expect(() => queueReorderAction(snapshot, 8, [items[0], items[0], items[2]])).toThrow(
    "queue changed",
  );
});
it("rejects reordering once a message is being delivered", () => {
  const delivering: QueueItem = {
    ...items[0],
    delivery: {
      status: "uncertain",
      reason: "Not confirmed",
      attemptId: "attempt",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  expect(() =>
    queueReorderAction({ ...snapshot, items: [delivering, ...items.slice(1)] }, 8, items),
  ).toThrow("delivery");
});
