import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  QuotaAccountSchema,
  QuotaObservationSchema,
  type QuotaObservation,
} from "@getpaseo/protocol/quota-governor";

const HOUR = 3_600_000;
const SampleSchema = z.object({
  at: z.number().finite(),
  used: z.number().finite().min(0).max(100),
  resetsAt: z.string().nullable(),
});
export const HourlyEstimateStateSchema = z
  .object({
    version: z.literal(1),
    account: QuotaAccountSchema,
    authenticationGeneration: z.string().min(1),
    bucketId: z.string().min(1),
    windowId: z.string().min(1),
    coverageStart: z.number().finite(),
    last: SampleSchema,
    intervals: z
      .array(
        z.object({
          start: z.number().finite(),
          end: z.number().finite(),
          points: z.number().finite().nonnegative(),
        }),
      )
      .max(4096),
  })
  .strict();
export type HourlyEstimateState = z.infer<typeof HourlyEstimateStateSchema>;

/** Keep an hour of observed account-wide increases. Unknown time never counts as zero. */
interface EstimateInput {
  state: HourlyEstimateState | null;
  observation: QuotaObservation;
  authenticationGeneration: string;
  bucketId: string;
  windowId: string;
  nowMs: number;
  maxObservationAgeSeconds: number;
}

function readSample(input: EstimateInput) {
  const observation = QuotaObservationSchema.parse(input.observation);
  if (observation.status !== "available")
    throw new Error("Hourly estimate requires authenticated telemetry.");
  const at = Date.parse(observation.observedAt);
  const maximumAge = input.maxObservationAgeSeconds * 1000;
  if (
    !Number.isFinite(input.nowMs) ||
    maximumAge <= 0 ||
    maximumAge > 120_000 ||
    !Number.isFinite(maximumAge) ||
    at > input.nowMs ||
    input.nowMs - at > maximumAge ||
    !input.authenticationGeneration.trim()
  )
    throw new Error("Hourly estimate requires fresh bound telemetry.");
  const matches = observation.windows.filter(
    (window) => window.bucketId === input.bucketId && window.windowId === input.windowId,
  );
  const window = matches[0];
  if (matches.length !== 1 || !window || window.durationMinutes !== 10080)
    throw new Error("Hourly estimate requires one weekly allowance window.");
  return {
    observation,
    maximumAge,
    sample: { at, used: window.usedPercent, resetsAt: window.resetsAt },
  };
}

/** Persist the returned state before using the associated estimate for admission. */
export function observeHourlyEstimate(input: EstimateInput): {
  state: HourlyEstimateState;
  observation: QuotaObservation;
} {
  const { observation, maximumAge, sample } = readSample(input);
  const { at } = sample;
  let state = input.state ? HourlyEstimateStateSchema.parse(input.state) : null;
  if (state && (at < state.last.at || input.nowMs < state.last.at))
    throw new Error("Hourly observation clock regressed.");
  const sameBinding =
    state &&
    isDeepStrictEqual(state.account, observation.account) &&
    state.authenticationGeneration === input.authenticationGeneration &&
    state.bucketId === input.bucketId &&
    state.windowId === input.windowId;
  if (!sameBinding) state = null;
  if (state && at === state.last.at && !isDeepStrictEqual(sample, state.last))
    throw new Error("Hourly observations conflict at the same timestamp.");
  if (
    !state ||
    at - state.last.at > maximumAge ||
    sample.resetsAt !== state.last.resetsAt ||
    sample.used < state.last.used
  ) {
    // An account/auth change, reset, refill, or missing interval invalidates the
    // rolling estimate until a complete fresh hour is observed. Retain no false zero.
    state = {
      version: 1,
      account: observation.account,
      authenticationGeneration: input.authenticationGeneration,
      bucketId: input.bucketId,
      windowId: input.windowId,
      coverageStart: at,
      last: sample,
      intervals: [],
    };
  } else if (at > state.last.at) {
    const points = sample.used - state.last.used;
    const intervals = state.intervals.filter((interval) => interval.end > input.nowMs - HOUR);
    if (points > 0) intervals.push({ start: state.last.at, end: at, points });
    state = { ...state, last: sample, intervals };
  }
  state = HourlyEstimateStateSchema.parse(state);
  const consumedPoints =
    state.coverageStart <= input.nowMs - HOUR
      ? state.intervals
          .filter((interval) => interval.end > input.nowMs - HOUR)
          .reduce((sum, interval) => sum + interval.points, 0)
      : null;
  return {
    state,
    observation: {
      ...observation,
      estimatedHourlyUsage: {
        bucketId: state.bucketId,
        windowId: state.windowId,
        authenticationGeneration: state.authenticationGeneration,
        coverageStart: new Date(state.coverageStart).toISOString(),
        observedAt: observation.observedAt,
        consumedPoints,
      },
    },
  };
}
