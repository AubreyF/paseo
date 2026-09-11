import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";

export interface ProjectTaskSummary {
  count: number;
  additions: number;
  deletions: number;
}

export function aggregateProjectTasks(
  projectViewKey: string,
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
): ProjectTaskSummary {
  const summary = { count: 0, additions: 0, deletions: 0 };
  for (const entry of entries.values()) {
    if (entry.projectViewKey !== projectViewKey) continue;
    summary.count += 1;
    if (!entry.diffStat) continue;
    summary.additions += entry.diffStat.additions;
    summary.deletions += entry.diffStat.deletions;
  }
  return summary;
}
