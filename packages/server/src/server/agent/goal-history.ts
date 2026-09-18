import type { AgentStreamEvent, AgentProvider } from "./agent-sdk-types.js";
import type { GoalSubmission } from "./agent-storage.js";

// Native goal state has no submission author. Retain only accepted user goal
// submissions in the agent record, so tool-created goals never become fake users.
export function mergeGoalHistory(
  history: AgentStreamEvent[],
  submissions: GoalSubmission[],
  provider: AgentProvider,
): AgentStreamEvent[] {
  const events = [...history];
  const matched = new Set<number>();
  for (const submission of submissions) {
    const matchIndex = events.findIndex((event, index) => {
      if (matched.has(index) || event.type !== "timeline" || event.item.type !== "user_message")
        return false;
      return (
        event.item.clientMessageId === submission.clientMessageId ||
        (!!submission.messageId && event.item.messageId === submission.messageId)
      );
    });
    if (matchIndex >= 0) {
      const event = events[matchIndex];
      if (event.type === "timeline" && event.item.type === "user_message") {
        events[matchIndex] = {
          ...event,
          item: { ...event.item, intent: "goal", clientMessageId: submission.clientMessageId },
        };
        matched.add(matchIndex);
      }
      continue;
    }
    const event: AgentStreamEvent = {
      type: "timeline",
      provider,
      timestamp: submission.timestamp,
      item: {
        type: "user_message",
        text: submission.text,
        intent: "goal",
        clientMessageId: submission.clientMessageId,
      },
    };
    // Preserve provider ordering, including entries without timestamps.
    const after = events.findIndex(
      (entry) =>
        entry.type === "timeline" && entry.timestamp && entry.timestamp > submission.timestamp,
    );
    if (after < 0) events.push(event);
    else {
      events.splice(after, 0, event);
      const shifted = [...matched].map((index) => (index >= after ? index + 1 : index));
      matched.clear();
      for (const index of shifted) matched.add(index);
    }
  }
  return events;
}
