import { useMemo } from "react";
import { useFetchQueries } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { providerResetQueryOptions } from "@/provider-usage/reset-query";
import type { AgentProfilePicker } from "./internal/use-agent-profile-picker";
import { presetMenuReady } from "./preset-menu-readiness";

export function usePresetData(
  serverId: string | null,
  profiles: AgentProfilePicker,
  active: boolean,
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsResets = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.providerResetManagement === true,
  );
  const clientGeneration = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.clientGeneration,
  );
  const enabled = Boolean(active && connected && client && supportsResets);
  const providers = useMemo(
    () => [...new Set(profiles.rows.map((row) => row.provider))],
    [profiles.rows],
  );
  const resets = useFetchQueries(
    providers.map((providerId) =>
      providerResetQueryOptions({
        serverId,
        providerId,
        clientGeneration,
        client,
        enabled,
        poll: true,
      }),
    ),
  );
  const { view } = useProviderUsage(serverId, {
    enabled: active,
    pollActivity: active,
  });
  return {
    view,
    ready: presetMenuReady({
      catalogLoading: Boolean(profiles.isLoadingStatus || profiles.isRefreshingStatus),
      usageLoading: view.kind === "loading",
      resets: resets.map((query) => ({
        enabled,
        hasData: query.data !== undefined,
        failed: query.isError && !query.isFetching,
      })),
    }),
  };
}
