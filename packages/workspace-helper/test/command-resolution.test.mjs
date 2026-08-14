import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { resolveCommand } from "../src/command-resolution.mjs";

const cleanupRoots = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Windows command resolution honors PATHEXT", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-helper-windows-command-"));
  cleanupRoots.push(root);
  const executable = path.join(root, "git.EXE");
  await writeFile(executable, "");
  await chmod(executable, 0o755);

  await expect(
    resolveCommand(root, "git", {
      environment: { PATH: root, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      executablePath: path.join(root, "node.EXE"),
      platform: "win32",
    }),
  ).resolves.toBe(await realpath(executable));
});
