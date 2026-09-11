// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useProjectExpansion } from "./use-project-expansion";

const mode = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/vorton-mode", () => ({ useVortonMode: () => mode.enabled }));
const projects: SidebarProjectEntry[] = ["first", "second"].map((viewKey) => ({
  viewKey,
  projectName: viewKey,
  projectKind: "git",
  iconWorkingDir: "/repo",
  hosts: [],
  workspaces: [],
}));

beforeEach(() => {
  mode.enabled = true;
  useSidebarCollapsedSectionsStore.setState({ collapsedProjectKeys: new Set(["second"]) });
});

describe("project expansion", () => {
  it("collapses multiple projects on load and resets session choices on a fresh mount", () => {
    const { result, unmount } = renderHook(() => useProjectExpansion(projects));
    expect([...result.current.collapsedProjectKeys]).toEqual(["first", "second"]);
    act(() => {
      result.current.toggleProjectCollapsed("first");
    });
    expect([...result.current.collapsedProjectKeys]).toEqual(["second"]);
    unmount();
    const fresh = renderHook(() => useProjectExpansion(projects));
    expect([...fresh.result.current.collapsedProjectKeys]).toEqual(["first", "second"]);
  });
  it("opens one project by default, then closes untouched sections as more hosts load", () => {
    const { result, rerender } = renderHook(({ list }) => useProjectExpansion(list), {
      initialProps: { list: projects.slice(0, 1) },
    });
    expect(result.current.collapsedProjectKeys.size).toBe(0);
    rerender({ list: projects });
    expect(result.current.collapsedProjectKeys.size).toBe(2);
  });
  it("preserves explicit choices across list updates and mode changes without changing Paseo", () => {
    const { result, rerender } = renderHook(({ list }) => useProjectExpansion(list), {
      initialProps: { list: projects },
    });
    act(() => {
      result.current.toggleProjectCollapsed("second");
    });
    rerender({ list: [] });
    rerender({ list: projects });
    expect([...result.current.collapsedProjectKeys]).toEqual(["first"]);
    mode.enabled = false;
    rerender({ list: projects });
    expect([...result.current.collapsedProjectKeys]).toEqual(["second"]);
    act(() => {
      result.current.toggleProjectCollapsed("first");
    });
    expect([...useSidebarCollapsedSectionsStore.getState().collapsedProjectKeys]).toEqual([
      "second",
      "first",
    ]);
    mode.enabled = true;
    rerender({ list: projects });
    expect([...result.current.collapsedProjectKeys]).toEqual(["first"]);
  });
});
