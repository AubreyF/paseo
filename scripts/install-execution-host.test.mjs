import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertProtectedPaths, validateInstallPlan } from "./install-execution-host.mjs";

test("protected paths cannot enter a guest bind, including through a symlink ancestor", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "installation-paths-"));
  try {
    const guest = path.join(root, "shared");
    mkdirSync(guest);
    const alias = path.join(root, "alias");
    symlinkSync(guest, alias);
    expect(() => assertProtectedPaths([path.join(alias, "new", "release")], [guest])).toThrow(
      "writable container bind",
    );
    expect(() => assertProtectedPaths([root], [guest])).toThrow("writable container bind");
    expect(() => assertProtectedPaths([guest], [path.parse(guest).root])).toThrow(
      "writable container bind",
    );
    expect(() =>
      assertProtectedPaths([path.join(root, "private", "release")], [guest]),
    ).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer requires a reviewed commit and distinct ports", () => {
  const plan = {
    root: "/tmp/private-installation",
    revision: "a".repeat(40),
    containerName: "existing-container",
    containerServerId: "guest-id",
    containerDaemonHome: "/tmp/test-container-home",
    containerPasswordFile: "/tmp/test-password",
    containerOrigin: "https://container.example.test",
  };
  expect(validateInstallPlan(plan).httpsPort).toBe(44444);
  expect(() => validateInstallPlan({ ...plan, revision: "main" })).toThrow("reviewed");
  expect(() => validateInstallPlan({ ...plan, hostPort: 6768 })).toThrow("distinct");
});
