// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useProjectExpansion } from "./use-project-expansion";

const mode = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/vorton-mode", () => ({ useVortonMode: () => mode.enabled }));

beforeEach(() => {
  mode.enabled = true;
  useSidebarCollapsedSectionsStore.setState({ collapsedProjectKeys: new Set(["second"]) });
});

describe.each([false, true])("project expansion with Vorton %s", (enabled) => {
  beforeEach(() => {
    mode.enabled = enabled;
  });

  it("restores saved choices after storage rehydration and a fresh mount", async () => {
    const { result, unmount } = renderHook(() => useProjectExpansion());
    expect([...result.current.collapsedProjectKeys]).toEqual(["second"]);
    act(() => {
      result.current.toggleProjectCollapsed("first");
    });
    act(() => {
      result.current.toggleProjectCollapsed("second");
    });
    expect([...useSidebarCollapsedSectionsStore.getState().collapsedProjectKeys]).toEqual([
      "first",
    ]);
    unmount();
    const { storage, name } = useSidebarCollapsedSectionsStore.persist.getOptions();
    if (!storage || !name) throw new Error("Missing sidebar persistence storage");
    const persisted = await storage.getItem(name);
    expect(persisted?.state.collapsedProjectKeys).toEqual(["first"]);
    useSidebarCollapsedSectionsStore.setState({ collapsedProjectKeys: new Set() });
    if (!persisted) throw new Error("Missing persisted sidebar choices");
    await storage.setItem(name, persisted);
    await useSidebarCollapsedSectionsStore.persist.rehydrate();
    const fresh = renderHook(() => useProjectExpansion());
    expect([...fresh.result.current.collapsedProjectKeys]).toEqual(["first"]);
  });

  it("keeps expansion choices when switching modes", () => {
    const { result, rerender } = renderHook(() => useProjectExpansion());
    act(() => {
      result.current.toggleProjectCollapsed("first");
    });
    mode.enabled = !enabled;
    rerender();
    expect([...result.current.collapsedProjectKeys]).toEqual(["second", "first"]);
  });
});
