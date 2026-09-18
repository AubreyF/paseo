import { useEffect, useState } from "react";
import type { AgentGoalState } from "@getpaseo/protocol/agent-goals";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { goalElapsedAt } from "./goal-presentation";

/** Interpolate only a confirmed, connected active goal. Each provider observation
 * replaces the estimate; hidden retained panels do not keep a timer running. */
export function useGoalElapsed(state: AgentGoalState | undefined, connected: boolean) {
  const visible = useRetainedPanelActive();
  const [sample, setSample] = useState(() => ({ state, elapsed: 0 }));
  const ticking =
    connected && visible && state?.status === "ready" && state.goal?.status === "active";
  useEffect(() => {
    if (!ticking) return;
    const started = performance.now();
    const timer = setInterval(() => {
      setSample({ state, elapsed: (performance.now() - started) / 1000 });
    }, 1000);
    return () => clearInterval(timer);
  }, [state, ticking]);
  return goalElapsedAt(state, ticking, sample.state === state ? sample.elapsed : 0);
}
