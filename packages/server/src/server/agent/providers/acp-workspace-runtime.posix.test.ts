import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createWorkspaceRuntimeService } from "../../workspace-runtime/index.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ACPAgentSession } from "./acp-agent.js";

const posixDescribe = describe.runIf(process.platform !== "win32");

posixDescribe("ACP workspace terminal execution", () => {
  test("uses the selected workspace runtime for ACP-created terminal commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-acp-runtime-"));
    const cwd = path.join(root, "workspace");
    await mkdir(cwd);
    const runtimeIds = new Map<string, string>();
    const runtime = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "home"),
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId) => {
        runtimeIds.set(workspaceId, runtimeId);
      },
    });
    await runtime.create({
      workspaceId: "acp-workspace",
      runtimeId: "local",
      project: { id: "project", source: { kind: "host-directory", path: cwd } },
      placement: { kind: "existing" },
    });
    const session = new ACPAgentSession(
      { provider: "acp-test", cwd },
      {
        provider: "acp-test",
        logger: createTestLogger(),
        defaultCommand: ["unused"],
        defaultModes: [],
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: false,
          supportsImages: false,
          supportsFileAttachments: false,
          supportsAudioAttachments: false,
          supportsModes: false,
          supportsModels: false,
          supportsThinking: false,
          supportsMcp: false,
          supportsSlashCommands: false,
        },
        workspaceExecution: {
          run: (input) => runtime.run({ workspaceId: "acp-workspace", ...input }),
        },
      },
    );

    try {
      const terminal = await session.createTerminal({
        sessionId: "session",
        command: process.execPath,
        args: ["-e", "process.stdout.write(`${process.cwd()}|λ`);process.exit(12)"],
        cwd,
      });
      await expect(
        session.waitForTerminalExit({ sessionId: "session", terminalId: terminal.terminalId }),
      ).resolves.toEqual({ exitCode: 12, signal: null });
      await expect(
        session.terminalOutput({ sessionId: "session", terminalId: terminal.terminalId }),
      ).resolves.toMatchObject({ output: `${await realpath(cwd)}|λ` });
    } finally {
      await session.close();
      await runtime.destroy("acp-workspace");
      await rm(root, { recursive: true, force: true });
    }
  });
});
