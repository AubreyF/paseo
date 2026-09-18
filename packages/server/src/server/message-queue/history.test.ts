import { expect, it } from "vitest";
import { mergeQueueHistory } from "./history.js";
import type { QueueAcceptedMessage } from "@getpaseo/protocol/message-queue";

it("restores an accepted prompt with its stable ID and shared attachments", () => {
  const accepted: QueueAcceptedMessage = {
    turnId: "turn",
    acceptedAt: "2026-09-17T00:00:00Z",
    item: {
      id: "message",
      text: "Inspect",
      attachments: [
        {
          id: "upload-image",
          fileName: "image.png",
          mimeType: "image/png",
          size: 10,
          kind: "image",
        },
      ],
      revision: 1,
      createdAt: "2026-09-16T00:00:00Z",
      delivery: { status: "dispatching", attemptId: "attempt", startedAt: "2026-09-17T00:00:00Z" },
    },
  };
  expect(mergeQueueHistory([], [accepted], "codex")).toMatchObject([
    {
      type: "timeline",
      timestamp: accepted.acceptedAt,
      turnId: "turn",
      item: {
        type: "user_message",
        text: "Inspect",
        clientMessageId: "message",
        messageId: "message",
        queue: { attachments: accepted.item.attachments },
      },
    },
  ]);
});

it("joins a provider echo by turn identity without collapsing repeated text in another turn", () => {
  const submission: QueueAcceptedMessage = {
    acceptedAt: "2026-09-17T00:00:01Z",
    turnId: "queued-turn",
    item: {
      id: "queued",
      text: "again",
      attachments: [],
      revision: 1,
      createdAt: "2026-09-17T00:00:00Z",
      delivery: { status: "dispatching", attemptId: "attempt", startedAt: "2026-09-17T00:00:01Z" },
    },
  };
  const merged = mergeQueueHistory(
    [
      {
        type: "timeline",
        provider: "codex",
        turnId: "previous-turn",
        item: { type: "user_message", text: "again", messageId: "previous" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "queued-turn",
        item: { type: "user_message", text: "again", messageId: "native" },
      },
    ],
    [submission],
    "codex",
  );
  expect(merged).toHaveLength(2);
  expect(merged[0]).toMatchObject({ item: { messageId: "previous" } });
  expect(merged[1]).toMatchObject({
    item: { messageId: "native", clientMessageId: "queued", queue: { attachments: [] } },
  });
});

it("does not resurrect rewound prompts but retains metadata if the provider kept them", () => {
  const submission: QueueAcceptedMessage & { restoreMissing: boolean } = {
    restoreMissing: false,
    acceptedAt: "2026-09-17T00:00:01Z",
    turnId: "turn",
    providerMessageId: "native",
    item: {
      id: "queued",
      text: "Captured content",
      attachments: [],
      revision: 1,
      createdAt: "2026-09-17T00:00:00Z",
      delivery: { status: "dispatching", attemptId: "attempt", startedAt: "2026-09-17T00:00:01Z" },
    },
  };
  expect(mergeQueueHistory([], [submission], "codex")).toEqual([]);
  expect(
    mergeQueueHistory(
      [
        {
          type: "timeline",
          provider: "codex",
          turnId: "turn",
          item: { type: "user_message", text: "Native content", messageId: "native" },
        },
      ],
      [submission],
      "codex",
    ),
  ).toMatchObject([
    {
      item: { text: "Captured content", clientMessageId: "queued", messageId: "native" },
    },
  ]);
});
