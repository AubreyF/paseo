import { useGlobalSearchParams } from "expo-router";
import { useEffect } from "react";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { useHosts, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { openHostOverview } from "@/navigation/settings-navigation";
import { useVortonMode } from "@/vorton-mode";

export function useVortonCompatibilityCallout() {
  const enabled = useVortonMode();
  const params = useGlobalSearchParams<{ serverId?: string }>();
  const selection = useActiveWorkspaceSelection();
  const hosts = useHosts();
  const serverId =
    params.serverId ?? selection?.serverId ?? (hosts.length === 1 ? hosts[0].serverId : "");
  const connected = useHostRuntimeIsConnected(serverId);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  const callouts = useSidebarCallouts();
  const unsupported =
    connected && serverInfo != null && serverInfo.features?.agentProfileLaunch !== true;

  useEffect(() => {
    if (!enabled || !unsupported) return;
    return callouts.show({
      id: "vorton-host-compatibility",
      title: "Vorton is not fully available",
      description:
        "This host does not support Vorton launch controls. Install and start a Vorton-capable Paseo daemon on this host, then reconnect, or select a host that supports Vorton. Updating the web interface alone is not enough.",
      priority: 80,
      dismissible: false,
      actions: [
        { label: "Host settings", onPress: () => openHostOverview(serverId), variant: "primary" },
      ],
      testID: "sidebar-vorton-compatibility",
    });
  }, [enabled, unsupported, serverId, callouts]);
}
