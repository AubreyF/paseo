import type { QuotaObservation } from "@getpaseo/protocol/quota-governor";
import { QuotaObserverDisposedError } from "../../server/agent/agent-sdk-types.js";
import type {
  AgentClient,
  ProviderQuotaObservationSession,
} from "../../server/agent/agent-sdk-types.js";

interface ObservationServiceOptions {
  getClient(providerId: string): Pick<AgentClient, "openQuotaObservationSession"> | null;
  timeoutMs?: number;
}

/** Account metadata reads are bounded independently; no all-provider refresh barrier. */
export class ProviderQuotaObservationService {
  private readonly reads = new Map<string, Promise<QuotaObservation>>();
  private readonly failedCleanup = new Set<string>();
  private readonly timeoutMs: number;
  private stopped = false;

  constructor(private readonly options: ObservationServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? 45_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 90_000) {
      throw new Error("Quota observation timeout must be positive and at most 90 seconds.");
    }
  }

  read(providerId: string): Promise<QuotaObservation> {
    if (this.stopped || this.failedCleanup.has(providerId)) {
      return Promise.resolve({ status: "unavailable", reason: "read_failed" });
    }
    const existing = this.reads.get(providerId);
    if (existing) return existing;
    const pending = this.readOnce(providerId)
      .then(
        (result): QuotaObservation =>
          this.failedCleanup.has(providerId)
            ? { status: "unavailable", reason: "read_failed" }
            : result,
      )
      .finally(() => {
        if (this.reads.get(providerId) === pending) this.reads.delete(providerId);
      });
    this.reads.set(providerId, pending);
    return pending;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.reads.values());
  }

  private async readOnce(providerId: string): Promise<QuotaObservation> {
    let session: ProviderQuotaObservationSession | undefined;
    let expired = false;
    let openingStarted = false;
    let openingDisposed = false;
    try {
      const client = this.options.getClient(providerId);
      if (!client?.openQuotaObservationSession)
        return { status: "unavailable", reason: "unsupported" };
      const opening = client.openQuotaObservationSession();
      openingStarted = true;
      void opening.then(
        (late) =>
          expired
            ? this.close(providerId, late)
                .then(() => this.failedCleanup.delete(providerId))
                .catch(() => undefined)
            : undefined,
        (error) => {
          if (error instanceof QuotaObserverDisposedError) {
            openingDisposed = true;
            this.failedCleanup.delete(providerId);
          }
        },
      );
      const result = await bounded(
        (async () => {
          session = await opening;
          if (expired || this.stopped)
            throw new Error("Quota read expired before connection opened.");
          return session.read();
        })(),
        this.timeoutMs,
      );
      if (this.stopped) return { status: "unavailable", reason: "read_failed" };
      if (this.options.getClient(providerId) !== client) {
        return { status: "unavailable", reason: "account_changed" };
      }
      return result;
    } catch {
      return { status: "unavailable", reason: "read_failed" };
    } finally {
      expired = true;
      if (session) {
        try {
          await this.close(providerId, session);
        } catch {
          /* The provider remains fenced; a failed cleanup cannot spawn more observers. */
        }
      } else if (openingStarted && !openingDisposed) {
        // An unresolved open can still own a process. Only confirmed late disposal
        // permits another observer, even after the bounded read returns.
        this.failedCleanup.add(providerId);
      }
    }
  }

  private async close(providerId: string, session: ProviderQuotaObservationSession): Promise<void> {
    try {
      await bounded(session.dispose(), Math.min(this.timeoutMs, 5_000));
    } catch (error) {
      this.failedCleanup.add(providerId);
      throw error;
    }
  }
}

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Quota metadata request timed out.")), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
