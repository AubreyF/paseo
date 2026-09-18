import { z } from "zod";
import {
  ProviderResetAttemptSchema,
  ProviderResetOutcomeSchema,
  type ProviderResetAttempt,
  type ProviderResetOutcome,
  type ProviderResetSnapshot,
} from "@getpaseo/protocol/provider-reset";
import { CodexAppServerRpcError } from "./app-server-transport.js";

const AccountResponseSchema = z.object({
  account: z.object({ type: z.string(), email: z.string().nullish() }).nullish(),
});
const CreditSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  grantedAt: z.number().int(),
  expiresAt: z.number().int().nullish(),
  status: z.string(),
  resetType: z.string(),
});
const UsageResponseSchema = z.object({
  accountId: z.string().nullish(),
  rateLimitResetCredits: z
    .object({
      availableCount: z.number().int().nonnegative(),
      credits: z.array(CreditSchema).nullish(),
    })
    .nullish(),
});

interface AccountTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

export class CodexResetCreditError extends Error {
  constructor(
    readonly code: "account_changed" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CodexResetCreditError";
  }
}

/** A single configured app-server connection owns both identity and account operations. */
export class CodexResetCreditSession {
  constructor(
    private readonly transport: AccountTransport,
    readonly canRedeem = false,
    readonly canSelectCredit = false,
  ) {}

  async read(): Promise<ProviderResetSnapshot> {
    try {
      return await this.readAccountCredits();
    } catch (error) {
      if (error instanceof CodexAppServerRpcError && error.code === -32601) {
        return {
          status: "unsupported",
          reason: "Update this provider's Codex CLI to read reset credits.",
        };
      }
      throw error;
    }
  }

  private async readAccountCredits(): Promise<ProviderResetSnapshot> {
    const { account } = AccountResponseSchema.parse(
      await this.transport.request("account/read", {}),
    );
    if (!account) return { status: "unavailable", reason: "Sign in to this provider account." };
    if (account.type !== "chatgpt") {
      return { status: "unsupported", reason: "Reset credits require a ChatGPT account." };
    }
    const usage = UsageResponseSchema.parse(
      await this.transport.request("account/rateLimits/read", {}),
    );
    if (!usage.accountId) {
      return {
        status: "unavailable",
        reason: "The provider did not identify the account for this usage read.",
      };
    }
    const summary = usage.rateLimitResetCredits;
    if (!summary) {
      return {
        status: "unavailable",
        reason: "The provider did not report reset-credit availability.",
      };
    }
    const credits =
      summary.credits?.map((credit) => ({
        ...credit,
        title: credit.title ?? null,
        description: credit.description ?? null,
        expiresAt: credit.expiresAt ?? null,
      })) ?? null;
    return {
      status: "available",
      accountId: usage.accountId,
      accountLabel: account.email ?? null,
      availableCount: summary.availableCount,
      credits,
    };
  }

  async consume(input: ProviderResetAttempt): Promise<ProviderResetOutcome> {
    if (!this.canRedeem) {
      throw new CodexResetCreditError(
        "unavailable",
        "This provider has not verified support for reset redemption.",
      );
    }
    const attempt = ProviderResetAttemptSchema.parse(input);
    if (attempt.creditId && !this.canSelectCredit) {
      throw new CodexResetCreditError("unavailable", "This provider cannot select a reset credit.");
    }
    // The caller persists the logical attempt. A retry retains its key even
    // when a lost successful response has left the current credit count at zero.
    const snapshot = await this.read();
    if (snapshot.status !== "available") {
      throw new CodexResetCreditError("unavailable", snapshot.reason);
    }
    if (snapshot.accountId !== attempt.accountId) {
      throw new CodexResetCreditError(
        "account_changed",
        "The signed-in account changed. Review the account and confirm again.",
      );
    }
    const response = await this.transport.request("account/rateLimitResetCredit/consume", {
      idempotencyKey: attempt.idempotencyKey,
      ...(attempt.creditId ? { creditId: attempt.creditId } : {}),
    });
    return z.object({ outcome: ProviderResetOutcomeSchema }).parse(response).outcome;
  }

  dispose(): Promise<void> {
    return this.transport.dispose();
  }
}
