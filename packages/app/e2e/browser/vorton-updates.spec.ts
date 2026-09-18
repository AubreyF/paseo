import { expect, test } from "../support/fixtures";

const API = "https://api.github.com/repos/AubreyF/paseo";
const latestCommit = "b".repeat(40);

test("Vorton checks main and opens a separate update draft without overwriting existing text", async ({
  page,
}) => {
  let requests = 0;
  await page.route(`${API}/**`, async (route) => {
    requests += 1;
    const body = route.request().url().includes("/commits/")
      ? { sha: latestCommit }
      : { status: "ahead", ahead_by: 3 };
    await route.fulfill({ json: body });
  });
  await page.addInitScript(() => {
    const key = "@paseo:create-agent-preferences";
    const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...preferences, vortonMode: false }));
    localStorage.setItem(
      "paseo-drafts",
      JSON.stringify({
        version: 5,
        state: {
          drafts: {
            "new-workspace": {
              input: { text: "Keep my existing draft", attachments: [] },
              lifecycle: "active",
              updatedAt: Date.now(),
              version: 1,
            },
          },
          createModalDraft: null,
        },
      }),
    );
  });
  await page.goto("/settings/about");
  await expect(page.getByText("This device", { exact: true })).toBeVisible();
  await expect(page.getByTestId("vorton-updates-section")).toHaveCount(0);
  expect(requests).toBe(0);

  await page.goto("/settings/general");
  await page.getByTestId("settings-vorton-mode").getByLabel("Vorton mode", { exact: true }).click();
  // Client navigation retains the selected mode; the initialization above only applies to document loads.
  await page.getByTestId("settings-sidebar").getByText("About", { exact: true }).click();
  await expect(page.getByTestId("vorton-update-status")).toHaveText(
    "3 new commits are available on main.",
  );
  await page.getByTestId("vorton-help-update").click();
  await expect(page).toHaveURL(/\/new\?.*draftId=/);
  const composer = page.getByRole("textbox", { name: "Message agent..." });
  await expect(composer).toHaveValue(/Help me update my Vorton installation/);
  await expect(composer).toHaveValue(/Preserve all local work/);
  await expect(composer).toHaveValue(/Ask for explicit approval before stopping or restarting/);
  await expect(composer).toHaveValue(new RegExp(latestCommit));
  const oldDraft = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("paseo-drafts") ?? "{}").state.drafts["new-workspace"].input
        .text,
  );
  expect(oldDraft).toBe("Keep my existing draft");
});

test("a failed update check exposes a retry and recovers", async ({ page }) => {
  let fail = true;
  await page.addInitScript(() => {
    const key = "@paseo:create-agent-preferences";
    localStorage.setItem(
      key,
      JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: true }),
    );
  });
  await page.route(`${API}/**`, async (route) => {
    if (fail) {
      await route.fulfill({ status: 403, json: { message: "Rate limit exceeded" } });
      return;
    }
    await route.fulfill({
      json: route.request().url().includes("/commits/")
        ? { sha: latestCommit }
        : { status: "behind", ahead_by: 0 },
    });
  });
  await page.goto("/settings/about");
  await expect(page.getByTestId("vorton-update-status")).toContainText(
    "GitHub limited update checks",
  );
  fail = false;
  await page.getByTestId("vorton-check-update").click();
  await expect(page.getByTestId("vorton-update-status")).toHaveText(
    "This interface was built ahead of main.",
  );
});
