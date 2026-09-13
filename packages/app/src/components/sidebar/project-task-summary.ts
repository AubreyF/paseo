import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

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
  const checkouts = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.projectViewKey !== projectViewKey) continue;
    summary.count += 1;
    if (!entry.diffStat) continue;
    // Several task rows can observe the same checkout's diff. Count its changes once per host.
    const directory = normalizeWorkspacePath(entry.workspaceDirectory);
    const checkout = JSON.stringify(
      directory ? [entry.serverId, directory] : [entry.serverId, null, entry.workspaceId],
    );
    if (checkouts.has(checkout)) continue;
    checkouts.add(checkout);
    summary.additions += entry.diffStat.additions;
    summary.deletions += entry.diffStat.deletions;
  }
  return summary;
}
