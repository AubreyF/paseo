import { expect, test } from "../support/fixtures";
import {
  openModelPicker,
  seedAgentProfiles,
  seedModelProvider,
} from "../support/helpers/agent-profiles";
import { expectComposerVisible } from "../support/helpers/composer";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";
import { seedWorkspace } from "../support/helpers/seed-client";

test.setTimeout(120_000);

const PRIMARY = {
  id: "codex-primary-test",
  label: "Codex Primary",
  models: [
    {
      id: "primary-model",
      label: "Primary model",
      description: "Primary test model",
    },
  ],
};

const SECONDARY = {
  id: "codex-secondary-test",
  label: "Codex Secondary",
  models: [
    {
      id: "secondary-model",
      label: "Secondary model",
      description: "Secondary test model",
    },
  ],
};

test("model selector shows usage for each configured account and its profiles", async ({
  page,
}, testInfo) => {
  const primaryProvider = await seedModelProvider(PRIMARY);
  const secondaryProvider = await seedModelProvider(SECONDARY);
  const profiles = await seedAgentProfiles([
    {
      id: "agent_profile_primary_usage",
      name: PRIMARY.label,
      provider: PRIMARY.id,
    },
    {
      id: "agent_profile_secondary_usage",
      name: SECONDARY.label,
      provider: SECONDARY.id,
    },
  ]);
  const workspace = await seedWorkspace({
    repoPrefix: "provider-usage-selector-",
  });
  const usageFixture = await installProviderUsageFixture(page, [
    {
      fetchedAt: "2026-09-03T00:00:00.000Z",
      providers: [
        {
          providerId: PRIMARY.id,
          displayName: PRIMARY.label,
          status: "available",
          planLabel: "pro",
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              remainingPct: 84,
              resetsAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
            },
          ],
        },
        {
          providerId: SECONDARY.id,
          displayName: SECONDARY.label,
          status: "available",
          planLabel: "pro",
          windows: [{ id: "weekly", label: "Weekly", remainingPct: 17 }],
        },
      ],
    },
  ]);

  try {
    await gotoWorkspace(page, workspace.workspaceId);
    await clickNewChat(page);
    await expectComposerVisible(page);
    await openModelPicker(page);
    await usageFixture.waitForRequestCount(1);

    await expect(page.getByTestId(`model-provider-${PRIMARY.id}`)).toContainText(
      /84% left · resets \d+h/,
    );
    await expect(page.getByTestId(`model-provider-${SECONDARY.id}`)).toContainText("17% left");
    const primaryProfile = page.getByTestId("model-profile-row-agent_profile_primary_usage");
    const secondaryProfile = page.getByTestId("model-profile-row-agent_profile_secondary_usage");
    await expect(primaryProfile.getByText(PRIMARY.label, { exact: true })).toHaveCount(1);
    await expect(secondaryProfile.getByText(SECONDARY.label, { exact: true })).toHaveCount(1);
    await expect(primaryProfile).toContainText(/84% · \d+h/);
    await expect(secondaryProfile).toContainText("17%");

    await testInfo.attach("provider-usage-model-selector", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await workspace.cleanup();
    await profiles.restore();
    await secondaryProvider.restore();
    await primaryProvider.restore();
  }
});
