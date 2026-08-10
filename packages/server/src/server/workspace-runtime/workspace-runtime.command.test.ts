import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import { createWorkspaceRuntimeService } from "./index.js";

const fixtureExecutable = fileURLToPath(
  new URL("../test-utils/fixtures/workspace-runtime-command-fixture.mjs", import.meta.url),
);
const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("a trusted registered command is selected and receives secret launch data off argv", async () => {
  const fixture = await createFixture("registered");
  await fixture.service.create({
    ...fixture.createInput,
    setup: [{ argv: ["/bin/sh", "-c", "printf setup > setup-purpose.txt"], env: {} }],
  });
  const setupLaunch = JSON.parse(
    await readFile(path.join(fixture.source, ".runtime-launch.json"), "utf8"),
  ) as { purpose: unknown };
  expect(setupLaunch.purpose).toEqual({ kind: "setup" });
  const secret = "secret-shaped-workload-value";
  const process = await fixture.service.run({
    workspaceId: fixture.workspaceId,
    argv: [
      processExecPath(),
      "-e",
      "require('fs').writeFileSync('workload-secret.txt', process.env.SECRET_TOKEN)",
    ],
    env: { SECRET_TOKEN: secret },
    purpose: { kind: "workspace-script", script: "secure-envelope-contract" },
  });
  process.stdin.end();
  await expect(process.exited).resolves.toEqual({ code: 0, signal: null });
  expect(await readFile(path.join(fixture.source, "workload-secret.txt"), "utf8")).toBe(secret);
  const launch = JSON.parse(
    await readFile(path.join(fixture.source, ".runtime-launch.json"), "utf8"),
  ) as { argv: string[]; purpose: unknown };
  expect(JSON.stringify(launch.argv)).not.toContain(secret);
  expect(launch.purpose).toEqual({
    kind: "workspace-script",
    script: "secure-envelope-contract",
  });

  await expect(
    fixture.service.create({
      ...fixture.createInput,
      workspaceId: "unregistered",
      runtimeId: "nope",
    }),
  ).rejects.toThrow("Workspace runtime is not registered: nope");
  await fixture.service.destroy(fixture.workspaceId);
});

test("run admission racing pause cannot leave an unregistered workload running", async () => {
  const fixture = await createFixture("race", true);
  await fixture.service.create(fixture.createInput);
  await writeFile(path.join(fixture.barrierDirectory, "block-next-inspect"), "block");

  const runPromise = fixture.service.run({
    workspaceId: fixture.workspaceId,
    argv: [processExecPath(), "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    env: {},
    purpose: { kind: "workspace-script", script: "pause-race-contract" },
  });
  await vi.waitFor(() =>
    expect(existsSync(path.join(fixture.barrierDirectory, "inspect-entered"))).toBe(true),
  );
  const pausePromise = fixture.service.pause(fixture.workspaceId);
  await writeFile(path.join(fixture.barrierDirectory, "release-inspect"), "release");

  const workload = await runPromise;
  workload.stdin.end();
  await pausePromise;
  await expect(workload.exited).resolves.toMatchObject({ code: null });
  await expect(
    fixture.service.run({
      workspaceId: fixture.workspaceId,
      argv: ["/bin/true"],
      env: {},
      purpose: { kind: "workspace-script", script: "paused-admission-contract" },
    }),
  ).rejects.toThrow(`Workspace runtime is paused: ${fixture.workspaceId}`);
  await fixture.service.resume(fixture.workspaceId);
  await fixture.service.destroy(fixture.workspaceId);
}, 15_000);

test("an existing runtime selection cannot be switched before target driver dispatch", async () => {
  const fixture = await createFixture("immutable-selection");
  await fixture.service.create({ ...fixture.createInput, runtimeId: "local" });

  await expect(fixture.service.create(fixture.createInput)).rejects.toThrow(
    `Workspace runtime is already selected as local: ${fixture.workspaceId}`,
  );
  expect(await readdir(fixture.stateDirectory)).toEqual([]);

  await fixture.service.destroy(fixture.workspaceId);
});

async function createFixture(name: string, withBarrier = false) {
  const root = await mkdtemp(path.join(tmpdir(), `paseo-command-runtime-${name}-`));
  cleanupRoots.push(root);
  const source = path.join(root, "source");
  const stateDirectory = path.join(root, "state");
  const barrierDirectory = path.join(root, "barrier");
  await Promise.all([mkdir(source), mkdir(stateDirectory), mkdir(barrierDirectory)]);
  const runtimeIds = new Map<string, string>();
  const workspaceId = `${name}-workspace`;
  const service = createWorkspaceRuntimeService({
    paseoHome: path.join(root, "paseo-home"),
    resolveRuntimeId: async (id) => runtimeIds.get(id) ?? null,
    persistRuntimeId: async (id, runtimeId) => {
      runtimeIds.set(id, runtimeId);
    },
    externalRuntimes: {
      fixture: {
        type: "command",
        command: [processExecPath(), fixtureExecutable],
        options: {
          stateDirectory,
          ...(withBarrier ? { inspectBarrierDirectory: barrierDirectory } : {}),
        },
      },
    },
  });
  return {
    source,
    stateDirectory,
    barrierDirectory,
    workspaceId,
    service,
    createInput: {
      workspaceId,
      runtimeId: "fixture",
      project: { id: `${name}-project`, source: { kind: "host-directory" as const, path: source } },
      placement: { kind: "existing" as const },
    },
  };
}

function processExecPath(): string {
  return process.execPath;
}
