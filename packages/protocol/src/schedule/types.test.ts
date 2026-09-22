import { describe, expect, test } from "vitest";

import { ScheduleCadenceSchema, ScheduleRunSchema } from "./types.js";
import { validateWSOutboundMessage } from "../validation/ws-outbound.js";

test("workflow run identity survives wire validation and is additive for existing readers", () => {
  const run = {
    id: "run",
    scheduledFor: "2026-09-17T00:00:00Z",
    startedAt: "2026-09-17T00:00:00Z",
    endedAt: null,
    status: "running",
    agentId: null,
    output: null,
    error: null,
    workflowBinding: {
      account: { issuer: "openai", accountId: "fixture" },
      workflowId: "11111111-1111-4111-8111-111111111111",
    },
  };
  const envelope = (candidate: unknown) => ({
    type: "session",
    message: {
      type: "schedule/logs/response",
      payload: { requestId: "fixture", runs: [candidate], error: null },
    },
  });
  expect(ScheduleRunSchema.parse(run)).toEqual(run);
  expect(validateWSOutboundMessage(envelope(run))).toEqual({ success: true, data: envelope(run) });
  const { workflowBinding: _workflow, ...existingFields } = run;
  expect(ScheduleRunSchema.omit({ workflowBinding: true }).parse(run)).toEqual(existingFields);
  expect(
    validateWSOutboundMessage(
      envelope({ ...run, workflowBinding: { ...run.workflowBinding, workflowId: "invalid" } }),
    ).success,
  ).toBe(false);
});

describe("ScheduleCadenceSchema", () => {
  test("accepts existing UTC cron cadence without a time zone", () => {
    expect(ScheduleCadenceSchema.parse({ type: "cron", expression: "0 9 * * *" })).toEqual({
      type: "cron",
      expression: "0 9 * * *",
    });
  });

  test("accepts timezone-aware cron cadence", () => {
    expect(
      ScheduleCadenceSchema.parse({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      }),
    ).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });
});
