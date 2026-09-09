import { expect, test } from "vitest";
import { formatLocalEndpointSummary, formatWorkerActivity } from "./local-endpoint-summary";

test("worker count distinguishes unavailable, stale and zero", () => {
  const now = Date.parse("2026-09-09T06:00:00Z");
  const activity = { checkedAt: "2026-09-09T06:00:00Z", runningByProvider: { pi: 2 } };
  expect(formatWorkerActivity(undefined, "pi", now)).toBe("Worker activity unavailable");
  expect(formatWorkerActivity(activity, "pi", now)).toBe("2 running provider workers");
  expect(formatWorkerActivity(activity, "other", now)).toBe("0 running provider workers");
  expect(formatWorkerActivity(activity, "pi", now + 31000)).toBe("Worker activity stale");
});

test("local reachability is separate from quota and stale status is not current health", () => {
  const now = Date.parse("2026-09-09T06:00:00Z");
  expect(formatLocalEndpointSummary(undefined, now)).toBeNull();
  expect(
    formatLocalEndpointSummary({ status: "reachable", checkedAt: "2026-09-09T05:59:00Z" }, now),
  ).toBe("Local endpoint reachable");
  expect(
    formatLocalEndpointSummary({ status: "unreachable", checkedAt: "2026-09-09T05:59:00Z" }, now),
  ).toBe("Local endpoint unreachable");
  for (const checkedAt of ["invalid", "2026-09-09T05:50:00Z", "2026-09-10T00:00:00Z"]) {
    expect(formatLocalEndpointSummary({ status: "reachable", checkedAt }, now)).toBe(
      "Local endpoint status stale",
    );
  }
});
