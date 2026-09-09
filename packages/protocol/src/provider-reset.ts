import { z } from "zod";

export const ProviderResetCreditSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  grantedAt: z.number().int(),
  expiresAt: z.number().int().nullable(),
  status: z.string(),
  resetType: z.string(),
});

export const ProviderResetSnapshotSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    accountId: z.string().min(1),
    accountLabel: z.string().nullable(),
    availableCount: z.number().int().nonnegative(),
    credits: z.array(ProviderResetCreditSchema).nullable(),
  }),
  z.object({ status: z.literal("unsupported"), reason: z.string() }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);

export const ProviderResetOutcomeSchema = z.enum([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);

export const ProviderResetAttemptSchema = z.object({
  accountId: z.string().min(1),
  idempotencyKey: z.string().uuid(),
  creditId: z.string().min(1).optional(),
});

export const ProviderResetOperationSchema = z.object({
  operationId: z.string().uuid(),
  state: z.enum(["prepared", "pending", "completed"]),
  outcome: ProviderResetOutcomeSchema.nullable(),
});

export const ProviderResetViewSchema = z.object({
  providerId: z.string(),
  fetchedAt: z.string(),
  snapshot: ProviderResetSnapshotSchema,
  canRedeem: z.boolean(),
  operation: ProviderResetOperationSchema.nullable(),
});

export const ProviderResetResultSchema = z.object({
  outcome: ProviderResetOutcomeSchema,
  view: ProviderResetViewSchema.nullable(),
  refreshError: z.string().nullable(),
});

export type ProviderResetSnapshot = z.infer<typeof ProviderResetSnapshotSchema>;
export type ProviderResetOutcome = z.infer<typeof ProviderResetOutcomeSchema>;
export type ProviderResetAttempt = z.infer<typeof ProviderResetAttemptSchema>;
export type ProviderResetView = z.infer<typeof ProviderResetViewSchema>;
export type ProviderResetResult = z.infer<typeof ProviderResetResultSchema>;

const ResetRequestFields = { providerId: z.string().min(1), requestId: z.string() };
export const ProviderResetReadRequestSchema = z.object({
  ...ResetRequestFields,
  type: z.literal("provider.reset.read.request"),
});
export const ProviderResetPrepareRequestSchema = z.object({
  ...ResetRequestFields,
  type: z.literal("provider.reset.prepare.request"),
  accountId: z.string().min(1),
});
export const ProviderResetConfirmRequestSchema = z.object({
  ...ResetRequestFields,
  type: z.literal("provider.reset.confirm.request"),
  accountId: z.string().min(1),
  operationId: z.string().uuid(),
});
export const ProviderResetReadResponseSchema = z.object({
  type: z.literal("provider.reset.read.response"),
  payload: z.object({ requestId: z.string(), view: ProviderResetViewSchema }),
});
export const ProviderResetPrepareResponseSchema = z.object({
  type: z.literal("provider.reset.prepare.response"),
  payload: z.object({ requestId: z.string(), view: ProviderResetViewSchema }),
});
export const ProviderResetConfirmResponseSchema = z.object({
  type: z.literal("provider.reset.confirm.response"),
  payload: ProviderResetResultSchema.extend({ requestId: z.string() }),
});
