import { defineConfig, devices } from "@playwright/test";

const baseURL =
  process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_METRO_PORT ?? "8081"}`;
const dockerAcceptance = process.env.E2E_DOCKER_ACCEPTANCE === "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["**/*.spec.ts"],
  testIgnore: dockerAcceptance ? [] : ["**/new-workspace-docker.spec.ts"],
  globalSetup: "../app/e2e/support/global-setup.ts",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: process.env.E2E_RECORD_VIDEO === "1" ? "on" : "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
