import { z } from "zod";

export const QuotaReservePolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("off") }),
  z.object({
    kind: z.literal("protected"),
    cruisePct: z.number().min(0).max(100),
    redlinePct: z.number().min(0).max(100),
  }),
]);

export type QuotaReservePolicy = z.infer<typeof QuotaReservePolicySchema>;

export const QuotaReserveLaunchPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile") }),
  ...QuotaReservePolicySchema.options,
]);

export type QuotaReserveLaunchPolicy = z.infer<typeof QuotaReserveLaunchPolicySchema>;

export const QuotaReserveStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    revision: z.number().int().nonnegative(),
    changedAt: z.string(),
  }),
  z.object({
    kind: z.literal("held"),
    reason: z.enum(["cruise", "usage_unavailable"]),
    revision: z.number().int().nonnegative(),
    changedAt: z.string(),
  }),
  z.object({
    kind: z.literal("stopped"),
    reason: z.enum(["redline", "manual", "recovery_uncertain"]),
    revision: z.number().int().nonnegative(),
    changedAt: z.string(),
  }),
]);

export type QuotaReserveState = z.infer<typeof QuotaReserveStateSchema>;

export const QuotaReserveConfigSchema = z.object({
  policy: QuotaReservePolicySchema,
  state: QuotaReserveStateSchema,
});

export type QuotaReserveConfig = z.infer<typeof QuotaReserveConfigSchema>;

export const DEFAULT_QUOTA_RESERVE_POLICY: QuotaReservePolicy = {
  kind: "protected",
  cruisePct: 15,
  redlinePct: 10,
};

export class InvalidQuotaReservePolicyError extends Error {
  constructor() {
    super("Redline must be lower than Cruise Reserve.");
    this.name = "InvalidQuotaReservePolicyError";
  }
}

// Keep cross-field validation outside the structural wire schema for zod-aot.
export function parseQuotaReservePolicy(input: unknown): QuotaReservePolicy {
  const policy = QuotaReservePolicySchema.parse(input);
  if (policy.kind === "protected" && policy.redlinePct >= policy.cruisePct) {
    throw new InvalidQuotaReservePolicyError();
  }
  return policy;
}
