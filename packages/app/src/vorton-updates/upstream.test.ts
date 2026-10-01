import { describe, expect, it } from "vitest";
import { upstreamSyncStatus } from "./upstream";

const record = {
  upstreamCommit: "a".repeat(40),
  mergeCommit: "b".repeat(40),
  mergedAt: "2026-09-19T00:30:45Z",
};
const mergedAt = Date.parse(record.mergedAt);
const week = 7 * 24 * 60 * 60 * 1000;

describe("upstream merge age", () => {
  it("highlights only after more than seven days", () => {
    expect(upstreamSyncStatus(record, mergedAt)).toEqual({ status: "recent", record });
    expect(upstreamSyncStatus(record, mergedAt + week)).toEqual({ status: "recent", record });
    expect(upstreamSyncStatus(record, mergedAt + week + 1)).toEqual({ status: "overdue", record });
  });

  it("keeps missing, invalid, and future provenance unknown", () => {
    expect(upstreamSyncStatus(null, mergedAt)).toEqual({ status: "unknown" });
    expect(upstreamSyncStatus({ ...record, mergedAt: "invalid" }, mergedAt)).toEqual({
      status: "unknown",
    });
    expect(upstreamSyncStatus({ ...record, upstreamCommit: "main" }, mergedAt)).toEqual({
      status: "unknown",
    });
    expect(upstreamSyncStatus(record, mergedAt - 1)).toEqual({ status: "unknown" });
  });
});
