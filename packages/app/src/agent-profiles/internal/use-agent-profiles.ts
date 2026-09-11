import { useCallback } from "react";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useSessionStore } from "@/stores/session-store";
import { supportsAgentProfiles } from "./capabilities";
import { useVortonMode } from "@/vorton-mode";
import { ensureDefaultProfile } from "./default-profile";

export interface UseAgentProfilesResult {
  /** `null` until the daemon config has arrived. */
  profiles: AgentProfile[] | null;
  /** False on daemons that predate agent profiles, or while disconnected. */
  isSupported: boolean;
  supportsLaunch: boolean;
  /** Writes the whole list; there is no per-profile RPC. */
  saveProfiles: (next: AgentProfile[]) => Promise<void>;
}

export function useAgentProfiles(serverId: string | null): UseAgentProfilesResult {
  const vorton = useVortonMode();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const supportsLaunch = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.agentProfileLaunch === true,
  );
  const isSupported = useSessionStore((state) => {
    return supportsAgentProfiles(state.sessions[serverId ?? ""]?.serverInfo?.features);
  });

  const saveProfiles = useCallback(
    async (next: AgentProfile[]) => {
      await patchConfig({
        agentProfiles: vorton ? ensureDefaultProfile(next) : next,
        ...(supportsLaunch ? { expectedAgentProfiles: config?.agentProfiles ?? [] } : {}),
      });
    },
    [patchConfig, config, supportsLaunch, vorton],
  );

  return {
    profiles: config ? (config.agentProfiles ?? []) : null,
    isSupported,
    supportsLaunch,
    saveProfiles,
  };
}
