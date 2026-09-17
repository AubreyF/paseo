import { expect, test } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWorkerPhysicalWorkspace } from "./worker-permissions.js";

test("requires prepared directories without repairing missing or file deny targets", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-paths-")));
  try {
    await expect(verifyWorkerPhysicalWorkspace(root)).rejects.toThrow();
    await writeFile(join(root, ".codex"), "fixture");
    await expect(verifyWorkerPhysicalWorkspace(root)).rejects.toThrow("physical workspace");
    await rm(join(root, ".codex"));
    await mkdir(join(root, ".codex"));
    await expect(verifyWorkerPhysicalWorkspace(root)).resolves.toBeUndefined();
    await expect(verifyWorkerPhysicalWorkspace("relative")).rejects.toThrow("physical workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinks in the workspace and protected directory paths", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-links-")));
  const work = join(root, "work");
  const linked = join(root, "linked");
  const outside = join(root, "outside");
  try {
    await mkdir(work);
    await mkdir(outside);
    await mkdir(join(work, ".codex"));
    await symlink(work, linked, "junction");
    await expect(verifyWorkerPhysicalWorkspace(linked)).rejects.toThrow("physical workspace");
    await rm(join(work, ".codex"), { recursive: true });
    await symlink(outside, join(work, ".codex"), "junction");
    await expect(verifyWorkerPhysicalWorkspace(work)).rejects.toThrow("physical workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
