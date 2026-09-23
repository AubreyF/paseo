import { create } from "zustand";

interface ProviderSettingsTarget {
  serverId: string;
  provider: string;
  overlayParentLayer?: number;
  tab?: "models" | "profiles";
}

interface ProviderSettingsStoreState {
  serverId: string | null;
  provider: string | null;
  overlayParentLayer: number;
  visible: boolean;
  tab: "models" | "profiles";
  open: (target: ProviderSettingsTarget) => void;
  close: () => void;
}

export const useProviderSettingsStore = create<ProviderSettingsStoreState>()((set) => ({
  serverId: null,
  provider: null,
  overlayParentLayer: 0,
  visible: false,
  tab: "models",
  open: ({ serverId, provider, overlayParentLayer = 0, tab = "models" }) => {
    set({ serverId, provider, overlayParentLayer, tab, visible: true });
  },
  close: () => {
    set({ visible: false });
  },
}));
