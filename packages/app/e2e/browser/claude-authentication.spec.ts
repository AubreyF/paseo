import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";

const nodeRequire = createRequire(__filename);
const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const claudeBinary = join(dirname(nodeRequire.resolve(`${packageName}/package.json`)), binaryName);

for (const width of [1280, 402]) {
  test(`signed-out Claude and container instructions at ${width}px`, async ({ page }) => {
    const home = await mkdtemp(join(tmpdir(), "claude-browser-signout-"));
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "claude-signout" });
    try {
      await client.patchDaemonConfig({
        providers: {
          claude: {
            enabled: true,
            command: [claudeBinary],
            env: {
              HOME: home,
              CLAUDE_CONFIG_DIR: home,
              XDG_CONFIG_HOME: home,
              ANTHROPIC_API_KEY: "",
              ANTHROPIC_AUTH_TOKEN: "",
              CLAUDE_CODE_OAUTH_TOKEN: "",
              CLAUDE_CODE_USE_BEDROCK: "0",
              CLAUDE_CODE_USE_VERTEX: "0",
              CLAUDE_CODE_USE_FOUNDRY: "0",
            },
          },
        },
      });
      await client.refreshProvidersSnapshot({ providers: ["claude"] });
      await expect
        .poll(async () => {
          const { entries } = await client.getProvidersSnapshot();
          return entries.find((entry) => entry.provider === "claude");
        })
        .toMatchObject({ status: "error", error: expect.stringContaining("not signed in") });
      await page.setViewportSize({ width, height: 1000 });
      await gotoAppShell(page);
      await page.evaluate(() => {
        const key = "@paseo:create-agent-preferences";
        const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(key, JSON.stringify({ ...preferences, vortonMode: true }));
        const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
        if (!nonce) throw new Error("Missing test seed nonce");
        localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
      });
      await page.goto(`/settings/hosts/${getServerId()}/providers`);
      await page.getByRole("button", { name: "Claude provider details", exact: true }).click();
      const instructions = page.getByTestId("claude-sign-in-instructions");
      await expect(instructions).toBeVisible();
      await expect(page.getByText(/Claude Code is not signed in/).last()).toBeVisible();
      await expect(instructions).toContainText("docker compose exec --user paseo paseo bash");
      await expect(instructions).toContainText("claude auth login");
      await expect(instructions).toContainText("claude auth status");
      await page.evaluate(() => {
        const key = "@paseo:create-agent-preferences";
        const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(key, JSON.stringify({ ...preferences, vortonMode: false }));
        const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
        if (!nonce) throw new Error("Missing test seed nonce");
        localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
      });
      await page.reload();
      await page.getByRole("button", { name: "Claude provider details", exact: true }).click();
      await expect(page.getByRole("button", { name: "Add model", exact: true })).toBeVisible();
      await expect(instructions).toHaveCount(0);
    } finally {
      await client.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}
