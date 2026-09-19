import { afterEach, describe, expect, it, vi } from "vitest";
import { createManualUpdateCheck } from "./manual-check";
import type { VortonUpdate } from "./check";
const current: VortonUpdate = {
  status: "current",
  latestCommit: "a".repeat(40),
  incomingCommits: 0,
};
afterEach(() => vi.useRealTimers());
describe("manual update feedback", () => {
  it("holds fast checks for one second, deduplicates clicks, and shows success for four seconds", async () => {
    vi.useFakeTimers();
    const check = createManualUpdateCheck();
    const run = vi.fn().mockResolvedValue(current);
    const pending = check.check(run);
    expect(check.check(run)).toBe(pending);
    await vi.advanceTimersByTimeAsync(999);
    expect(check.store.getState().phase).toBe("checking");
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(check.store.getState()).toEqual({ phase: "success", result: current });
    await vi.advanceTimersByTimeAsync(3999);
    expect(check.store.getState().phase).toBe("success");
    await vi.advanceTimersByTimeAsync(1);
    expect(check.store.getState().phase).toBe("idle");
  });
  it("never shows success while a slow check is unresolved or after it fails", async () => {
    vi.useFakeTimers();
    const check = createManualUpdateCheck();
    let reject!: (error: Error) => void;
    const pending = check.check(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(check.store.getState().phase).toBe("checking");
    reject(new Error("Network failed"));
    await pending;
    expect(check.store.getState()).toEqual({ phase: "error", result: null });
  });
  it("a new check cancels the previous feedback expiry", async () => {
    vi.useFakeTimers();
    const check = createManualUpdateCheck();
    void check.check(async () => current);
    await vi.advanceTimersByTimeAsync(4000);
    void check.check(async () => current);
    await vi.advanceTimersByTimeAsync(1000);
    expect(check.store.getState().phase).toBe("success");
    await vi.advanceTimersByTimeAsync(3999);
    expect(check.store.getState().phase).toBe("success");
  });
});
