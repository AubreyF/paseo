import { expect, test } from "../support/fixtures";
import { seedAgentProfiles } from "../support/helpers/agent-profiles";
import { setVortonMode } from "../support/helpers/app";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { expectWorkspaceAgentConfiguration } from "../support/helpers/command-center-agent-controls";

test("saved profile permissions do not hide the task mode in Vorton", async ({ page }) => {
  const seed = await seedAgentProfiles([
    {
      id: "permission-profile",
      name: "Supervisor profile",
      provider: "mock",
      model: "e2e-fast-stream",
      modeId: "approval-test",
    },
  ]);
  const seeded = await seedWorkspace({
    repoPrefix: "permission-accuracy-",
  });
  const agent = await seeded.client.createAgent({
    provider: "mock",
    cwd: seeded.repoPath,
    workspaceId: seeded.workspaceId,
    profileId: "permission-profile",
    modeId: "load-test",
  });
  const workspace = { ...seeded, agentId: agent.id, cwd: seeded.repoPath };
  try {
    await openAgentRoute(page, workspace);
    await expectComposerVisible(page);
    await setVortonMode(page, true);
    const permissions = page.getByTestId("preset-permission-trigger");
    await expect(permissions).toBeVisible();
    await expect(permissions).toHaveAttribute("aria-label", "Permissions (Load test)");
    await page.getByTestId("agent-preset-selector").click();
    await expect(page.getByText("Saved profile permissions", { exact: true })).toBeVisible();
    await expect(page.getByTestId("profile-customization-details")).toContainText("Approval test");
    await page.keyboard.press("Escape");
    await expect(permissions).toHaveAttribute("aria-label", "Permissions (Load test)");
    await permissions.click();
    await page
      .getByTestId("combobox-desktop-container")
      .last()
      .getByText("Approval test", { exact: true })
      .click();
    await expect(permissions).toHaveAttribute("aria-label", "Permissions (Approval test)");
    await expectWorkspaceAgentConfiguration(workspace, {
      id: workspace.agentId,
      provider: "mock",
      model: "e2e-fast-stream",
      modeId: "approval-test",
    });
    await setVortonMode(page, false);
    await expect(
      page.getByRole("button", { name: "Select agent mode (Approval test)" }),
    ).toBeVisible();
  } finally {
    await workspace.cleanup();
    await seed.restore();
  }
});
