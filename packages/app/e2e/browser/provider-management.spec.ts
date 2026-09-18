import type { Locator } from "@playwright/test";
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
      });
      await page.goto(`/settings/hosts/${getServerId()}/providers`);
      await expect(
        page.getByTestId("host-page-providers-card").getByTestId("add-codex-account"),
      ).toHaveCount(0);
      for (const id of ["claude", "codex", "copilot", "opencode", "pi", "omp"]) {
        await expect(page.getByTestId(`provider-rename-${id}`)).toHaveCount(0);
        await expect(page.getByTestId(`provider-remove-${id}`)).toHaveCount(0);
      }
      await expect(page.getByTestId("catalog-provider-codex")).toContainText(
        "Add another Codex account to switch between accounts.",
      );
      const codexAdd = page.getByTestId("add-codex-account");
      const otherAdd = page.locator('[data-testid^="install-provider-"]').first();
      await expect(otherAdd).toBeVisible();
      const codexBox = await codexAdd.boundingBox();
      const otherBox = await otherAdd.boundingBox();
      expect(codexBox?.width).toBe(otherBox?.width);
      expect(codexBox?.height).toBe(otherBox?.height);
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
        const controls = [
          page.getByTestId(`provider-rename-${id}`),
          page.getByTestId(`provider-remove-${id}`),
          page.getByTestId(`provider-connect-${id}`),
          page.getByRole("switch", { name: `Enable ${name}`, exact: true }),
        ];
        const boxes: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>[] = [];
        for (const control of controls) {
          await expect(control).toBeVisible();
          const box = await control.boundingBox();
          if (!box) throw new Error("Missing provider control bounds");
          boxes.push(box);
        }
        const gaps = boxes
          .slice(1)
          .map((box, index) => box.x - boxes[index].x - boxes[index].width);
        expect(gaps[0]).toBeGreaterThan(0);
        for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 0);
        for (const action of ["rename", "remove", "connect"]) {
          await expect(page.getByTestId(`provider-${action}-${id}-outline`)).toHaveCSS(
            "border-top-style",
            "solid",
          );
        }
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
        await expect
          .poll(async () => {
            const { entries } = await client.getProvidersSnapshot();
            return entries.find((candidate) => candidate.provider === id)?.status ?? "loading";
          })
          .not.toBe("loading");
        const cancelDialog = page.waitForEvent("dialog").then((dialog) => dialog.dismiss());
        await Promise.all([page.getByTestId(`provider-remove-${id}`).click(), cancelDialog]);
        await expect(page.getByTestId(`provider-rename-${id}`)).toBeVisible();
        const confirmDialog = page.waitForEvent("dialog").then((dialog) => dialog.accept());
        await Promise.all([page.getByTestId(`provider-remove-${id}`).click(), confirmDialog]);
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
