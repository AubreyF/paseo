// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ enabled: false, touch: false, compact: false }));
vi.mock("@/constants/platform", () => ({ isWeb: true }));
vi.mock("@/vorton-mode", () => ({ useVortonMode: () => state.enabled }));
vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => state.compact,
}));
vi.mock("@/hooks/use-form-preferences", () => ({
  useFormPreferences: () => ({ preferences: { vortonMode: state.enabled } }),
}));
import { useVortonTouch } from "./vorton-touch";
import { useSidebarRowDensity } from "./components/sidebar/use-sidebar-row-density";
import { useSidebarActionSize } from "./components/sidebar/use-sidebar-action-size";
import { applyVortonWeb } from "./appearance/vorton-web.web";
let change: () => void;
const remove = vi.fn();
beforeEach(() => {
  state.enabled = false;
  state.touch = true;
  state.compact = false;
  remove.mockClear();
  window.matchMedia = vi.fn().mockImplementation(() => ({
    get matches() {
      return state.touch;
    },
    addEventListener: (_: string, listener: () => void) => {
      change = listener;
    },
    removeEventListener: remove,
  }));
});
describe("Vorton touch gate", () => {
  it("uses the same action size across desktop, compact and wide touch rows", () => {
    const { result, rerender } = renderHook(useSidebarActionSize);
    expect(result.current).toBeUndefined();
    state.enabled = true;
    state.compact = true;
    rerender();
    expect(result.current).toEqual({ width: 44, height: 44, minWidth: 44, minHeight: 44 });
    state.compact = false;
    rerender();
    expect(result.current).toEqual({ width: 44, height: 44, minWidth: 44, minHeight: 44 });
    state.touch = false;
    act(() => change());
    expect(result.current).toEqual({ width: 24, height: 24, minWidth: 24, minHeight: 24 });
    state.enabled = false;
    rerender();
    expect(result.current).toBeUndefined();
  });

  it("keeps Home Screen controls below the blur without changing browser or Paseo layout", () => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    const stop = applyVortonWeb(true, true);
    expect(getComputedStyle(root).paddingTop).toBe("16px");
    expect(getComputedStyle(root).boxSizing).toBe("border-box");
    stop();
    const off = applyVortonWeb(false, true);
    expect(getComputedStyle(root).paddingTop).toBe("");
    off();
    Object.defineProperty(navigator, "standalone", { configurable: true, value: false });
    const browser = applyVortonWeb(true, true);
    expect(getComputedStyle(root).paddingTop).toBe("");
    browser();
    expect(document.documentElement.hasAttribute("data-vorton-ios-standalone")).toBe(false);
    Reflect.deleteProperty(navigator, "standalone");
    userAgent.mockRestore();
    root.remove();
  });
  it("enlarges the row hitbox for touch and narrow windows while preserving desktop density", () => {
    state.enabled = true;
    state.compact = true;
    const { result, rerender, unmount } = renderHook(useSidebarRowDensity);
    expect(result.current?.minHeight).toBe(44);
    expect(result.current?.marginBottom).toBe(2);
    state.compact = false;
    rerender();
    expect(result.current?.minHeight).toBe(44);
    state.touch = false;
    act(() => change());
    expect(result.current?.minHeight).toBe(32);
    state.compact = true;
    rerender();
    expect(result.current?.minHeight).toBe(44);
    expect(result.current?.marginBottom).toBe(2);
    state.compact = false;
    rerender();
    expect(result.current?.minHeight).toBe(32);
    state.enabled = false;
    rerender();
    expect(result.current).toBeUndefined();
    unmount();
  });

  it("keeps row and action hitboxes at least 44 pixels in the compact sidebar", () => {
    const list = document.createElement("div");
    const row = document.createElement("button");
    const slot = document.createElement("div");
    slot.dataset.vortonActionSlot = "true";
    const action = document.createElement("button");
    slot.append(action);
    row.append(slot);
    list.append(row);
    const toolbar = document.createElement("button");
    document.body.append(list, toolbar);
    const stop = applyVortonWeb(true, true);
    expect(getComputedStyle(row).minHeight).toBe("44px");
    expect(getComputedStyle(slot).minHeight).toBe("44px");
    expect(getComputedStyle(action).minHeight).toBe("44px");
    expect(getComputedStyle(toolbar).minHeight).toBe("44px");
    stop();
    list.remove();
    toolbar.remove();
  });
  it("switches a mouse-only window into mobile controls when narrow and restores when widened", () => {
    state.touch = false;
    state.enabled = true;
    const { result, rerender, unmount } = renderHook(useVortonTouch);
    expect(result.current).toBe(false);
    state.compact = true;
    rerender();
    expect(result.current).toBe(true);
    state.enabled = false;
    rerender();
    expect(result.current).toBe(false);
    state.enabled = true;
    rerender();
    expect(result.current).toBe(true);
    state.compact = false;
    rerender();
    expect(result.current).toBe(false);
    unmount();
  });
  it("keeps the compact mode selector at its authored height while enlarging other actions", () => {
    const segment = document.createElement("button");
    segment.dataset.vortonCompactMode = "true";
    const action = document.createElement("button");
    document.body.append(segment, action);
    const stop = applyVortonWeb(true, true);
    expect(getComputedStyle(segment).minHeight).toBe("");
    expect(getComputedStyle(action).minHeight).toBe("44px");
    stop();
    segment.remove();
    action.remove();
  });
  it("keeps wide touch devices standard until explicitly enabled and restores on disable", () => {
    const { result, rerender, unmount } = renderHook(useVortonTouch);
    expect(result.current).toBe(false);
    state.enabled = true;
    rerender();
    expect(result.current).toBe(true);
    act(() => {
      state.touch = false;
      change();
    });
    expect(result.current).toBe(false);
    act(() => {
      state.touch = true;
      change();
    });
    expect(result.current).toBe(true);
    state.enabled = false;
    rerender();
    expect(result.current).toBe(false);
    unmount();
    expect(remove).toHaveBeenCalled();
  });
  it("removes web enhancements when toggled off without leaving global styles active", () => {
    const stop = applyVortonWeb(true, true);
    expect(document.documentElement.dataset.vortonTouch).toBe("true");
    expect(document.head.querySelectorAll("[data-vorton-styles]")).toHaveLength(1);
    stop();
    const off = applyVortonWeb(false, true);
    expect(document.documentElement.dataset.vortonMode).toBe("false");
    expect(document.documentElement.dataset.vortonTouch).toBe("false");
    off();
    expect(document.documentElement.hasAttribute("data-vorton-mode")).toBe(false);
    expect(document.head.querySelector("[data-vorton-styles]")).toBeNull();
  });
});
