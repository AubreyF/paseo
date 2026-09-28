import { afterEach, describe, expect, it } from "vitest";
import { useProviderSettingsStore } from "./provider-settings-store";

describe("provider settings store", () => {
  afterEach(() => {
    useProviderSettingsStore.setState({
      serverId: null,
      provider: null,
      overlayParentLayer: 0,
      visible: false,
      tab: "models",
    });
  });

  it("carries the opener layer without leaking it into later base-level opens", () => {
    useProviderSettingsStore.getState().open({
      serverId: "server-1",
      provider: "codex",
      overlayParentLayer: 30,
    });
    expect(useProviderSettingsStore.getState().overlayParentLayer).toBe(30);

    useProviderSettingsStore.getState().open({
      serverId: "server-1",
      provider: "claude",
    });
    expect(useProviderSettingsStore.getState().overlayParentLayer).toBe(0);
  });
  it("opens account profiles without changing the next model-settings entry point", () => {
    useProviderSettingsStore
      .getState()
      .open({ serverId: "server-1", provider: "codex", tab: "profiles" });
    expect(useProviderSettingsStore.getState().tab).toBe("profiles");
    useProviderSettingsStore.getState().close();
    useProviderSettingsStore.getState().open({ serverId: "server-1", provider: "codex" });
    expect(useProviderSettingsStore.getState().tab).toBe("models");
  });
});
