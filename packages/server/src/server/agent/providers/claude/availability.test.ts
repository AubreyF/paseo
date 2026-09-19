import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("checks the configured process on every availability probe instead of caching executable presence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-availability-"));
  directories.push(directory);
  const script = join(directory, "cli.cjs");
  const state = join(directory, "authentication.json");
  await writeFile(
    script,
    `
    const fs = require('node:fs');
    if (process.argv.slice(2).join(' ') !== 'auth status') process.exit(2);
    const status = JSON.parse(fs.readFileSync(process.env.TEST_AUTH_FILE, 'utf8'));
    process.stdout.write(JSON.stringify(status));
    process.exit(status.loggedIn ? 0 : 1);
  `,
  );
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    runtimeSettings: {
      command: { mode: "replace", argv: [process.execPath, script] },
      env: { TEST_AUTH_FILE: state },
    },
  });
  await writeFile(state, JSON.stringify({ loggedIn: false }));
  await expect(client.isAvailable()).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
  await writeFile(state, JSON.stringify({ loggedIn: true }));
  await expect(client.isAvailable()).resolves.toBe(true);
  await writeFile(state, JSON.stringify({ loggedIn: false }));
  await expect(client.isAvailable()).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
});

it("keeps an absent executable distinct from a signed-out executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-missing-"));
  directories.push(directory);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    runtimeSettings: { command: { mode: "replace", argv: [join(directory, "absent")] } },
  });
  await expect(client.isAvailable()).resolves.toBe(false);
});
