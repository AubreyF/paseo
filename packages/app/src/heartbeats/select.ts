import type { AggregatedSchedule } from "@/schedules/aggregated-schedules";
import { deriveScheduleLifecycleState } from "@/schedules/schedule-derivation";
import { formatCadence, resolveScheduleTitle } from "@/utils/schedule-format";

/** The agent whose conversation the track is rendered above. */
export interface AgentHeartbeatTarget {
  serverId: string;
  agentId: string;
}

/** One heartbeat, reduced to what the track renders and routes with. */
export interface AgentHeartbeatRow {
  /** `${serverId}:${scheduleId}` — schedule ids are host-local, so identity is the pair. */
  key: string;
  serverId: string;
  scheduleId: string;
  title: string;
  cadence: string;
}

export interface SelectAgentHeartbeatsInput {
  schedules: readonly AggregatedSchedule[];
  target: AgentHeartbeatTarget;
  now: number;
}

const EMPTY_HEARTBEAT_ROWS: AgentHeartbeatRow[] = [];

export function agentHeartbeatKey(serverId: string, scheduleId: string): string {
  return `${serverId}:${scheduleId}`;
}

/**
 * The heartbeats still babysitting this agent. Paused, completed, and expired
 * heartbeats stay on the Schedules screen — they no longer represent ongoing
 * work, so they leave the track.
 */
export function selectAgentHeartbeats(input: SelectAgentHeartbeatsInput): AgentHeartbeatRow[] {
  const { schedules, target, now } = input;
  const rows = schedules
    .filter(
      (schedule) =>
        schedule.serverId === target.serverId &&
        schedule.target.type === "agent" &&
        schedule.target.agentId === target.agentId &&
        deriveScheduleLifecycleState(schedule, now) === "active",
    )
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map((schedule) => ({
      key: agentHeartbeatKey(schedule.serverId, schedule.id),
      serverId: schedule.serverId,
      scheduleId: schedule.id,
      title: resolveScheduleTitle(schedule),
      cadence: formatCadence(schedule.cadence),
    }));

  return rows.length > 0 ? rows : EMPTY_HEARTBEAT_ROWS;
}
