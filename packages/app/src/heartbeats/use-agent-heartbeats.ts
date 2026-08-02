import { useMemo } from "react";
import { useSchedules } from "@/hooks/use-schedules";
import type { AggregatedSchedule } from "@/schedules/aggregated-schedules";
import { selectAgentHeartbeats, type AgentHeartbeatRow } from "./select";

const EMPTY_SCHEDULES: AggregatedSchedule[] = [];

/**
 * The active heartbeats aimed at one agent, over the schedule list the
 * Schedules screen already loads. Direct deletes update that cache
 * optimistically; heartbeats created elsewhere appear on its next refresh.
 */
export function useAgentHeartbeats(target: {
  serverId: string;
  agentId: string;
}): AgentHeartbeatRow[] {
  const { serverId, agentId } = target;
  const { loadState } = useSchedules();
  const schedules = loadState.status === "loaded" ? loadState.data : EMPTY_SCHEDULES;

  return useMemo(
    () => selectAgentHeartbeats({ schedules, target: { serverId, agentId }, now: Date.now() }),
    [schedules, serverId, agentId],
  );
}
