import type { QueuePresentation } from "@getpaseo/protocol/message-queue";

export type QueueContext = NonNullable<QueuePresentation["context"]>[number];

export function presentQueueContext(context: QueueContext): { title: string; text: string } {
  switch (context.type) {
    case "text":
      return { title: context.title || "Attached text", text: context.text };
    case "review":
      return {
        title: "Review comments",
        text: context.comments
          .map(
            (comment) =>
              `${comment.filePath}:${comment.lineNumber}\n${comment.body}\n${comment.context.lines.map((line) => line.content).join("\n")}`,
          )
          .join("\n\n"),
      };
    case "github_pr":
    case "forge_change_request":
    case "github_issue":
    case "forge_issue":
      return {
        title: context.title,
        text: [context.url, context.body].filter(Boolean).join("\n\n"),
      };
  }
}
