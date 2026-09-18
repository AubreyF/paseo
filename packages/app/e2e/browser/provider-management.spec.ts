import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";

for (const width of [1280, 402]) {
  test(`Vorton provider management at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    const client = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "provider-management",
    });
    const createdIds: string[] = [];
    try {
      await page.setViewportSize({ width, height: 1000 });
      await gotoAppShell(page);
      await page.evaluate(() => {
        const key = "@paseo:create-agent-preferences";
        const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(key, JSON.stringify({ ...preferences, vortonMode: true }));
        const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
        if (!nonce) throw new Error("Missing isolated browser seed nonce");
        localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
      });
      await page.goto(`/settings/hosts/${getServerId()}/providers`);
      await expect(
        page.getByTestId("host-page-providers-card").getByTestId("add-codex-account"),
      ).toHaveCount(0);
      await page.getByTestId("provider-catalog-search").fill("CoDeX");
      for (const suffix of ["one", "two"]) {
        const name = `Search account ${width} ${suffix}`;
        await page
          .getByTestId("catalog-provider-codex")
          .getByRole("button", { name: "Add", exact: true })
          .click();
        await page.getByTestId("codex-account-name").fill(name);
        await page.getByTestId("codex-account-create").click();
        await expect(page.getByTestId("provider-login-panel")).toBeVisible();
        await page.getByTestId("codex-account-done").click();
        const entry = Object.entries((await client.getDaemonConfig()).config.providers).find(
          ([, provider]) => provider.label === name,
        );
        if (!entry) throw new Error(`Missing created provider ${name}`);
        const [id, provider] = entry;
        createdIds.push(id);
        await expect(page.getByTestId("catalog-provider-codex")).toBeVisible();
        await page.getByTestId(`provider-rename-${id}`).click();
        await page.getByTestId("provider-rename-dialog-input").fill(`Renamed ${name}`);
        await page.getByTestId("provider-rename-dialog-submit").click();
        await expect(page.getByTestId("provider-rename-dialog")).toBeHidden();
        await expect(
          page.getByRole("button", { name: `Renamed ${name} provider details`, exact: true }),
        ).toBeVisible();
        const renamed = (await client.getDaemonConfig()).config.providers[id];
        expect(renamed.label).toBe(`Renamed ${name}`);
        expect(renamed.env).toEqual(provider.env);
        page.once("dialog", (dialog) => void dialog.dismiss());
        await page.getByTestId(`provider-remove-${id}`).click();
        await expect(page.getByTestId(`provider-rename-${id}`)).toBeVisible();
        page.once("dialog", (dialog) => void dialog.accept());
        await page.getByTestId(`provider-remove-${id}`).click();
        await expect(page.getByTestId(`provider-rename-${id}`)).toHaveCount(0);
        expect((await client.getDaemonConfig()).config.providers[id]).toBeUndefined();
      }
      await page.evaluate(() => {
        const key = "@paseo:create-agent-preferences";
        const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(key, JSON.stringify({ ...preferences, vortonMode: false }));
      });
      await page.reload();
      await expect(page.getByTestId("host-page-providers-card")).toBeVisible();
      await expect(page.getByTestId("catalog-provider-codex")).toHaveCount(0);
      await expect(page.getByTestId("provider-rename-codex")).toHaveCount(0);
    } finally {
      await client.patchDaemonConfig({ removeProviders: createdIds });
      await client.close();
    }
  });
}
