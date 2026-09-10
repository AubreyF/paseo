import type { QuotaReserveConfig, QuotaReserveState } from "@getpaseo/protocol/quota-reserve";

type ReserveBlockReason = Exclude<QuotaReserveState, { kind: "ready" }>["reason"];

const BLOCK_MESSAGES: Record<ReserveBlockReason, string> = {
  cruise: "Cruise Reserve reached. Waiting for fresh quota recovery before continuing.",
  usage_unavailable:
    "Quota usage is unavailable. Waiting for a fresh observation before continuing.",
  redline: "Redline reached. Explicit continuation is required after quota recovery.",
  manual: "This task was manually stopped. Explicit continuation is required.",
  recovery_uncertain: "The previous turn's outcome is uncertain. Review it before continuing.",
};

export class QuotaReserveAdmissionError extends Error {
  constructor(readonly reason: ReserveBlockReason) {
    super(BLOCK_MESSAGES[reason]);
    this.name = "QuotaReserveAdmissionError";
  }
}

export class QuotaReserveControlError extends Error {
  constructor(
    readonly code: "conflict" | "archived" | "exhausted" | "active" | "no_policy" | "missing",
    message: string,
  ) {
    super(message);
    this.name = "QuotaReserveControlError";
  }
}

export function assertQuotaReserveAdmission(config: QuotaReserveConfig | undefined): void {
  if (config && config.state.kind !== "ready") {
    throw new QuotaReserveAdmissionError(config.state.reason);
  }
}
