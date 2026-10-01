import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeQuotaProvider } from "./claude.js";
import { createProviderUsageFetchers } from "../manifest.js";

const homes: string[] = [];
const logger = pino({ level: "silent" });
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it("fetches each additional account's usage with its own credentials and label", async () => {
  const first = await mkdtemp(join(tmpdir(), "claude-quota-"));
  const second = await mkdtemp(join(tmpdir(), "claude-quota-"));
  homes.push(first, second);
  await writeFile(
    join(first, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "first-token" } }),
  );
  await writeFile(
    join(second, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "second-token" } }),
  );
  const tokens: Array<string | null> = [];
  const providers = createProviderUsageFetchers({
    logger,
    providers: {
      claude: { enabled: false },
      one: { extends: "claude", label: "Claude 1", env: { CLAUDE_CONFIG_DIR: first } },
      two: { extends: "claude", label: "Claude 2", env: { CLAUDE_CONFIG_DIR: second } },
      disabled: { extends: "claude", enabled: false },
    },
    fetch: async (_url, init) => {
      tokens.push(new Headers(init?.headers).get("Authorization"));
      return Response.json({ five_hour: { utilization: 12 }, seven_day: { utilization: 4 } });
    },
  });
  expect(providers.some((p) => p.providerId === "claude" || p.providerId === "disabled")).toBe(
    false,
  );
  for (const providerId of ["one", "two"]) {
    const provider = providers.find((p) => p.providerId === providerId);
    if (!provider) throw new Error("Missing account fetcher");
    expect(await provider.fetchUsage()).toMatchObject({
      providerId,
      displayName: provider.displayName,
    });
  }
  expect(tokens).toEqual(["Bearer first-token", "Bearer second-token"]);
  expect(providers.find((provider) => provider.providerId === "one")?.displayName).toBe("Claude 1");
  expect(providers.find((provider) => provider.providerId === "two")?.displayName).toBe("Claude 2");
});

it("never uses global credentials or the default macOS keychain for an additional account", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-quota-"));
  homes.push(home);
  const keychain = vi.fn(async () => ({ claudeAiOauth: { accessToken: "other-account" } }));
  const fetch = vi.fn();
  for (const claudeHome of [home, undefined]) {
    const provider = new ClaudeQuotaProvider({
      logger,
      providerId: "additional",
      claudeHome,
      strictClaudeHome: true,
      platform: "darwin",
      claudeKeychainReader: keychain,
      fetch,
    });
    await provider.fetchUsage();
  }
  expect(keychain).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
