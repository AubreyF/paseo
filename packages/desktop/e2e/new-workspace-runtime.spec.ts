import { test as base } from "../../app/e2e/support/fixtures";
import {
  createWorkspaceInSelectedRuntime,
  expectRuntimeChoices,
  expectNewWorkspaceProviderSnapshotUsesProjectCwd,
  expectRuntimeSelected,
  expectWorkspaceOpenInRuntime,
  gotoNewWorkspaceForRuntime,
  seedGitProjectForRuntime,
  seedNonGitProjectForRuntime,
  selectRuntime,
  type SeededRuntimeProject,
} from "../../app/e2e/support/helpers/new-workspace-runtime";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
} from "../../app/e2e/support/helpers/new-workspace";
import { installDesktopRuntime } from "./support/runtime";

const test = base.extend<{
  runtimeProject: SeededRuntimeProject;
  nonGitRuntimeProject: SeededRuntimeProject;
}>({
  runtimeProject: async ({ browserName: _browserName }, provide) => {
    const project = await seedGitProjectForRuntime();
    try {
      await provide(project);
    } finally {
      await project.cleanup();
    }
  },
  nonGitRuntimeProject: async ({ browserName: _browserName }, provide) => {
    const project = await seedNonGitProjectForRuntime();
    try {
      await provide(project);
    } finally {
      await project.cleanup();
    }
  },
});

test("creates a workspace in a selected runtime", async ({ page, runtimeProject }) => {
  await test.step("choose the project and runtime", async () => {
    const cwdSnapshotRequest = expectNewWorkspaceProviderSnapshotUsesProjectCwd(
      page,
      runtimeProject.sourceDirectory,
    );
    await installDesktopRuntime(page, { serverId: getServerId(), manageBuiltInDaemon: false });
    await gotoNewWorkspaceForRuntime(page, runtimeProject);
    await cwdSnapshotRequest;
    await expectRuntimeChoices(page, ["Local", "Worktree", "Docker", "Fixture"]);
    await selectRuntime(page, "Fixture");
  });

  await test.step("create and open the workspace", async () => {
    await createWorkspaceInSelectedRuntime(page);
    await expectWorkspaceOpenInRuntime(page, runtimeProject, "fixture");
  });

  await test.step("remember the selected runtime", async () => {
    await openGlobalNewWorkspaceComposer(page);
    await selectNewWorkspaceProject(page, runtimeProject);
    await expectRuntimeSelected(page, "Fixture");
  });
});

test("hides Git runtimes for a non-Git project", async ({ page, nonGitRuntimeProject }) => {
  await installDesktopRuntime(page, { serverId: getServerId(), manageBuiltInDaemon: false });
  await gotoNewWorkspaceForRuntime(page, nonGitRuntimeProject);
  await expectRuntimeChoices(page, ["Local"]);
});
