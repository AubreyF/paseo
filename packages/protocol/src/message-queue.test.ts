import { expect, it } from "vitest";
import { SessionInboundMessageSchema } from "./messages.js";
import { QueueChangedSchema } from "./message-queue.js";
import { WSOutboundMessageSchema as GeneratedWSOutboundMessageSchema } from "./generated/validation/ws-outbound.aot.js";

it("requires an explicit observed turn or idle state for send now", () => {
  const operation = {
    kind: "send_now",
    operationId: "send",
    messageId: "message",
    expectedRevision: 0,
  };
  const request = {
    type: "agent.queue.mutate.request",
    requestId: "request",
    agentId: "agent",
    operation,
  };
  expect(SessionInboundMessageSchema.safeParse(request).success).toBe(false);
  expect(
    SessionInboundMessageSchema.safeParse({
      ...request,
      operation: { ...operation, expectedTurnId: null },
    }).success,
  ).toBe(true);
  expect(
    SessionInboundMessageSchema.safeParse({
      ...request,
      operation: { ...operation, expectedTurnId: "observed-turn" },
    }).success,
  ).toBe(true);
});

it("accepts queue mutations through the session boundary and rejects invalid revisions", () => {
  const request = {
    type: "agent.queue.mutate.request",
    requestId: "request",
    agentId: "agent",
    operation: {
      kind: "edit",
      operationId: "edit",
      messageId: "message",
      expectedRevision: 2,
      text: "updated",
      attachments: [],
    },
  };
  expect(SessionInboundMessageSchema.safeParse(request).success).toBe(true);
  expect(
    SessionInboundMessageSchema.safeParse({
      ...request,
      operation: { ...request.operation, expectedRevision: -1 },
    }).success,
  ).toBe(false);
});

it("requires attempt identity on uncertain delivery snapshots", () => {
  const message = {
    type: "agent.queue.changed",
    payload: {
      agentId: "agent",
      revision: 3,
      paused: false,
      items: [
        {
          id: "message",
          revision: 2,
          text: "investigate",
          attachments: [],
          createdAt: "2026-09-17T00:00:00Z",
          delivery: { status: "uncertain", reason: "Restart" },
        },
      ],
    },
  };
  expect(QueueChangedSchema.safeParse(message).success).toBe(false);
});

it("accepts queue snapshots through the generated outbound validator", () => {
  const envelope = {
    type: "session",
    message: {
      type: "agent.queue.changed",
      payload: { agentId: "agent", revision: 0, paused: false, items: [] },
    },
  };
  expect(GeneratedWSOutboundMessageSchema.safeParse(envelope).success).toBe(true);
});

it("validates shared image references and captured context with the generated validator", () => {
  const envelope = {
    type: "session",
    message: {
      type: "agent.queue.changed",
      payload: {
        agentId: "agent",
        revision: 1,
        paused: true,
        items: [
          {
            id: "message",
            revision: 0,
            createdAt: "2026-09-17T00:00:00Z",
            delivery: { status: "queued" },
            text: "Review",
            context: [{ type: "text", mimeType: "text/plain", text: "Captured selection" }],
            attachments: [
              {
                id: "upload_image",
                kind: "image",
                fileName: "image.png",
                mimeType: "image/png",
                size: 123,
              },
            ],
          },
        ],
      },
    },
  };
  expect(GeneratedWSOutboundMessageSchema.safeParse(envelope).success).toBe(true);
});
