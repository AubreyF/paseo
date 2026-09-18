import { z } from "zod";
import { ContextAttachmentWireSchema } from "./agent-attachments.js";

export const QueueIdSchema = z.string().min(1).max(200);
export const QueueDeliverySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued") }),
  z.object({ status: z.literal("dispatching"), attemptId: QueueIdSchema, startedAt: z.string() }),
  z.object({
    status: z.literal("uncertain"),
    attemptId: QueueIdSchema,
    startedAt: z.string(),
    reason: z.string(),
  }),
  z.object({ status: z.literal("failed"), attemptId: QueueIdSchema, reason: z.string() }),
]);
export const QueueAttachmentSchema = z.object({
  kind: z.enum(["image", "file"]).optional(),
  id: QueueIdSchema,
  fileName: z.string().max(500),
  mimeType: z.string().max(200),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(25 * 1024 * 1024),
});
export const QueueContentSchema = z.object({
  text: z.string().max(200_000),
  context: z.array(ContextAttachmentWireSchema).max(32).optional(),
  attachments: z.array(QueueAttachmentSchema).max(32),
});
export const QueueItemSchema = QueueContentSchema.extend({
  id: QueueIdSchema,
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  delivery: QueueDeliverySchema,
  sendNow: z.object({ expectedTurnId: z.string().nullable() }).optional(),
});
export const QueueSnapshotSchema = z.object({
  agentId: QueueIdSchema,
  revision: z.number().int().nonnegative(),
  paused: z.boolean(),
  items: z.array(QueueItemSchema).max(100),
  deliveryError: z.string().max(4000).optional(),
});
export const QueueOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("send_now"),
    operationId: QueueIdSchema,
    messageId: QueueIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    expectedTurnId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("reorder"),
    operationId: QueueIdSchema,
    messageIds: z.array(QueueIdSchema).max(100),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("resolve"),
    operationId: QueueIdSchema,
    messageId: QueueIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    action: z.enum(["retry", "discard"]),
  }),
  QueueContentSchema.extend({
    kind: z.literal("enqueue"),
    operationId: QueueIdSchema,
    messageId: QueueIdSchema,
  }),
  QueueContentSchema.extend({
    kind: z.literal("edit"),
    operationId: QueueIdSchema,
    messageId: QueueIdSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("delete"),
    operationId: QueueIdSchema,
    messageId: QueueIdSchema,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("pause"),
    operationId: QueueIdSchema,
    paused: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
  }),
]);

export type QueueOperation = z.infer<typeof QueueOperationSchema>;
export type QueueSnapshot = z.infer<typeof QueueSnapshotSchema>;
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const QueueReadRequestSchema = z.object({
  type: z.literal("agent.queue.read.request"),
  agentId: QueueIdSchema,
  requestId: z.string(),
});
export const QueueMutateRequestSchema = z.object({
  type: z.literal("agent.queue.mutate.request"),
  agentId: QueueIdSchema,
  operation: QueueOperationSchema,
  requestId: z.string(),
});
export const QueueSubscribeRequestSchema = z.object({
  type: z.literal("agent.queue.subscribe.request"),
  agentId: QueueIdSchema,
  subscribed: z.boolean(),
  requestId: z.string(),
});
const QueueResultSchema = z.object({
  agentId: QueueIdSchema,
  requestId: z.string(),
  snapshot: QueueSnapshotSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export const QueueReadResponseSchema = z.object({
  type: z.literal("agent.queue.read.response"),
  payload: QueueResultSchema,
});
export const QueueMutateResponseSchema = z.object({
  type: z.literal("agent.queue.mutate.response"),
  payload: QueueResultSchema,
});
export const QueueSubscribeResponseSchema = z.object({
  type: z.literal("agent.queue.subscribe.response"),
  payload: QueueResultSchema,
});
export const QueueChangedSchema = z.object({
  type: z.literal("agent.queue.changed"),
  payload: QueueSnapshotSchema,
});

export type QueueAttachment = z.infer<typeof QueueContentSchema>["attachments"][number];

export const QueueAttachmentGetRequestSchema = z.object({
  type: z.literal("agent.queue.attachment.get.request"),
  agentId: QueueIdSchema,
  messageId: QueueIdSchema,
  attachmentId: QueueIdSchema,
  download: z.boolean().optional(),
  requestId: z.string(),
});
export const QueueAttachmentGetResponseSchema = z.object({
  type: z.literal("agent.queue.attachment.get.response"),
  payload: z.object({
    requestId: z.string(),
    file: z
      .object({
        attachment: QueueAttachmentSchema,
        cwd: z.string(),
        path: z.string(),
        downloadToken: z.string().optional(),
      })
      .nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  }),
});

export const QueuePresentationSchema = QueueContentSchema.omit({ text: true });
export type QueuePresentation = z.infer<typeof QueuePresentationSchema>;
export const QueueAcceptedMessageSchema = z.object({
  item: QueueItemSchema,
  turnId: z.string().nullable(),
  acceptedAt: z.string(),
  providerMessageId: z.string().optional(),
});
export type QueueAcceptedMessage = z.infer<typeof QueueAcceptedMessageSchema>;
