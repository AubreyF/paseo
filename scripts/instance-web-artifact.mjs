import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const manifestName = ".build-manifest.json";
export function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
export function git(repository, args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

export async function readLiveState(destination) {
  async function read(name) {
    return fs.readFile(path.join(destination, name)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  }
  const index = await read("index.html");
  const receipt = await read("release.json");
  const release = receipt ? JSON.parse(receipt.toString()) : null;
  if (release && (!index || release.sha256 !== digest(index))) {
    throw new Error(
      "Live index and release receipt disagree; recover publication before building.",
    );
  }
  return {
    token: digest(JSON.stringify([index && digest(index), receipt && digest(receipt)])),
    release,
    index,
    receipt,
  };
}

export function assertIntegratedSource(repository, integrationRef, previousCommit) {
  if (!integrationRef.startsWith("refs/heads/")) {
    throw new Error("Use a full local integration branch reference: refs/heads/<branch>.");
  }
  if (git(repository, ["symbolic-ref", "HEAD"]) !== integrationRef) {
    throw new Error("Primary builds must run from the configured integration branch.");
  }
  if (git(repository, ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("Primary builds require clean, committed integration source.");
  }
  const commit = git(repository, ["rev-parse", "HEAD"]);
  if (previousCommit) {
    execFileSync("git", ["merge-base", "--is-ancestor", previousCommit, commit], {
      cwd: repository,
      stdio: "pipe",
    });
  }
  return commit;
}

export async function hashFiles(directory, { allowSourceLinks = false } = {}) {
  const files = {};
  async function visit(relative) {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (name === manifestName) continue;
      if (entry.isSymbolicLink()) {
        if (!allowSourceLinks) throw new Error(`Symbolic link in artifact: ${name}`);
        const target = await fs.readlink(path.join(directory, name));
        const resolved = path.resolve(directory, path.dirname(name), target);
        if (path.isAbsolute(target) || !resolved.startsWith(path.resolve(directory) + path.sep)) {
          throw new Error(`Source link escapes snapshot: ${name}`);
        }
        files[name] = digest(`symlink:${target}`);
        continue;
      }
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files[name] = digest(await fs.readFile(path.join(directory, name)));
      else throw new Error(`Unsupported artifact entry: ${name}`);
    }
  }
  await visit("");
  return files;
}

export async function sealArtifact(directory, provenance) {
  const files = await hashFiles(directory);
  if (!files["index.html"]) throw new Error("Build did not produce index.html.");
  await fs.writeFile(
    path.join(directory, manifestName),
    JSON.stringify({ version: 1, ...provenance, files }, null, 2) + "\n",
    { flag: "wx" },
  );
}

export async function snapshotSource({ source, sourceCommit, committed, builds }) {
  await fs.mkdir(builds, { recursive: true });
  const root = await fs.mkdtemp(path.join(builds, "build-"));
  if (committed) {
    // Archive the chosen commit so concurrent edits cannot contaminate a primary build.
    const archive = path.join(root, ".source.tar");
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, sourceCommit], {
      cwd: source,
    });
    execFileSync("tar", ["-xf", archive, "-C", root]);
    await fs.rm(archive);
  } else {
    const files = git(source, ["ls-files", "-co", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean);
    for (const relative of new Set(files)) {
      if (relative.startsWith("../") || path.isAbsolute(relative))
        throw new Error("Invalid source path");
      const from = path.join(source, relative);
      const stat = await fs.lstat(from).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) continue;
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new Error(`Unsupported source entry: ${relative}`);
      const to = path.join(root, relative);
      await fs.mkdir(path.dirname(to), { recursive: true });
      if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(from), to);
      else await fs.copyFile(from, to);
    }
  }
  return {
    root,
    sourceHash: digest(JSON.stringify(await hashFiles(root, { allowSourceLinks: true }))),
  };
}
