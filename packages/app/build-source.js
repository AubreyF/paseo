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
  if (fs.existsSync(path.join(root, ".git"))) {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  }
  // A snapshot can be exported again outside the original build process. Keep
  // its recorded source base without accidentally reading a parent repository.
  const stamp = path.join(root, ".build-source-commit");
  if (!fs.existsSync(stamp)) return null;
  const commit = fs.readFileSync(stamp, "utf8").trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(".build-source-commit must contain a full Git commit SHA");
  }
  return commit;
}

module.exports = { resolveBuildCommit };
