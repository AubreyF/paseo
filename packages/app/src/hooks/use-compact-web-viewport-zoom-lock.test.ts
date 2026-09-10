// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ vorton: false }));
vi.mock("@/constants/platform", () => ({ isWeb: true }));
vi.mock("@/vorton-mode", () => ({ useVortonMode: () => state.vorton }));
import { useCompactWebViewportZoomLock } from "./use-compact-web-viewport-zoom-lock";

describe("compact viewport zoom", () => {
  it("permits pinch zoom in Vorton and restores Paseo on the same mounted screen", () => {
    document.head.innerHTML =
      '<meta name="viewport" content="width=device-width, initial-scale=1">';
    const viewport = document.head.querySelector('meta[name="viewport"]');
    state.vorton = false;
    const { rerender, unmount } = renderHook(() => useCompactWebViewportZoomLock(true));
    expect(viewport?.getAttribute("content")).toContain("user-scalable=no");
    state.vorton = true;
    rerender();
    expect(viewport?.getAttribute("content")).not.toContain("user-scalable=no");
    expect(viewport?.getAttribute("content")).not.toContain("maximum-scale");
    expect(viewport?.getAttribute("content")).toContain("viewport-fit=cover");
    state.vorton = false;
    rerender();
    expect(viewport?.getAttribute("content")).toContain("user-scalable=no");
    unmount();
    expect(viewport?.getAttribute("content")).toBe("width=device-width, initial-scale=1");
    document.head.innerHTML = "";
  });
});
