import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import pino from "pino";
import { CodexQuotaProvider } from "./providers/codex.js";
import { ClaudeQuotaProvider } from "./providers/claude.js";

it("identifies the rejected Codex account and leaves credentials untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "account-recovery-"));
  const home = join(root, "account one's home");
  await mkdir(home);
  const file = join(home, "auth.json");
  const credentials = JSON.stringify({ tokens: { access_token: "expired", account_id: "one" } });
  await writeFile(file, credentials);
  try {
    const provider = new CodexQuotaProvider({
      logger: pino({ enabled: false }),
      codexHome: home,
      strictCodexHome: true,
      providerId: "one",
      fetch: async () => new Response(null, { status: 401 }),
    });
    const result = await provider.fetchUsage();
    expect(result.providerId).toBe("one");
    expect(result.status).toBe("unavailable");
    expect(result.authRecovery?.instructions).toContain(
      "account one'\"'\"'s home' codex login --device-auth",
    );
    expect(await readFile(file, "utf8")).toBe(credentials);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each([403, 429, 500])("does not diagnose Codex HTTP %s as disconnected", async (status) => {
  const home = await mkdtemp(join(tmpdir(), "account-recovery-"));
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "token" } }));
  try {
    const provider = new CodexQuotaProvider({
      logger: pino({ enabled: false }),
      codexHome: home,
      strictCodexHome: true,
      fetch: async () => new Response(null, { status }),
    });
    if (status === 403) expect((await provider.fetchUsage()).authRecovery).toBeUndefined();
    else await expect(provider.fetchUsage()).rejects.toThrow(`Codex usage API returned ${status}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("provides Claude recovery instructions after authentication rejection", async () => {
  const home = await mkdtemp(join(tmpdir(), "account-recovery-"));
  await writeFile(
    join(home, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "expired" } }),
  );
  try {
    const provider = new ClaudeQuotaProvider({
      logger: pino({ enabled: false }),
      claudeHome: home,
      platform: "linux",
      fetch: async () => new Response(null, { status: 401 }),
    });
    expect((await provider.fetchUsage()).authRecovery?.instructions).toContain("/login");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
