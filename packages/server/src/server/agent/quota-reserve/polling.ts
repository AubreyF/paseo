import type { Logger } from "pino";
import type { AgentManager } from "../agent-manager.js";
import type {
  ProviderUsageService,
  ProviderUsageListResult,
} from "../../../services/quota-fetcher/service.js";

interface ReservePollingOptions {
  agentManager: AgentManager;
  usageService: ProviderUsageService;
  logger: Logger;
  intervalMs?: number;
  maxAgeMs?: number;
  now?: () => number;
}

export class QuotaReservePolling {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: ReservePollingOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => {
        if (!this.stopped) this.schedule(this.options.intervalMs ?? 30000);
      });
    }, delayMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const work = this.pollOnce().catch((error) => {
      this.options.logger.error({ err: error }, "Quota reserve observation failed");
    });
    this.inFlight = work;
    void work.finally(() => {
      if (this.inFlight === work) this.inFlight = null;
    });
    return work;
  }

  async readForAdmission(providerId: string) {
    if (this.stopped) throw new Error("Quota reserve observer is stopped.");
    const result = await this.options.usageService.listUsage({ forceRefresh: true });
    if (this.stopped) throw new Error("Quota reserve observer is stopped.");
    return observationForProvider(result, providerId, this.now(), this.options.maxAgeMs ?? 90000);
  }

  private async pollOnce(): Promise<void> {
    if ((await this.options.agentManager.listQuotaReserveTargets()).length === 0) return;
    let result: ProviderUsageListResult;
    try {
      result = await this.options.usageService.listUsage({ forceRefresh: true });
    } catch (error) {
      this.options.logger.warn({ err: error }, "Quota usage unavailable for reserve enforcement");
      result = { fetchedAt: new Date(this.now()).toISOString(), providers: [] };
    }
    const targets = await this.options.agentManager.listQuotaReserveTargets();
    if (this.stopped) return;
    const nowMs = this.now();
    await Promise.all(
      targets.map(async (agent) => {
        try {
          await this.options.agentManager.updateQuotaReserveState(agent.id, {
            trigger: "observation",
            observation: observationForProvider(
              result,
              agent.provider,
              nowMs,
              this.options.maxAgeMs ?? 90000,
            ),
          });
        } catch (error) {
          this.options.logger.error(
            { err: error, agentId: agent.id },
            "Quota reserve transition failed",
          );
        }
      }),
    );
  }
}

function observationForProvider(
  result: ProviderUsageListResult,
  providerId: string,
  nowMs: number,
  maxAgeMs: number,
) {
  const matches = result.providers.filter((usage) => usage.providerId === providerId);
  const usage = matches.length === 1 ? matches[0] : undefined;
  const available = usage?.status === "available";
  return {
    windows: available ? usage.windows : [],
    requiredWindowIds: usage?.reserveWindowIds ?? [],
    observedAtMs: available ? Date.parse(usage.fetchedAt ?? result.fetchedAt) : null,
    nowMs,
    maxAgeMs,
  };
}
