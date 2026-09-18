import { expect, it } from "vitest";
import type { QueueItem } from "@getpaseo/protocol/message-queue";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { findQueueAcceptanceEvidence } from "./evidence.js";

const item: QueueItem = {
  id: "client-message",
  revision: 2,
  text: "Repeat this",
  attachments: [],
  createdAt: "2026-09-17T00:00:00Z",
  delivery: {
    status: "uncertain",
    attemptId: "attempt",
    startedAt: "2026-09-17T00:01:00Z",
    reason: "Restart",
  },
};
const echo: AgentStreamEvent = {
  type: "timeline",
  provider: "codex",
  turnId: "turn",
  timestamp: "2026-09-17T00:01:02Z",
  item: {
    type: "user_message",
    messageId: "native-message",
    clientMessageId: item.id,
    text: item.text,
  },
};

it("accepts a unique stable identity and tolerates repeated observations of it", () => {
  expect(findQueueAcceptanceEvidence(item, undefined, [echo, echo])).toEqual({
    turnId: "turn",
    providerMessageId: "native-message",
    acceptedAt: "2026-09-17T00:01:02Z",
  });
});

it("requires identity, never repeated text, and rejects competing provider messages", () => {
  const sameText: AgentStreamEvent = {
    type: "timeline",
    provider: "codex",
    turnId: "turn",
    item: { type: "user_message", text: item.text, messageId: "unrelated" },
  };
  expect(findQueueAcceptanceEvidence(item, undefined, [sameText])).toBeNull();
  expect(findQueueAcceptanceEvidence(item, "unrelated", [sameText])).toMatchObject({
    providerMessageId: "unrelated",
  });
  const duplicate: AgentStreamEvent = {
    type: "timeline",
    provider: "codex",
    turnId: "other-turn",
    item: {
      type: "user_message",
      text: item.text,
      messageId: "other-native",
      clientMessageId: item.id,
    },
  };
  expect(findQueueAcceptanceEvidence(item, undefined, [echo, duplicate])).toBeNull();
  expect(
    findQueueAcceptanceEvidence({ ...item, delivery: { status: "queued" } }, undefined, [echo]),
  ).toBeNull();
});
