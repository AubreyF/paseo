import { z } from "zod";

export const CodexAccountCreateRequestSchema = z.object({
  type: z.literal("provider.codex.create_account.request"),
  requestId: z.string(),
  creationId: z.string().uuid(),
  name: z.string().min(1).max(100),
});
export const CodexAccountCreateResponseSchema = z.object({
  type: z.literal("provider.codex.create_account.response"),
  payload: z.object({ requestId: z.string(), providerId: z.string(), name: z.string() }),
});

export const ProviderLoginStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }),
  z.object({ status: z.literal("starting"), attemptId: z.string() }),
  z.object({
    status: z.literal("waiting"),
    attemptId: z.string(),
    verificationUrl: z.string(),
    userCode: z.string(),
    expiresAt: z.string(),
  }),
  z.object({ status: z.literal("verifying"), attemptId: z.string() }),
  z.object({
    status: z.literal("succeeded"),
    attemptId: z.string(),
    accountLabel: z.string().nullable(),
  }),
  z.object({ status: z.literal("failed"), attemptId: z.string(), message: z.string() }),
  z.object({ status: z.literal("cancelled"), attemptId: z.string() }),
]);
export type ProviderLoginState = z.infer<typeof ProviderLoginStateSchema>;

export const ProviderLoginReadRequestSchema = z.object({
  type: z.literal("provider.login.read.request"),
  requestId: z.string(),
  providerId: z.string(),
});
export const ProviderLoginStartRequestSchema = z.object({
  type: z.literal("provider.login.start.request"),
  requestId: z.string(),
  providerId: z.string(),
});
export const ProviderLoginCancelRequestSchema = z.object({
  type: z.literal("provider.login.cancel.request"),
  requestId: z.string(),
  providerId: z.string(),
  attemptId: z.string(),
});
export const ProviderLoginReadResponseSchema = z.object({
  type: z.literal("provider.login.read.response"),
  payload: z.object({ requestId: z.string(), state: ProviderLoginStateSchema }),
});
export const ProviderLoginStartResponseSchema = z.object({
  type: z.literal("provider.login.start.response"),
  payload: z.object({ requestId: z.string(), state: ProviderLoginStateSchema }),
});
export const ProviderLoginCancelResponseSchema = z.object({
  type: z.literal("provider.login.cancel.response"),
  payload: z.object({ requestId: z.string(), state: ProviderLoginStateSchema }),
});
