import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../..", import.meta.url));

test("core owns only generic command runtime registration", () => {
  const serverPackage = packageJson("packages/server/package.json");
  expect(serverPackage.dependencies).not.toHaveProperty("@getpaseo/docker-workspace-runtime");

  const rootPackage = packageJson("package.json");
  expect(rootPackage.scripts?.["build:server-deps"]).not.toContain("docker-workspace-runtime");
  expect(rootPackage.scripts?.["build:server-deps:clean"]).not.toContain(
    "docker-workspace-runtime",
  );

  for (const relativePath of [
    "packages/server/src/server/workspace-runtime/index.ts",
    "packages/server/src/server/persisted-config.ts",
    "packages/server/src/server/bootstrap.ts",
    "packages/app/src/new-workspace-runtime/model.ts",
  ]) {
    const source = readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    expect(source, relativePath).not.toContain("@getpaseo/docker-workspace-runtime");
    expect(source, relativePath).not.toMatch(/type:\s*["']docker["']/u);
  }
});

test("Docker's bundled registration exists only at distribution composition roots", () => {
  const packageName = "@getpaseo/docker-workspace-runtime";
  for (const relativePath of [
    "packages/cli/src/commands/daemon/local-daemon.ts",
    "packages/desktop/src/daemon/daemon-manager.ts",
  ]) {
    expect(readFileSync(path.join(repositoryRoot, relativePath), "utf8"), relativePath).toContain(
      packageName,
    );
  }
});

function packageJson(relativePath: string): {
  dependencies?: Record<string, string>;
  scripts?: Record<string, string>;
} {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}
