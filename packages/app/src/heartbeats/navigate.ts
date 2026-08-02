import { router, type Href } from "expo-router";
import { buildSchedulesRoute } from "@/utils/host-routes";

/**
 * Open one heartbeat on the Schedules screen. The route names the host as well
 * as the schedule, so a schedule id from one daemon cannot resolve against
 * another's.
 */
export function navigateToHeartbeat(target: { serverId: string; scheduleId: string }): void {
  router.push(buildSchedulesRoute(target) as Href);
}
