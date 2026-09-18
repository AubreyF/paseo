import { expect, it } from "vitest";
import { isLegacyImportPending, legacyImportOperationId, withLegacyQueueLane } from "./legacy";
import type { OutboxRecord } from "./outbox-record";

it("holds legacy actions until an overlapping import commits and recovers after failure", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const importing = withLegacyQueueLane("host", "agent", async () => {
    events.push("capturing");
    await gate;
    events.push("committed");
  });
  const legacyAction = withLegacyQueueLane("host", "agent", async () => {
    events.push("ownership checked");
  });
  await Promise.resolve();
  expect(events).not.toContain("ownership checked");
  release();
  await Promise.all([importing, legacyAction]);
  expect(events).toEqual(["capturing", "committed", "ownership checked"]);
  await expect(
    withLegacyQueueLane("host", "agent", async () => {
      throw new Error("Storage full");
    }),
  ).rejects.toThrow("Storage full");
  expect(await withLegacyQueueLane("host", "agent", async () => "retry")).toBe("retry");
});

it("holds imported messages out of the legacy sender until acknowledgement", () => {
  const record: OutboxRecord = {
    version: 1,
    serverId: "host",
    agentId: "agent",
    revision: 0,
    createdAt: 1,
    localAttachments: [],
    prepared: null,
    error: null,
    operation: {
      kind: "enqueue",
      operationId: legacyImportOperationId("message"),
      messageId: "message",
      text: "Continue",
      attachments: [],
    },
  };
  expect(isLegacyImportPending([record], "host", "agent", "message")).toBe(true);
  expect(
    isLegacyImportPending(
      [{ ...record, error: { code: "conflict", message: "Resolve conflict" } }],
      "host",
      "agent",
      "message",
    ),
  ).toBe(true);
  expect(isLegacyImportPending([record], "other-host", "agent", "message")).toBe(false);
  expect(isLegacyImportPending([record], "host", "other-agent", "message")).toBe(false);
  expect(isLegacyImportPending([], "host", "agent", "message")).toBe(false);
});
