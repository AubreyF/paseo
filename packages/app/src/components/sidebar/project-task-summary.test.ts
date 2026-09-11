import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { aggregateProjectTasks } from "./project-task-summary";

function entry(
  key: string,
  projectViewKey: string,
  diffStat: SidebarWorkspaceEntry["diffStat"],
): SidebarWorkspaceEntry {
  return {
    workspaceKey: key,
    projectViewKey,
    serverId: "server",
    workspaceId: key,
    projectName: projectViewKey,
    projectKind: "git",
    workspaceKind: "worktree",
    name: key,
    workspaceDirectory: "/repo",
    workspaceDirectoryLabel: "/repo",
    title: null,
    currentBranch: null,
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

describe("project task totals", () => {
  it("counts all open tasks including done, pinned and tasks without git changes", () => {
    const tasks = [
      entry("one", "a", { additions: 154, deletions: 44 }),
      { ...entry("two", "a", { additions: 154, deletions: 44 }), pinnedAt: "2026-09-10" },
      entry("three", "a", null),
      entry("other", "b", { additions: 999, deletions: 999 }),
    ];
    expect(
      aggregateProjectTasks("a", new Map(tasks.map((task) => [task.workspaceKey, task]))),
    ).toEqual({ count: 3, additions: 308, deletions: 88 });
  });
  it("shows zero totals for an empty project", () => {
    expect(aggregateProjectTasks("empty", new Map())).toEqual({
      count: 0,
      additions: 0,
      deletions: 0,
    });
  });
});
