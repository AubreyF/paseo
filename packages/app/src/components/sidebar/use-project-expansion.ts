import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";

export function useProjectExpansion() {
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  return { collapsedProjectKeys, toggleProjectCollapsed };
}
