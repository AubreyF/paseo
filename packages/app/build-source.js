const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function resolveBuildCommit(root, explicitCommit = process.env.PASEO_BUILD_COMMIT) {
  if (explicitCommit) {
    if (!/^[a-f0-9]{40}$/.test(explicitCommit)) {
      throw new Error("PASEO_BUILD_COMMIT must be a full Git commit SHA");
    }
    return explicitCommit;
  }
  // Exports from source snapshots have no Git metadata. Never stamp a parent repository.
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

module.exports = { resolveBuildCommit };
