import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { findWorkspaceBoundaryViolations } from "./check-workspace-runtime-boundaries.mjs";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oxlint = path.join(repoRoot, "node_modules/.bin/oxlint");

test("Oxlint rejects static host imports, re-exports, aliases, and internal package paths", async (t) => {
  const root = await fixtureRoot(t);
  await copyFile(path.join(repoRoot, ".oxlintrc.json"), path.join(root, ".oxlintrc.json"));
  await source(
    root,
    "packages/server/src/server/session/workspace-scripts/forbidden.ts",
    'import { spawn } from "child_process";\n' +
      'import { readFile } from "node:fs/promises";\n' +
      'import { createRequire as makeRequire } from "node:module";\n' +
      "const renamedLoader = makeRequire(import.meta.url);\n" +
      'renamedLoader("child_process");\n' +
      'renamedLoader("fs");\n' +
      'renamedLoader("@getpaseo/server/workspace-runtime/internal/service.js");\n' +
      'export * from "@getpaseo/server/workspace-runtime/internal/service.js";\n' +
      'export * from "@getpaseo/server/workspace-runtime/command/internal/command-runtime.js";\n' +
      'export * from "@getpaseo/server/workspace-runtime/git-observation/internal/integration.js";\n' +
      'export { default as helper } from "../../workspace-helper/internal/client.js";\n' +
      "void spawn; void readFile;\n",
  );
  await source(
    root,
    "packages/fixture-workspace-runtime/src/forbidden.mjs",
    'import "@getpaseo/server/workspace-runtime/command/internal/command-runtime.js";\n' +
      'import { createRequire as externalRequire } from "module";\n' +
      "const fixtureLoader = externalRequire(import.meta.url);\n" +
      'fixtureLoader("node:fs");\n' +
      'export * from "../../../packages/server/src/server/workspace-helper/internal/client.js";\n',
  );

  const error = await captureFailure(run(oxlint, ["packages"], { cwd: root }));
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  assert.match(output, /child_process/);
  assert.match(output, /node:fs\/promises/);
  assert.match(output, /node:module/);
  assert.match(output, /'module'/);
  assert.match(output, /workspace-runtime\/internal/);
  assert.match(output, /workspace-runtime\/command\/internal/);
  assert.match(output, /git-observation\/internal/);
  assert.match(output, /workspace-helper\/internal/);
});

test("the AST guard rejects computed loading and dynamic host/internal bypasses", async (t) => {
  const root = await fixtureRoot(t);
  await source(
    root,
    "packages/server/src/server/session/workspace-scripts/forbidden.ts",
    'import type { WorkspaceRuntimeService } from "../../workspace-runtime/index.js";\n' +
      'require("fs");\n' +
      'import("node:child_process");\n' +
      'const { createRequire: makeLoader } = require("module");\n' +
      'const renamedLoader = makeLoader(import.meta.url); renamedLoader("fs");\n' +
      'require("node:" + "fs/promises");\n' +
      "import(`@getpaseo/server/${segment}`);\n",
  );
  await source(
    root,
    "packages/server/src/server/session/business.ts",
    'require("@getpaseo/server/workspace-runtime/command/internal/command-runtime.js");\n',
  );
  await source(
    root,
    "packages/fixture-workspace-runtime/src/forbidden.mjs",
    'require("../../../packages/server/src/server/workspace-runtime/internal/service.js");\n' +
      'import("@getpaseo/" + packageName);\n',
  );

  const violations = await findWorkspaceBoundaryViolations(root);
  assert.deepEqual(
    violations.map(({ rule }) => rule).sort(),
    [
      "external-runtime-contract",
      "module-entrypoint",
      "module-entrypoint",
      "nonliteral-module-load",
      "nonliteral-module-load",
      "workspace-host-access",
      "workspace-host-access",
      "workspace-host-access",
      "workspace-host-access",
    ].sort(),
  );
});

