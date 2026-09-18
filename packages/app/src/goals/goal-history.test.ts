import { expect, it } from "vitest";
import { createUserMessage, upsertUserMessage } from "@/types/stream";
import { goalIdentity } from "./goal-form-model";

it("keeps canonical goal intent when reconciling a local user message", () => {
  const local = createUserMessage({
    clientMessageId: "submission",
    text: "Finish the migration",
    timestamp: new Date(1000),
  });
  const canonical = createUserMessage({
    clientMessageId: "submission",
    messageId: "native",
    text: local.text,
    timestamp: new Date(1001),
    intent: "goal",
  });
  const [merged] = upsertUserMessage([local], canonical);
  expect(merged).toMatchObject({
    kind: "user_message",
    text: local.text,
    intent: "goal",
    messageId: "native",
  });
  expect(upsertUserMessage([merged!], { ...canonical, intent: undefined })[0]).toMatchObject({
    intent: "goal",
  });
});

it("detects another client's budget or status edit without conflicting on accounting updates", () => {
  const goal = {
    threadId: "thread",
    objective: "Work",
    status: "paused" as const,
    tokenBudget: 1000,
    tokensUsed: 10,
    timeUsedSeconds: 1,
    createdAt: 1,
    updatedAt: 2,
  };
  expect(goalIdentity({ ...goal, tokensUsed: 200, updatedAt: 3 })).toBe(goalIdentity(goal));
  expect(goalIdentity({ ...goal, tokenBudget: null })).not.toBe(goalIdentity(goal));
  expect(goalIdentity({ ...goal, status: "active" })).not.toBe(goalIdentity(goal));
});
