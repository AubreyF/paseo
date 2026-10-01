import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ClaudeLoginSession } from "./login.js";

test.each([
  "https://claude.ai/oauth/authorize?state=test",
  "https://claude.com/cai/oauth/authorize?state=test",
])("official CLI exchange verifies authentication for %s", async (verificationUrl) => {
  const scope = await mkdtemp(join(tmpdir(), "claude-login-"));
  const script = join(scope, "cli.cjs");
  await writeFile(
    script,
    `
    const fs = require('node:fs');
    const state = process.env.CLAUDE_CONFIG_DIR + '/signed-in';
    if (process.argv.includes('status')) {
      const loggedIn = fs.existsSync(state);
      console.log(JSON.stringify({ loggedIn })); process.exit(loggedIn ? 0 : 1);
    }
    process.stdout.write('Open ${verificationUrl}\\nPaste code here: ');
    process.stdin.once('data', code => {
      if (code.toString().trim() !== 'test-code#test-state') process.exit(1);
      fs.writeFileSync(state, 'yes'); process.exit(0);
    });
  `,
  );
  const session = new ClaudeLoginSession({
    executable: process.execPath,
    args: [script],
    scope,
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: scope } },
  });
  const results: boolean[] = [];
  try {
    expect(await session.start((success) => results.push(success))).toEqual({
      verificationUrl,
      userCode: "",
      inputRequired: true,
    });
    expect(results).toEqual([]);
    await expect(session.submitCode("bad\ninput")).rejects.toThrow();
    await session.submitCode("test-code#test-state");
    await expect.poll(() => results).toEqual([true]);
  } finally {
    await session.dispose();
    await rm(scope, { recursive: true, force: true });
  }
});

test("a successful CLI exit is insufficient when the account remains signed out", async () => {
  const scope = await mkdtemp(join(tmpdir(), "claude-login-"));
  const script = join(scope, "cli.cjs");
  await writeFile(
    script,
    `
    if (process.argv.includes('status')) {
      console.log(JSON.stringify({ loggedIn: false })); process.exit(1);
    }
    console.log('https://claude.ai/oauth/authorize?state=test');
    process.stdin.once('data', () => process.exit(0));
  `,
  );
  const session = new ClaudeLoginSession({
    executable: process.execPath,
    args: [script],
    scope,
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: scope } },
  });
  const results: boolean[] = [];
  try {
    await session.start((success) => results.push(success));
    await session.submitCode("test-code");
    await expect.poll(() => results).toEqual([false]);
  } finally {
    await session.dispose();
    await rm(scope, { recursive: true, force: true });
  }
});

test("cancellation stops the dedicated CLI and rejects late codes without reporting success", async () => {
  const scope = await mkdtemp(join(tmpdir(), "claude-login-"));
  const script = join(scope, "cli.cjs");
  await writeFile(
    script,
    `console.log('https://claude.ai/oauth/authorize?state=test'); process.stdin.resume();`,
  );
  const session = new ClaudeLoginSession({ executable: process.execPath, args: [script], scope });
  const results: boolean[] = [];
  try {
    await session.start((success) => results.push(success));
    await session.cancel();
    await expect(session.submitCode("late-code")).rejects.toThrow("no longer accepting");
    expect(results).toEqual([]);
  } finally {
    await session.dispose();
    await rm(scope, { recursive: true, force: true });
  }
});
