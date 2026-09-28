import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";

test("session discovery, resumed history and models stay inside each provider's configured account", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-accounts-"));
  try {
    const cwd = join(root, "project");
    await mkdir(cwd);
    for (const name of ["first", "second"]) {
      const configDir = join(root, name);
      const project = claudeProjectDirSync(cwd, { configDir });
      await mkdir(project, { recursive: true });
      await writeFile(join(configDir, "settings.json"), JSON.stringify({ model: `${name}-model` }));
      await writeFile(
        join(project, `${name}.jsonl`),
        JSON.stringify({
          type: "user",
          uuid: `${name}-message`,
          sessionId: name,
          cwd,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: `${name} account prompt` },
        }) + "\n",
      );
    }
    for (const name of ["first", "second"]) {
      const client = new ClaudeAgentClient({
        logger: createTestLogger(),
        resolveVersion: async () => "2.1.246",
        runtimeSettings: { env: { CLAUDE_CONFIG_DIR: join(root, name) } },
      });
      const catalog = await client.fetchCatalog({ cwd });
      expect(catalog.models.some((model) => model.id === `${name}-model`)).toBe(true);
      expect(
        catalog.models.some(
          (model) => model.id === `${name === "first" ? "second" : "first"}-model`,
        ),
      ).toBe(false);
      const sessions = await client.listImportableSessions({ cwd });
      expect(sessions.map((session) => session.providerHandleId)).toEqual([name]);
      const all = await client.listImportableSessions();
      expect(all.map((session) => session.providerHandleId)).toEqual([name]);
      const session = await client.resumeSession({
        provider: "claude",
        sessionId: name,
        metadata: { cwd },
      });
      try {
        const history = [];
        for await (const event of session.streamHistory()) history.push(event);
        expect(history).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "timeline",
              item: expect.objectContaining({
                type: "user_message",
                text: `${name} account prompt`,
              }),
            }),
          ]),
        );
      } finally {
        await session.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
