import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ServiceItem } from "./index";

vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/components/sidebar/display-preferences/model", () => ({
  useSidebarMetaPreferences: vi.fn(),
}));
vi.mock("@/workspace-labels/chip", () => ({
  WorkspaceLabelChip: () => null,
  WORKSPACE_LABEL_CHIP_INSET: 0,
}));
vi.mock("@/hosts/host-badge", () => ({ HostBadge: () => null, HOST_BADGE_ICON_SIZE: 12 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values: { name: string }) => `${key}: ${values.name}`,
  }),
}));

const summary = { name: "preview", health: "healthy" } as const;
const unhealthy = { name: "preview", health: "unhealthy" } as const;

it("keeps the preview icon on the title line and restores the named service in Paseo", () => {
  vi.stubGlobal("React", React);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ServiceItem summary={summary} iconOnly />));
    expect(container.textContent).toBe("");
    const icon = container.querySelector('[data-testid="workspace-service"]');
    expect(icon?.getAttribute("aria-label")).toBe("workspace.status.serviceRunning: preview");
    expect(icon?.getBoundingClientRect().height).toBe(20);
    act(() => root.render(<ServiceItem summary={summary} />));
    expect(container.textContent).toBe("preview");
    act(() => root.render(<ServiceItem summary={unhealthy} iconOnly />));
    expect(container.querySelector('[data-testid="workspace-service-unhealthy"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
