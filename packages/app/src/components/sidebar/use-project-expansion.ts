import { useCallback, useMemo, useState } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useVortonMode } from "@/vorton-mode";

export function useProjectExpansion(projects: SidebarProjectEntry[]) {
  const vorton = useVortonMode();
  const saved = useSidebarCollapsedSectionsStore((state) => state.collapsedProjectKeys);
  const toggleSaved = useSidebarCollapsedSectionsStore((state) => state.toggleProjectCollapsed);
  // Session-only choices reset on client load without replacing Paseo's saved expansion state.
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const defaultCollapsed = projects.length > 1;
  const collapsedProjectKeys = useMemo(() => {
    if (!vorton) return saved;
    return new Set(
      projects
        .filter((project) => choices.get(project.viewKey) ?? defaultCollapsed)
        .map((project) => project.viewKey),
    );
  }, [vorton, saved, projects, choices, defaultCollapsed]);
  const toggleProjectCollapsed = useCallback(
    (key: string) => {
      if (!vorton) return toggleSaved(key);
      setChoices((previous) => {
        const next = new Map(previous);
        next.set(key, !(previous.get(key) ?? defaultCollapsed));
        return next;
      });
    },
    [vorton, toggleSaved, defaultCollapsed],
  );
  return { collapsedProjectKeys, toggleProjectCollapsed };
}
