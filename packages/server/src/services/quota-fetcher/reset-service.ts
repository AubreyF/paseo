import type { Logger } from "pino";
import type {
  ProviderResetResult,
  ProviderResetSnapshot,
  ProviderResetView,
} from "@getpaseo/protocol/provider-reset";
import type {
  AgentClient,
  ProviderResetCreditSession,
} from "../../server/agent/agent-sdk-types.js";
import { ResetCreditStore } from "./reset-store.js";

interface ResetServiceOptions {
  store: ResetCreditStore;
  getClient(providerId: string): Pick<AgentClient, "openResetCreditSession"> | null;
  refreshUsage(): Promise<void>;
  onResetApplied?(providerId: string, resetAt: string): Promise<void>;
  logger: Logger;
}

export class ProviderResetServiceError extends Error {
  constructor(
    readonly code: "unavailable" | "account_changed" | "no_credit",
    message: string,
  ) {
    super(message);
    this.name = "ProviderResetServiceError";
  }
}

/** Human-facing account operations only. This service never resumes agent work. */
export class ProviderResetService {
  constructor(private readonly options: ResetServiceOptions) {}

  read(providerId: string): Promise<ProviderResetView> {
    const client = this.options.getClient(providerId);
    if (client && !client.openResetCreditSession) {
      // Unsupported providers are normal in a mixed-provider picker. Their
      // read-only refresh must not turn another account's reset into a warning.
      return Promise.resolve({
        providerId,
        fetchedAt: new Date().toISOString(),
        snapshot: {
          status: "unsupported",
          reason: "This provider does not support reset credits.",
        },
        canRedeem: false,
        operation: null,
      });
    }
    return this.withSession(providerId, (session) => this.view(providerId, session));
  }

  prepare(providerId: string, accountId: string, creditId?: string): Promise<ProviderResetView> {
    return this.withSession(providerId, async (session) => {
      const snapshot = await this.requireAccount(session, accountId);
      const existing = await this.options.store.read(accountId);
      if (snapshot.availableCount === 0 && existing?.state !== "pending") {
        throw new ProviderResetServiceError(
          "no_credit",
          "This account has no available reset credits.",
        );
      }
      // An uncertain attempt must keep its original credit and idempotency key.
      if (existing?.state !== "pending") {
        if (creditId && !session.canSelectCredit) {
          throw new ProviderResetServiceError(
            "unavailable",
            "This provider cannot select a reset credit.",
          );
        }
        const credit = creditId
          ? snapshot.credits?.find((entry) => entry.id === creditId)
          : undefined;
        if (
          creditId &&
          (!credit ||
            credit.status !== "available" ||
            (credit.expiresAt !== null && credit.expiresAt <= Date.now() / 1000))
        ) {
          throw new ProviderResetServiceError(
            "no_credit",
            "The selected credit is no longer available. Go back and review the current credits.",
          );
        }
        await this.options.store.prepare({ accountId, providerId, creditId, credit });
      }
      return this.view(providerId, session, snapshot);
    });
  }

  confirm(
    providerId: string,
    accountId: string,
    operationId: string,
  ): Promise<ProviderResetResult> {
    return this.withSession(providerId, async (session) => {
      const snapshot = await this.requireAccount(session, accountId);
      const operation = await this.options.store.read(accountId);
      if (operation?.state === "prepared" && operation.creditId) {
        const credit = snapshot.credits?.find((entry) => entry.id === operation.creditId);
        if (
          !session.canSelectCredit ||
          !credit ||
          credit.status !== "available" ||
          (credit.expiresAt !== null && credit.expiresAt <= Date.now() / 1000)
        ) {
          throw new ProviderResetServiceError(
            "no_credit",
            "The selected credit is no longer available. Go back and review the current credits.",
          );
        }
      }
      const outcome = await this.options.store.confirm({ accountId, operationId }, (attempt) =>
        session.consume(attempt),
      );
      // A failed refresh must not disguise a known mutation result as a lost response.
      let view: ProviderResetView | null = null;
      let refreshError: string | null = null;
      try {
        view = await this.view(providerId, session);
      } catch {
        refreshError =
          "The reset result is saved, but account availability could not be refreshed.";
      }
      try {
        await this.options.refreshUsage();
      } catch {
        refreshError = "The reset result is saved, but usage could not be refreshed.";
      }
      if (outcome === "reset" || outcome === "alreadyRedeemed") {
        try {
          if (operation) {
            await this.options.onResetApplied?.(providerId, operation.createdAt);
          }
        } catch {
          refreshError =
            "The reset succeeded, but threads could not be unlocked. Retry this same reset operation; no additional credit will be spent.";
        }
      }
      return { outcome, view, refreshError };
    });
  }

  private async requireAccount(session: ProviderResetCreditSession, accountId: string) {
    const snapshot = await session.read();
    if (snapshot.status !== "available") {
      throw new ProviderResetServiceError("unavailable", snapshot.reason);
    }
    if (snapshot.accountId !== accountId) {
      throw new ProviderResetServiceError(
        "account_changed",
        "The signed-in account changed. Refresh and confirm the intended account.",
      );
    }
    if (!session.canRedeem) {
      throw new ProviderResetServiceError(
        "unavailable",
        "This provider has not verified support for reset redemption.",
      );
    }
    return snapshot;
  }

  private async view(
    providerId: string,
    session: ProviderResetCreditSession,
    supplied?: ProviderResetSnapshot,
  ): Promise<ProviderResetView> {
    const snapshot = supplied ?? (await session.read());
    const operation =
      snapshot.status === "available" ? await this.options.store.read(snapshot.accountId) : null;
    return {
      providerId,
      fetchedAt: new Date().toISOString(),
      snapshot,
      canRedeem: session.canRedeem && snapshot.status === "available",
      canSelectCredit: session.canSelectCredit === true,
      operation: operation
        ? {
            operationId: operation.idempotencyKey,
            credit: operation.credit ?? null,
            state: operation.state,
            outcome: operation.state === "completed" ? operation.outcome : null,
          }
        : null,
    };
  }

  private async withSession<T>(
    providerId: string,
    action: (session: ProviderResetCreditSession) => Promise<T>,
  ): Promise<T> {
    const client = this.options.getClient(providerId);
    if (!client?.openResetCreditSession) {
      throw new ProviderResetServiceError(
        "unavailable",
        "Reset credits are unavailable for this provider.",
      );
    }
    const session = await client.openResetCreditSession();
    try {
      return await action(session);
    } finally {
      try {
        await session.dispose();
      } catch {
        // Cleanup cannot change a persisted redemption outcome. Do not log account data.
        this.options.logger.warn("provider reset session cleanup failed");
      }
    }
  }
}
