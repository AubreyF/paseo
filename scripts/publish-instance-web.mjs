#!/usr/bin/env node
// Publish exported static assets only. This never restarts the daemon.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { compressFile } from "./compress-web-asset.mjs";

const COMPRESS_EXTENSIONS = new Set([".js", ".css", ".json", ".svg", ".map"]);

const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg) {
  throw new Error(
    "Usage: node scripts/publish-instance-web.mjs EXPORTED_WEB_DIR PERSISTENT_WEB_DIR",
  );
}
const source = await fs.realpath(sourceArg);
const destination = path.resolve(destinationArg);
if (source === destination || destination.startsWith(source + path.sep)) {
  throw new Error("Publish destination must be outside the export directory");
}
const html = await fs.readFile(path.join(source, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
if (!scripts.length) throw new Error("Export has no JavaScript entry point");
for (const script of scripts) {
  if (!script.startsWith("/") || script.includes("..")) throw new Error("Unexpected script URL");
  await fs.access(path.join(source, script));
}
const release = {
  publishedAt: new Date().toISOString(),
  sha256: crypto.createHash("sha256").update(html).digest("hex"),
  scripts,
};
await fs.mkdir(destination, { recursive: true });
// Keep prior hashed assets so already open browsers can still load lazy chunks.
async function copyAssets(directory, relative = "") {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    if (rel === "index.html") continue;
    // Regenerate sidecars from the export so stale compressed bytes cannot win.
    if (entry.name.endsWith(".br") || entry.name.endsWith(".gz")) continue;
    if (entry.isSymbolicLink()) throw new Error("Export must not contain symlinks");
    if (entry.isDirectory()) {
      await fs.mkdir(path.join(destination, rel), { recursive: true });
      await copyAssets(path.join(directory, entry.name), rel);
    } else if (entry.isFile()) {
      const target = path.join(destination, rel);
      await fs.copyFile(path.join(source, rel), target);
      if (COMPRESS_EXTENSIONS.has(path.extname(rel).toLowerCase())) {
        await compressFile(target);
      }
    }
  }
}
await copyAssets(source);
const nextIndex = path.join(destination, `.index-${process.pid}.tmp`);
await fs.writeFile(nextIndex, html);
try {
  await fs.copyFile(
    path.join(destination, "index.html"),
    path.join(destination, "index.previous.html"),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await fs.rename(nextIndex, path.join(destination, "index.html"));
await fs.writeFile(path.join(destination, "release.json"), JSON.stringify(release, null, 2) + "\n");
console.log(JSON.stringify(release, null, 2));
