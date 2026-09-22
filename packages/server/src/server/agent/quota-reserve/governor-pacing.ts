import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { QuotaConsumptionUnitSchema } from "@getpaseo/protocol/quota-governor";

const Quantity = z.number().finite().nonnegative();
const Instant = z.number().int().nonnegative().max(8_640_000_000_000_000);

/** One meter and denominator. Never combine balances with different identities. */
export const PacingIdentitySchema = z.object({
  issuer: z.string().min(1),
  accountId: z.string().min(1),
  bucketId: z.string().min(1),
  meterId: z.string().min(1),
  revision: z.string().min(1),
  unit: QuotaConsumptionUnitSchema,
});

export const PacingConfigurationSchema = z.object({
  maximumUnitsPerHour: Quantity,
  burstUnits: Quantity,
  initialUnits: Quantity,
});
export type PacingConfiguration = z.infer<typeof PacingConfigurationSchema>;

/**
 * Produced by trusted accounting, not inferred from balance deltas or token activity.
 * The cumulative counter must retain its origin across provider quota resets.
 */
export const PacingAccountingSchema = z.object({
  identity: PacingIdentitySchema,
  counterOrigin: z.string().min(1),
  observedAt: Instant,
  cumulativeUnits: Quantity,
});
export type PacingAccounting = z.infer<typeof PacingAccountingSchema>;

export const PacingStateSchema = z.object({
  version: z.literal(1),
  configuration: PacingConfigurationSchema,
  accounting: PacingAccountingSchema,
  accruedThrough: Instant,
  // Negative balance is spending debt. Clamping it to zero would forgive usage.
  balanceUnits: z.number().finite(),
  unitsPerHour: Quantity,
  reservations: z.array(z.object({ id: z.string().min(1), units: Quantity, reservedAt: Instant })),
  settledReservationIds: z.array(z.string().min(1)),
});
export type PacingState = z.infer<typeof PacingStateSchema>;

export interface PacingEnvelope {
  identity: PacingAccounting["identity"];
  /** Headroom after safety floors and uncertainty, before this bucket's reservations. */
  availableUnits: number;
  horizon: { kind: "fixed_reset"; resetsAt: number } | { kind: "fixed_rate"; unitsPerHour: number };
}

interface AdvanceInput {
  state: PacingState | null;
  configuration: PacingConfiguration;
  accounting: PacingAccounting;
  nowMs: number;
  maxObservationAgeMs: number;
  envelopes: PacingEnvelope[];
}

/** Pure transition. Persist its result under the account lock before issuing a permit. */
export function advanceQuotaPacing(input: AdvanceInput): PacingState {
  const configuration = PacingConfigurationSchema.parse(input.configuration);
  const accounting = PacingAccountingSchema.parse(input.accounting);
  validatePacingInput({ input, configuration, accounting });
  const previous = input.state === null ? null : parseState(input.state);
  validateAccountingContinuity({ previous, accounting, nowMs: input.nowMs });
  const reservations = previous?.reservations ?? [];
  const reserved = sum(reservations.map((reservation) => reservation.units));
  let headroom = Infinity;
  let totalHeadroom = Infinity;
  let rate = configuration.maximumUnitsPerHour;
  for (const envelope of input.envelopes) {
    if (!isDeepStrictEqual(envelope.identity, accounting.identity)) {
      throw new Error("Pacing envelope uses a different accounting identity.");
    }
    const totalAvailable = Quantity.parse(envelope.availableUnits);
    totalHeadroom = Math.min(totalHeadroom, totalAvailable);
    const available = Math.max(0, totalAvailable - reserved);
    headroom = Math.min(headroom, available);
    if (envelope.horizon.kind === "fixed_reset") {
      const reset = Instant.parse(envelope.horizon.resetsAt);
      if (reset <= input.nowMs) throw new Error("Pacing reset requires fresh reconciliation.");
      rate = Math.min(rate, available / ((reset - input.nowMs) / 3_600_000));
    } else if (envelope.horizon.kind === "fixed_rate") {
      rate = Math.min(rate, Quantity.parse(envelope.horizon.unitsPerHour));
    } else {
      throw new Error("Pacing horizon semantics are unsupported.");
    }
  }
  const consumed = previous ? accounting.cumulativeUnits - previous.accounting.cumulativeUnits : 0;
  // Configuration changes take effect now. They cannot retroactively increase
  // earnings; a lower current rate also bounds the elapsed interval conservatively.
  const earned = previous
    ? (Math.min(previous.unitsPerHour, rate) * (input.nowMs - previous.accruedThrough)) / 3_600_000
    : 0;
  const priorBalance = previous?.balanceUnits ?? Math.min(configuration.initialUnits, headroom);
  // Apply the burst cap before expenditure. Otherwise an unobserved burst could
  // consume credit that should have spilled while the bucket was full.
  const balance =
    Math.min(
      configuration.burstUnits,
      previous?.configuration.burstUnits ?? configuration.burstUnits,
      priorBalance + earned,
    ) - consumed;
  return PacingStateSchema.parse({
    version: 1,
    configuration,
    accounting,
    accruedThrough: input.nowMs,
    balanceUnits: Math.min(balance, totalHeadroom),
    unitsPerHour: rate,
    reservations,
    settledReservationIds: previous?.settledReservationIds ?? [],
  });
}

