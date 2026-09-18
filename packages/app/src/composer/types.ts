import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";

export type ImageAttachment = AttachmentMetadata;

export interface MessagePayload {
  text: string;
  goal?: import("@getpaseo/protocol/agent-goals").AgentGoalSetInput;
  attachments: ComposerAttachment[];
  cwd: string;
  forceSend?: boolean;
}

export interface TextReplacement {
  key: string;
  text: string;
}