test("the AST guard rejects every statically resolvable provider probe internal import", async (t) => {
  const root = await fixtureRoot(t);
  await source(
    root,
    "packages/server/src/server/session/computed.ts",
    'import { createService as direct } from "../provider-probe/internal/service.js";\n' +
      'import { createService as alias } from "@getpaseo/server/provider-probe/internal/service.js";\n' +
      'export { createService } from "../provider-probe/internal/service.js";\n' +
      'const internal = "../provider-probe/" + "internal/service.js";\n' +
      "const load = require;\n" +
      'void require("../provider-probe/internal/service.js");\n' +
      'void import("../provider-probe/" + "internal/service.js");\n' +
      'void import(`../provider-probe/${"internal"}/service.js`);\n' +
      "void import(internal);\n" +
      "void load(internal);\n" +
      "void direct; void alias;\n",
  );

  const violations = await findWorkspaceBoundaryViolations(root);
  assert.equal(violations.length, 8);
  assert.deepEqual(new Set(violations.map(({ rule }) => rule)), new Set(["module-entrypoint"]));
  assert.deepEqual(
    new Set(violations.map((violation) => violation.import)),
    new Set([
      "../provider-probe/internal/service.js",
      "@getpaseo/server/provider-probe/internal/service.js",
    ]),
  );
});

test("owned integrations, explicit legacy code, and fixture contract imports pass", async (t) => {
  const root = await fixtureRoot(t);
  await copyFile(path.join(repoRoot, ".oxlintrc.json"), path.join(root, ".oxlintrc.json"));
  await source(
    root,
    "packages/server/src/server/workspace-runtime/index.ts",
    'import { service } from "./internal/service.js"; void service;\n',
  );
  await source(
    root,
    "packages/server/src/server/provider-probe/index.ts",
    'import { createService } from "./internal/service.js";\n' +
      'export { createProbeStore } from "./internal/probe-store.js";\n' +
      "void createService;\n",
  );
  await source(
    root,
    "packages/server/src/server/workspace-runtime/command/index.ts",
    'export * from "./internal/command-runtime.js";\n',
  );
  await source(
    root,
    "packages/server/src/server/workspace-runtime/internal/service.ts",
    'import { git } from "../git-observation/internal/integration.js";\n' +
      'import { helper } from "../../workspace-helper/internal/integration/index.js";\n' +
      "export const service = [git, helper];\n",
  );
  await source(
    root,
    "packages/server/src/server/workspace-git-service.ts",
    'import { readFile } from "fs/promises"; void readFile;\n',
  );
  await source(
    root,
    "packages/fixture-workspace-runtime/src/index.mjs",
    'import { CommandRuntimeControlSchema } from "@getpaseo/workspace-runtime-contract";\n' +
      'import { spawn } from "node:child_process";\n' +
      'import("./nested.mjs"); void CommandRuntimeControlSchema; void spawn;\n',
  );
  await source(
    root,
    "packages/server/src/server/workspace-runtime/git-observation/internal/integration.ts",
    "export const git = 1;\n",
  );
  await source(
    root,
    "packages/server/src/server/workspace-helper/internal/integration/index.ts",
    "export const helper = 1;\n",
  );
  await source(
    root,
    "packages/fixture-workspace-runtime/src/nested.mjs",
    "export const nested = 1;\n",
  );

  assert.deepEqual(await findWorkspaceBoundaryViolations(root), []);
  try {
    await run(oxlint, ["packages"], { cwd: root });
  } catch (error) {
    assert.fail(`${error.stdout ?? ""}${error.stderr ?? ""}`);
  }
});

test("strict public schemas and helper argv reject root authority independent of syntax", async (t) => {
  await run("npm", ["run", "build", "--workspace=@getpaseo/workspace-runtime-contract"], {
    cwd: repoRoot,
  });
  const contract = await import(
    pathToFileURL(path.join(repoRoot, "packages/workspace-runtime-contract/dist/index.js"))
  );
  const key = ["ro", "ot"].join("");
  const state = { workspaceId: "workspace-01", lifecycle: "ready", [key]: "/private" };
  const schemaAlias = contract.CommandRuntimeStateSchema;
  assert.throws(() => schemaAlias.parse(state), /unrecognized key/i);
  assert.throws(
    () =>
      contract.CommandRuntimeLifecycleResponseSchema.parse({
        type: "state",
        protocolVersion: 1,
        state: { ...state },
        placement: { cwd: "/workspace" },
      }),
    /unrecognized key/i,
  );

  const root = await fixtureRoot(t);
  const helperError = await captureFailure(
    run(
      process.execPath,
      [
        path.join(repoRoot, "packages/server/src/server/workspace-helper/executable.mjs"),
        "fs-stat",
        `--${key}`,
        "/private",
        "--path",
        ".",
      ],
      { cwd: root },
    ),
  );
  assert.match(helperError.stderr, /Unknown workspace-helper argument: --root/);
});

async function captureFailure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected command to fail");
}

async function fixtureRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function source(root, relativePath, contents) {
  const filename = path.join(root, relativePath);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}