/** Reserve once for a bounded slice. A held slice does not mutate the balance. */
export function reserveQuotaPacing(input: {
  state: PacingState;
  reservationId: string;
  units: number;
}): { kind: "reserved" | "settled" | "held"; state: PacingState } {
  const state = parseState(input.state);
  z.string().min(1).parse(input.reservationId);
  z.number().finite().positive().parse(input.units);
  if (state.settledReservationIds.includes(input.reservationId)) return { kind: "settled", state };
  const existing = state.reservations.find((entry) => entry.id === input.reservationId);
  const reserved = sum(state.reservations.map((entry) => entry.units));
  if (existing) {
    if (existing.units !== input.units) throw new Error("Pacing reservation amount changed.");
    return { kind: state.balanceUnits >= reserved ? "reserved" : "held", state };
  }
  if (state.balanceUnits - reserved < input.units) return { kind: "held", state };
  state.reservations.push({
    id: input.reservationId,
    units: input.units,
    reservedAt: state.accruedThrough,
  });
  return { kind: "reserved", state };
}

/**
 * Only call after trusted accounting proves this slice's charges are in the
 * retained cumulative counter. Process exit or a native interrupt ACK is not proof.
 */
export function settleQuotaPacing(input: {
  state: PacingState;
  reservationId: string;
  accountedAt: number;
}): PacingState {
  const state = parseState(input.state);
  if (state.settledReservationIds.includes(input.reservationId)) return state;
  const reservation = state.reservations.find((entry) => entry.id === input.reservationId);
  if (
    !reservation ||
    Instant.parse(input.accountedAt) < reservation.reservedAt ||
    input.accountedAt > state.accounting.observedAt
  ) {
    throw new Error("Pacing reservation accounting is unconfirmed.");
  }
  state.reservations = state.reservations.filter((entry) => entry.id !== input.reservationId);
  state.settledReservationIds.push(input.reservationId);
  return state;
}

function sum(values: number[]): number {
  return Quantity.parse(values.reduce((total, value) => total + value, 0));
}

function parseState(input: PacingState): PacingState {
  const state = PacingStateSchema.parse(input);
  const ids = [...state.reservations.map((entry) => entry.id), ...state.settledReservationIds];
  if (
    new Set(ids).size !== ids.length ||
    state.accounting.observedAt > state.accruedThrough ||
    state.configuration.initialUnits > state.configuration.burstUnits ||
    state.balanceUnits > state.configuration.burstUnits ||
    state.unitsPerHour > state.configuration.maximumUnitsPerHour ||
    state.reservations.some((entry) => entry.reservedAt > state.accruedThrough)
  ) {
    throw new Error("Invalid retained pacing state.");
  }
  return state;
}

function validatePacingInput({
  input,
  configuration,
  accounting,
}: {
  input: AdvanceInput;
  configuration: PacingConfiguration;
  accounting: PacingAccounting;
}): void {
  Instant.parse(input.nowMs);
  if (
    !Number.isFinite(input.maxObservationAgeMs) ||
    input.maxObservationAgeMs <= 0 ||
    input.maxObservationAgeMs > 120_000 ||
    accounting.observedAt > input.nowMs ||
    input.nowMs - accounting.observedAt > input.maxObservationAgeMs ||
    configuration.initialUnits > configuration.burstUnits ||
    input.envelopes.length === 0
  ) {
    throw new Error("Pacing requires fresh accounting and a bounded allowance envelope.");
  }
}

function validateAccountingContinuity({
  previous,
  accounting,
  nowMs,
}: {
  previous: PacingState | null;
  accounting: PacingAccounting;
  nowMs: number;
}): void {
  if (previous) {
    if (
      !isDeepStrictEqual(previous.accounting.identity, accounting.identity) ||
      previous.accounting.counterOrigin !== accounting.counterOrigin
    ) {
      throw new Error("Pacing accounting identity requires reconciliation.");
    }
    if (
      accounting.observedAt < previous.accounting.observedAt ||
      accounting.cumulativeUnits < previous.accounting.cumulativeUnits ||
      nowMs < previous.accruedThrough ||
      (accounting.observedAt === previous.accounting.observedAt &&
        !isDeepStrictEqual(accounting, previous.accounting))
    ) {
      throw new Error("Pacing accounting regressed or conflicts with retained evidence.");
    }
  }
}
