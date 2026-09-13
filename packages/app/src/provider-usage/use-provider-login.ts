import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProviderLoginState } from "@getpaseo/protocol/provider-login";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { providerUsageQueryKey } from "./use-provider-usage";

export function useProviderLogin(serverId: string | null, providerId: string) {
  const client = useHostRuntimeClient(serverId ?? "");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const cache = useQueryClient();
  const key = useMemo(() => ["providerLogin", serverId, providerId], [serverId, providerId]);
  const action = useMutation({
    mutationFn: async (operation: "start" | "cancel") => {
      if (!client || !connected) throw new Error("Reconnect to the host and try again.");
      await cache.cancelQueries({ queryKey: key });
      if (operation === "start") return (await client.startProviderLogin(providerId)).state;
      const state = cache.getQueryData<ProviderLoginState>(key);
      if (!state || state.status === "idle")
        throw new Error("Refresh the sign-in status before cancelling.");
      return (await client.cancelProviderLogin(providerId, state.attemptId)).state;
    },
    onSuccess: (state) => cache.setQueryData(key, state),
  });
  const enabled = Boolean(client && connected && !action.isPending);
  const query = useFetchQuery({
    queryKey: key,
    queryFn: async () => {
      if (!client) throw new Error("Host unavailable");
      return (await client.readProviderLogin(providerId)).state;
    },
    enabled,
    refetchInterval: enabled ? 2000 : false,
    staleTimeMs: 0,
    dataShape: "value",
    gcTime: 0,
    retry: false,
  });
  const { mutate, reset } = action;
  const { refetch } = query;
  const start = useCallback(() => mutate("start"), [mutate]);
  const cancel = useCallback(() => mutate("cancel"), [mutate]);
  const refresh = useCallback(() => {
    reset();
    void refetch();
  }, [reset, refetch]);
  const completedId = query.data?.status === "succeeded" ? query.data.attemptId : null;
  useEffect(() => {
    if (!completedId) return;
    void cache.invalidateQueries({ queryKey: providerUsageQueryKey(serverId) });
    void cache.invalidateQueries({ queryKey: ["providerReset", serverId, providerId] });
  }, [cache, completedId, serverId, providerId]);
  return {
    state: query.data,
    connected,
    busy: action.isPending || query.isLoading,
    actionPending: action.isPending,
    readFailed: query.isError,
    actionFailed: action.isError,
    refreshing: query.isFetching,
    start,
    cancel,
    refresh,
  };
}
