#!/usr/bin/env node
// Build from a source snapshot with platform-local dependencies. Never reuse
// the Mac's node_modules from a Linux container or modify the working checkout.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(os.homedir(), ".cache", "paseo-instance-build");
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: source })
  .toString()
  .split("\0")
  .filter(Boolean);
console.log(`Snapshotting ${files.length} source files to ${root}`);
await fs.mkdir(root, { recursive: true });
// A failed build must not leave an old export that could be published as new.
await fs.rm(path.join(root, "web-export"), { recursive: true, force: true });
const previousPath = path.join(root, ".source-files.json");
let previous = [];
try {
  previous = JSON.parse(await fs.readFile(previousPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const relative of previous) {
  if (!files.includes(relative)) await fs.rm(path.join(root, relative), { force: true });
}
for (const relative of files) {
  if (relative.startsWith("../") || path.isAbsolute(relative))
    throw new Error("Invalid source path");
  const from = path.join(source, relative);
  // Tracked files deleted in the working tree still appear in git ls-files.
  const stat = await fs.lstat(from).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) {
    await fs.rm(path.join(root, relative), { force: true });
    continue;
  }
  if (!stat.isFile()) continue;
  const to = path.join(root, relative);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}
await fs.writeFile(previousPath, JSON.stringify(files));
const fingerprint = crypto
  .createHash("sha256")
  .update(await fs.readFile(path.join(root, "package-lock.json")))
  .update(process.platform + process.arch + process.versions.node.split(".")[0])
  .digest("hex");
const stamp = path.join(root, ".dependencies-stamp");
let cached = "";
try {
  cached = await fs.readFile(stamp, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const env = {
  ...process.env,
  LEFTHOOK: "0",
  APP_VARIANT: "production",
  PASEO_BUILD_COMMIT: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
  }).trim(),
};
function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
}
if (cached !== fingerprint) {
  console.log("Installing platform-local build dependencies");
  run("npm", ["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"]);
  run("npm", ["run", "postinstall"]);
  await fs.writeFile(stamp, fingerprint);
}
console.log("Building application dependencies");
run("npm", ["run", "build:app-deps"]);
run(
  "npx",
  ["expo", "export", "--platform", "web", "--output-dir", path.join(root, "web-export")],
  path.join(root, "packages/app"),
);
console.log("Export ready: " + path.join(root, "web-export"));
console.log(
  "Publish with: node " +
    path.join(source, "scripts/publish-instance-web.mjs") +
    " " +
    path.join(root, "web-export") +
    " /home/paseo/.paseo/web-ui",
);
