import { describe, expect, it } from "vitest";
import { mergeGoalHistory } from "./goal-history.js";
import { GoalSubmissionSchema } from "./agent-storage.js";

describe("goal submission history", () => {
  const submission = {
    text: "Finish this",
    clientMessageId: "client-1",
    timestamp: "2026-09-17T00:00:00Z",
  };
  it("restores a paused goal with no native turn from its persisted submission", () => {
    const stored = GoalSubmissionSchema.parse(JSON.parse(JSON.stringify(submission)));
    expect(mergeGoalHistory([], [stored], "codex")).toEqual([
      {
        type: "timeline",
        provider: "codex",
        timestamp: submission.timestamp,
        item: {
          type: "user_message",
          text: submission.text,
          clientMessageId: "client-1",
          intent: "goal",
        },
      },
    ]);
  });
  it("enriches a native context turn instead of duplicating it", () => {
    const events = mergeGoalHistory(
      [
        {
          type: "timeline",
          provider: "codex",
          timestamp: submission.timestamp,
          item: {
            type: "user_message",
            text: "Finish this with attachments",
            messageId: "native-1",
          },
        },
      ],
      [{ ...submission, messageId: "native-1" }],
      "codex",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      item: { text: "Finish this with attachments", intent: "goal" },
    });
  });
  it("does not relabel unrelated repeated text and preserves chronological placement", () => {
    const events = mergeGoalHistory(
      [
        {
          type: "timeline",
          provider: "codex",
          timestamp: "2026-09-17T00:01:00Z",
          item: { type: "user_message", text: submission.text, messageId: "unrelated" },
        },
      ],
      [submission],
      "codex",
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ item: { intent: "goal" } });
    expect(events[1]).toMatchObject({ item: { messageId: "unrelated" } });
  });
});
