const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveBuildCommit } = require("./build-source");

test("source snapshots use the supplied commit and reject non-commit values", () => {
  assert.equal(resolveBuildCommit("/not-a-repository", "a".repeat(40)), "a".repeat(40));
  assert.throws(() => resolveBuildCommit("/not-a-repository", "main"), /full Git commit SHA/);
});

test("ordinary builds record HEAD, but nested snapshots do not inherit a parent's identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vorton-source-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "Initial",
      ],
      { cwd: root },
    );
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    assert.equal(resolveBuildCommit(root, ""), commit);
    const snapshot = path.join(root, "snapshot");
    fs.mkdirSync(snapshot);
    assert.equal(resolveBuildCommit(snapshot, ""), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
