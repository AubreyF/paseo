import { readExecutionInstallation } from "@/execution-installation/policy";
import { EXECUTION_ENVIRONMENT_LABELS } from "@getpaseo/protocol/execution-installation";
import { useMemo } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { useLocalDaemonServerId, useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import { selectHostBadges, type HostBadgeModel } from "@/hosts/appearance";

/**
 * Every host's badge, resolved from the three things that decide one: the host registry, which
 * host is local, and each host's own appearance. `enabled` is the caller's own "off" — a surface
 * that has its own reason to hide badges passes false rather than filtering the result, so the
 * per-host setting stays the only thing that decides name vs icon vs hidden.
 */
export function useHostBadges({
  enabled,
}: {
  enabled: boolean;
}): ReadonlyMap<string, HostBadgeModel> {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const localDaemon = useLocalDaemonServerIdState();
  return useMemo(() => {
    const badges = new Map(
      selectHostBadges({
        hosts,
        localServerId,
        localHostResolutionPending: localDaemon.status !== "resolved",
        enabled,
      }),
    );
    for (const environment of readExecutionInstallation()?.environments ?? []) {
      if (!hosts.some((host) => host.serverId === environment.serverId)) continue;
      badges.set(environment.serverId, {
        serverId: environment.serverId,
        label: EXECUTION_ENVIRONMENT_LABELS[environment.kind],
        color: "none",
        showLabel: true,
      });
    }
    return badges;
  }, [hosts, localDaemon.status, localServerId, enabled]);
}
