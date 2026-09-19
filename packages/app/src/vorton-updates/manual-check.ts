import { createStore } from "zustand/vanilla";
import type { VortonUpdate } from "./check";

export const MIN_CHECK_MS = 1000;
export const CHECK_FEEDBACK_MS = 4000;

// Shared across the sidebar and About so navigation cannot discard manual feedback.
export function createManualUpdateCheck() {
  const store = createStore<{
    phase: "idle" | "checking" | "success" | "error";
    result: VortonUpdate | null;
  }>(() => ({ phase: "idle", result: null }));
  let pending: Promise<void> | null = null;
  let clearFeedback: ReturnType<typeof setTimeout> | undefined;
  function check(run: () => Promise<VortonUpdate>) {
    if (pending) return pending;
    clearTimeout(clearFeedback);
    store.setState({ phase: "checking", result: null });
    pending = (async () => {
      const [result] = await Promise.all([
        Promise.resolve()
          .then(run)
          .then(
            (data) => data,
            () => null,
          ),
        new Promise<void>((resolve) => setTimeout(resolve, MIN_CHECK_MS)),
      ]);
      store.setState({ phase: result ? "success" : "error", result });
      clearFeedback = setTimeout(
        () => store.setState({ phase: "idle", result: null }),
        CHECK_FEEDBACK_MS,
      );
      pending = null;
    })();
    return pending;
  }
  return { store, check };
}

export const manualUpdateCheck = createManualUpdateCheck();
