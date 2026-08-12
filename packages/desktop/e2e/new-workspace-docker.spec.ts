import { test as base } from "../../app/e2e/support/fixtures";
import { submitMessage } from "../../app/e2e/support/helpers/composer";
import {
  expectExplorerEntryVisible,
  openFileExplorer,
} from "../../app/e2e/support/helpers/file-explorer";
import { clickNewChat, clickNewTerminal } from "../../app/e2e/support/helpers/launcher";
import {
  cleanupDockerRuntimeProject,
  commitDockerWorkspaceChanges,
  createWorkspaceInSelectedRuntime,
  expectDockerHasNoHostAffordance,
  expectDockerScriptTerminalOpen,
  expectDockerTerminalText,
  expectDockerWorkspaceHasNoHostVisiblePath,
  expectRuntimeProviderUnavailable,
  expectWorkspaceOpenInRuntime,
  gotoNewWorkspaceForRuntime,
  openDockerUncommittedChanges,
  seedGitProjectWithDockerDecoys,
  selectRuntime,
  selectRuntimeProviderModel,
  type SeededDockerRuntimeProject,
} from "../../app/e2e/support/helpers/new-workspace-runtime";
import {
  focusTerminalSurface,
  getTerminalBufferText,
  typeInTerminal,
  expectTerminalSurfaceVisible,
  waitForTerminalAttached,
} from "../../app/e2e/support/helpers/terminal-perf";
import {
  closeWorkspaceScriptsMenu,
  openWorkspaceScriptsMenu,
  startWorkspaceScriptFromMenu,
} from "../../app/e2e/support/helpers/workspace-setup";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { installDesktopRuntime } from "./support/runtime";
import { expect } from "@playwright/test";

const test = base.extend<{ dockerProject: SeededDockerRuntimeProject }>({
  dockerProject: async ({ browserName: _browserName }, provide) => {
    const project = await seedGitProjectWithDockerDecoys();
    try {
      await provide(project);
    } finally {
      await cleanupDockerRuntimeProject(project);
    }
  },
});

const hostOpenTargets = [
  {
    id: "vscode",
    label: "VS Code",
    kind: "editor" as const,
    icon: { kind: "symbol" as const, name: "terminal" as const },
  },
  {
    id: "finder",
    label: "Finder",
    kind: "file-manager" as const,
    icon: { kind: "symbol" as const, name: "folder" as const },
  },
];

test.describe.configure({ timeout: 240_000 });

test("Docker workspace: probe, create, and work inside the container", async ({
  page,
  dockerProject,
}) => {
  await test.step("choose Docker and observe its provider catalog", async () => {
    await installDesktopRuntime(page, {
      serverId: getServerId(),
      manageBuiltInDaemon: false,
      editorTargets: hostOpenTargets,
    });
    await gotoNewWorkspaceForRuntime(page, dockerProject);
    await selectRuntime(page, "Docker");
    await expectRuntimeProviderUnavailable(page, "OpenCode");
    await selectRuntimeProviderModel(page, {
      provider: "Docker Fixture",
      model: "Fixture Model docker-fixture-model",
    });
  });

  await test.step("create the user workspace without host authority", async () => {
    await createWorkspaceInSelectedRuntime(page);
    await expectWorkspaceOpenInRuntime(page, dockerProject, "docker");
    await expectDockerHasNoHostAffordance(page);
    await expectDockerWorkspaceHasNoHostVisiblePath(dockerProject);
    await dockerProject.mutateHostAfterDockerCreation();
  });

  await test.step("create and edit files from a terminal rooted at /workspace", async () => {
    await clickNewTerminal(page);
    await expectTerminalSurfaceVisible(page);
    await waitForTerminalAttached(page);
    await focusTerminalSurface(page);
    await typeInTerminal(
      page,
      "pwd; cat host-mutation.txt; printf 'created in Docker\\n' > made-in-container.txt; printf 'changed in Docker\\n' > committed.txt\n",
    );
    await expectDockerTerminalText(page, "/workspace");
    await expectDockerTerminalText(page, "committed before Docker creation");
    expect(await getTerminalBufferText(page)).not.toContain("host changed after Docker creation");
  });

  await test.step("reflect terminal files and Git diff live", async () => {
    await openFileExplorer(page);
    await expectExplorerEntryVisible(page, "made-in-container.txt");
    await openDockerUncommittedChanges(page);
    await expect(page.getByText("made-in-container.txt", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("committed.txt", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("host-mutation.txt", { exact: true })).toHaveCount(0);
    await page.getByText("committed.txt", { exact: true }).first().click();
    await expect(page.getByText("changed in Docker", { exact: true })).toBeVisible();
    await commitDockerWorkspaceChanges(page);
    await page.getByRole("button", { name: "Close explorer" }).first().click();
  });

  await test.step("run the project workspace script inside Docker", async () => {
    await openWorkspaceScriptsMenu(page);
    await startWorkspaceScriptFromMenu(page, "docker-proof");
    await closeWorkspaceScriptsMenu(page);
    await expectDockerScriptTerminalOpen(page, "docker-proof");
    await openFileExplorer(page);
    await openDockerUncommittedChanges(page);
    await expect(
      page.getByText("workspace-script-output.txt", { exact: true }).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Close explorer" }).first().click();
  });

  await test.step("launch the selected fixture agent and show its edit in Git", async () => {
    await clickNewChat(page);
    await selectRuntimeProviderModel(page, {
      provider: "Docker Fixture",
      model: "Fixture Model docker-fixture-model",
    });
    await submitMessage(page, "agent-owned change");
    await expect(
      page.getByText("fixture completed: agent-owned change", { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Open explorer" }).first().click();
    await openDockerUncommittedChanges(page);
    await expect(page.getByText("stdio-agent-output.txt", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step("leave every host decoy untouched", async () => {
    await dockerProject.expectHostDecoysUntouched();
  });
});
