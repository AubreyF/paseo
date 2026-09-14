import { z } from "zod";
import type { QuotaObservation, QuotaWindow } from "@getpaseo/protocol/quota-governor";

const AccountSchema = z.object({ account: z.object({ type: z.string() }).nullish() });
const WindowSchema = z.object({
  usedPercent: z.number().finite().min(0).max(100),
  windowDurationMins: z.number().finite().positive(),
  resetsAt: z.number().int().nonnegative().nullable(),
});
const BucketSchema = z.object({
  limitId: z.string().min(1),
  primary: WindowSchema.nullable(),
  secondary: WindowSchema.nullable(),
});
const LimitsSchema = z.object({
  accountId: z.string().min(1).nullish(),
  rateLimits: BucketSchema.nullish(),
  rateLimitsByLimitId: z.record(z.string(), BucketSchema).nullish(),
});
const UsageSchema = z.object({
  summary: z.object({ lifetimeTokens: z.number().finite().nonnegative().nullish() }).nullish(),
  dailyUsageBuckets: z
    .array(
      z.object({
        startDate: z.string(),
        tokens: z.number().finite().nonnegative(),
      }),
    )
    .nullish(),
});

interface QuotaTransport {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  dispose(): Promise<void>;
}

/** Metadata only: this session never starts a thread, model turn, or account reset. */
export class CodexQuotaObservationSession {
  constructor(
    private readonly transport: QuotaTransport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(): Promise<QuotaObservation> {
    // Timestamp the beginning of collection so a slow read cannot refresh stale permission.
    const observedAt = this.now().toISOString();
    try {
      const { account } = AccountSchema.parse(await this.request("account/read"));
      if (!account) return { status: "unavailable", reason: "authentication_required" };
      if (account.type !== "chatgpt") return { status: "unavailable", reason: "unsupported" };
      const before = LimitsSchema.parse(await this.request("account/rateLimits/read"));
      if (!before.accountId) return { status: "unavailable", reason: "identity_unavailable" };
      // Token activity is diagnostic. Missing support cannot fabricate a strict meter.
      const usage = await this.readActivity();
      const after = LimitsSchema.parse(await this.request("account/rateLimits/read"));
      if (!after.accountId) return { status: "unavailable", reason: "identity_unavailable" };
      if (before.accountId !== after.accountId) {
        return { status: "unavailable", reason: "account_changed" };
      }
      const buckets =
        after.rateLimitsByLimitId ??
        (after.rateLimits ? { [after.rateLimits.limitId]: after.rateLimits } : {});
      const windows: QuotaWindow[] = [];
      for (const [bucketId, bucket] of Object.entries(buckets)) {
        if (bucketId !== bucket.limitId) {
          return { status: "unavailable", reason: "invalid_observation" };
        }
        if (bucket.primary === null && bucket.secondary === null) {
          return { status: "unavailable", reason: "windows_unavailable" };
        }
        for (const windowId of ["primary", "secondary"] as const) {
          const window = bucket[windowId];
          if (window === null) continue;
          windows.push({
            bucketId,
            windowId,
            durationMinutes: window.windowDurationMins,
            usedPercent: window.usedPercent,
            resetsAt:
              window.resetsAt === null ? null : new Date(window.resetsAt * 1000).toISOString(),
            semantics: "unknown",
          });
        }
      }
      if (windows.length === 0) return { status: "unavailable", reason: "windows_unavailable" };
      return {
        status: "available",
        account: { issuer: "openai", accountId: after.accountId },
        observedAt,
        windows,
        // Neither occupancy deltas nor token counts measure gross weekly quota points.
        consumptionMeters: [],
        ...(usage ? { tokenActivity: usage } : {}),
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof z.ZodError || error instanceof RangeError
            ? "invalid_observation"
            : "read_failed",
      };
    }
  }

  dispose(): Promise<void> {
    return this.transport.dispose();
  }

  private request(method: string): Promise<unknown> {
    return this.transport.request(method, {}, 10_000);
  }

  private async readActivity(): Promise<
    Extract<QuotaObservation, { status: "available" }>["tokenActivity"]
  > {
    try {
      const usage = UsageSchema.parse(await this.request("account/usage/read"));
      return {
        lifetimeTokens: usage.summary?.lifetimeTokens ?? null,
        dailyBuckets:
          usage.dailyUsageBuckets?.map((row) => ({ date: row.startDate, tokens: row.tokens })) ??
          null,
      };
    } catch {
      return undefined;
    }
  }
}
