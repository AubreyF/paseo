import { PassThrough, Readable } from "node:stream";

import { expect, test } from "vitest";

import { observeWorkspaceGit } from "../../../workspace-git-observation.js";
import type { BoundWorkspaceRuntime } from "../../index.js";
import type { WorkspaceRuntimeDriver } from "../../drivers/index.js";
import { createGitCommonObservationCoordinator } from "./integration.js";

test("selected runtime Git observation prunes paths ignored by that runtime checkout", async () => {
  let subscriptionInput: Parameters<BoundWorkspaceRuntime["files"]["subscribe"]>[0] | null = null;
  const runtime = {
    run: async () => ({
      stdin: new PassThrough(),
      stdout: Readable.from(["node_modules/\0packages/server/dist/\0"]),
      stderr: Readable.from([]),
      exited: Promise.resolve({ code: 0, signal: null }),
      kill: () => undefined,
    }),
    resolveCommand: async () => null,
    scriptTerminal: { kind: "direct-command", command: "/bin/sh", argsPrefix: ["-lc"] },
    files: {
      subscribe: async (input) => {
        subscriptionInput = input;
        return { unsubscribe: async () => undefined };
      },
    },
  } as unknown as BoundWorkspaceRuntime;
  const coordinator = createGitCommonObservationCoordinator();
  coordinator.bind(runtime, "workspace-1", {} as WorkspaceRuntimeDriver);

  const subscription = await observeWorkspaceGit(runtime, () => undefined);

  expect(subscriptionInput).toEqual({
    paths: ["."],
    recursive: true,
    ignoredPaths: ["node_modules", "packages/server/dist"],
  });
  await subscription.unsubscribe();
});
