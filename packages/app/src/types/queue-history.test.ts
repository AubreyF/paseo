import { expect, it } from "vitest";
import { applyStreamEvent, createUserMessage } from "./stream";

it("retains shared queue attachments on a canonical prompt with no text", () => {
  const queue = {
    attachments: [
      {
        id: "upload_image",
        kind: "image" as const,
        fileName: "image.png",
        mimeType: "image/png",
        size: 12,
      },
    ],
  };
  const timestamp = new Date("2026-09-17T00:00:00Z");
  const event = {
    type: "timeline" as const,
    provider: "codex",
    item: {
      type: "user_message" as const,
      text: "",
      clientMessageId: "message",
      messageId: "message",
      queue,
    },
  };
  const result = applyStreamEvent({ tail: [], head: [], event, timestamp });
  expect(result.tail).toHaveLength(1);
  expect(result.tail[0]).toMatchObject({ kind: "user_message", id: "message", queue });
});

it("adds shared attachment metadata when canonical acknowledgement meets an existing prompt", () => {
  const timestamp = new Date("2026-09-17T00:00:00Z");
  const local = createUserMessage({
    id: "message",
    clientMessageId: "message",
    text: "Inspect",
    timestamp,
  });
  const queue = {
    attachments: [{ id: "upload_file", fileName: "notes.txt", mimeType: "text/plain", size: 12 }],
  };
  const result = applyStreamEvent({
    tail: [local],
    head: [],
    timestamp,
    event: {
      type: "timeline",
      provider: "codex",
      item: {
        type: "user_message",
        text: "Inspect",
        clientMessageId: "message",
        messageId: "message",
        queue,
      },
    },
  });
  expect(result.tail).toHaveLength(1);
  expect(result.tail[0]).toMatchObject({ id: "message", queue });
});
