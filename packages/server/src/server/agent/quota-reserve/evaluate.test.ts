import { expect, it } from "vitest";
import { evaluateQuotaReserve } from "./evaluate.js";
import type { QuotaReserveEvaluationInput } from "./evaluate.js";

function observation(
  overrides: Partial<QuotaReserveEvaluationInput> = {},
): QuotaReserveEvaluationInput {
  return {
    policy: { kind: "protected", cruisePct: 15, redlinePct: 10 },
    windows: [
      { id: "session", label: "Session", remainingPct: 80 },
      { id: "weekly", label: "Weekly", remainingPct: 20 },
    ],
    requiredWindowIds: ["session", "weekly"],
    observedAtMs: 1000,
    nowMs: 1001,
    maxAgeMs: 30000,
    recovering: false,
    ...overrides,
  };
}

it("interrupts at Redline even when another required window is missing", () => {
  expect(
    evaluateQuotaReserve({
      policy: { kind: "protected", cruisePct: 15, redlinePct: 10 },
      windows: [{ id: "weekly", label: "Weekly", remainingPct: 10 }],
      requiredWindowIds: ["session", "weekly"],
      observedAtMs: 1000,
      nowMs: 1001,
      maxAgeMs: 30000,
      recovering: false,
    }),
  ).toEqual({ kind: "redline", windowId: "weekly", remainingPct: 10 });
});

it.each([
  { remainingPct: 9, recovering: false, kind: "redline" },
  { remainingPct: 10, recovering: true, kind: "redline" },
  { remainingPct: 10.1, recovering: false, kind: "cruise" },
  { remainingPct: 14.9, recovering: false, kind: "cruise" },
  { remainingPct: 15, recovering: true, kind: "cruise" },
])(
  "holds at $remainingPct percent when recovering=$recovering",
  ({ remainingPct, recovering, kind }) => {
    expect(
      evaluateQuotaReserve(
        observation({
          windows: [{ id: "weekly", label: "Weekly", remainingPct }],
          requiredWindowIds: ["weekly"],
          recovering,
        }),
      ),
    ).toEqual({ kind, windowId: "weekly", remainingPct });
  },
);

it.each([
  { remainingPct: 15, recovering: false },
  { remainingPct: 15.1, recovering: true },
])(
  "admits at $remainingPct percent when recovering=$recovering",
  ({ remainingPct, recovering }) => {
    expect(
      evaluateQuotaReserve(
        observation({
          windows: [{ id: "weekly", label: "Weekly", remainingPct }],
          requiredWindowIds: ["weekly"],
          recovering,
        }),
      ),
    ).toEqual({ kind: "ready" });
  },
);

it.each([null, 0, 1002, Number.NaN])(
  "does not act on unavailable or stale observations at %s",
  (observedAtMs) => {
    expect(
      evaluateQuotaReserve(
        observation({
          observedAtMs,
          maxAgeMs: 1000,
          windows: [{ id: "weekly", label: "Weekly", remainingPct: 0 }],
        }),
      ),
    ).toEqual({ kind: "unavailable" });
  },
);

it.each([null, undefined, -1, 101, Number.NaN])(
  "does not resume from an invalid remaining value %s",
  (remainingPct) => {
    expect(
      evaluateQuotaReserve(
        observation({
          windows: [{ id: "weekly", label: "Weekly", remainingPct }],
          requiredWindowIds: ["weekly"],
          recovering: true,
        }),
      ),
    ).toEqual({ kind: "unavailable" });
  },
);

it("waits for all required windows before resuming", () => {
  expect(
    evaluateQuotaReserve(
      observation({
        windows: [{ id: "weekly", label: "Weekly", remainingPct: 90 }],
        recovering: true,
      }),
    ),
  ).toEqual({ kind: "unavailable" });
});

it("does not infer capacity from an empty applicability set", () => {
  expect(evaluateQuotaReserve(observation({ requiredWindowIds: [] }))).toEqual({
    kind: "unavailable",
  });
});

it("ignores unrelated code-review allowance", () => {
  const input = observation();
  input.windows = [...input.windows, { id: "code_review", label: "Code review", remainingPct: 0 }];
  expect(evaluateQuotaReserve(input)).toEqual({ kind: "ready" });
});

it("does not pick one of two conflicting observations for the same window", () => {
  const input = observation();
  input.windows = [...input.windows, { id: "weekly", label: "Weekly", remainingPct: 90 }];
  expect(evaluateQuotaReserve(input)).toEqual({ kind: "unavailable" });
});

it("does not require observations when the policy is off", () => {
  expect(
    evaluateQuotaReserve(observation({ policy: { kind: "off" }, observedAtMs: null })),
  ).toEqual({ kind: "off" });
});

it("uses the task threshold instead of the default", () => {
  expect(
    evaluateQuotaReserve(
      observation({
        policy: { kind: "protected", cruisePct: 50, redlinePct: 10 },
      }),
    ),
  ).toEqual({ kind: "cruise", windowId: "weekly", remainingPct: 20 });
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
  "rejects invalid observation lifetime %s",
  (maxAgeMs) => {
    expect(evaluateQuotaReserve(observation({ maxAgeMs }))).toEqual({ kind: "unavailable" });
  },
);
