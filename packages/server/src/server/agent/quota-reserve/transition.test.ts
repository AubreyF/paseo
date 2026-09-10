import { expect, it } from "vitest";
import { advanceQuotaReserve } from "./transition.js";
import type { QuotaReserveTransitionInput } from "./transition.js";

function transitionInput(): QuotaReserveTransitionInput {
  return {
    config: {
      policy: { kind: "protected", cruisePct: 15, redlinePct: 10 },
      state: { kind: "held", reason: "cruise", revision: 3, changedAt: new Date(0).toISOString() },
    },
    trigger: "observation",
    observation: {
      windows: [{ id: "weekly", label: "Weekly", remainingPct: 90 }],
      requiredWindowIds: ["weekly"],
      observedAtMs: 1000,
      nowMs: 1001,
      maxAgeMs: 30000,
    },
  };
}

it.each(["redline", "manual", "recovery_uncertain"] as const)(
  "does not clear a %s stop when usage recovers",
  (reason) => {
    const config = {
      policy: { kind: "protected" as const, cruisePct: 15, redlinePct: 10 },
      state: {
        kind: "stopped" as const,
        reason,
        revision: 2,
        changedAt: "2026-09-10T00:00:00.000Z",
      },
    };
    expect(
      advanceQuotaReserve({
        config,
        trigger: "observation",
        observation: {
          windows: [{ id: "weekly", label: "Weekly", remainingPct: 90 }],
          requiredWindowIds: ["weekly"],
          observedAtMs: 1000,
          nowMs: 1001,
          maxAgeMs: 30000,
        },
      }),
    ).toEqual(config);
  },
);

it("releases a policy hold once and leaves repeated observations unchanged", () => {
  const input = transitionInput();
  const released = advanceQuotaReserve(input);
  expect(released.state).toEqual({
    kind: "ready",
    revision: 4,
    changedAt: new Date(1001).toISOString(),
  });
  expect(advanceQuotaReserve({ ...input, config: released })).toBe(released);
});

it("keeps a policy hold at exactly Cruise Reserve", () => {
  const input = transitionInput();
  input.observation.windows = [{ id: "weekly", label: "Weekly", remainingPct: 15 }];
  expect(advanceQuotaReserve(input)).toBe(input.config);
});

it("escalates a graceful hold to a Redline stop", () => {
  const input = transitionInput();
  input.observation.windows = [{ id: "weekly", label: "Weekly", remainingPct: 10 }];
  expect(advanceQuotaReserve(input).state).toEqual({
    kind: "stopped",
    reason: "redline",
    revision: 4,
    changedAt: new Date(1001).toISOString(),
  });
});

it("manual stop replaces recovery eligibility even when usage is available", () => {
  const input = transitionInput();
  input.trigger = "manual_stop";
  const stopped = advanceQuotaReserve(input);
  expect(stopped.state).toEqual({
    kind: "stopped",
    reason: "manual",
    revision: 4,
    changedAt: new Date(1001).toISOString(),
  });
  expect(advanceQuotaReserve({ ...input, trigger: "observation", config: stopped })).toBe(stopped);
});

it("requires explicit resume to release a recovered Redline stop", () => {
  const input = transitionInput();
  input.config.state = {
    kind: "stopped",
    reason: "redline",
    revision: 3,
    changedAt: new Date(0).toISOString(),
  };
  input.trigger = "resume";
  expect(advanceQuotaReserve(input).state).toEqual({
    kind: "ready",
    revision: 4,
    changedAt: new Date(1001).toISOString(),
  });
});

it("does not release a Redline stop on explicit resume with stale usage", () => {
  const input = transitionInput();
  input.config.state = {
    kind: "stopped",
    reason: "redline",
    revision: 3,
    changedAt: new Date(0).toISOString(),
  };
  input.trigger = "resume";
  input.observation.observedAtMs = null;
  expect(advanceQuotaReserve(input)).toBe(input.config);
});

it("holds an ambiguous interrupted run for explicit review", () => {
  const input = transitionInput();
  input.trigger = "recovery_uncertain";
  const held = advanceQuotaReserve(input);
  expect(held.state).toEqual({
    kind: "stopped",
    reason: "recovery_uncertain",
    revision: 4,
    changedAt: new Date(1001).toISOString(),
  });
  expect(advanceQuotaReserve({ ...input, trigger: "observation", config: held })).toBe(held);
});
