import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function initializeWeb(source, destination) {
  const target = path.resolve(destination);
  const entries = await fs.readdir(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  const existing = entries.includes("index.html");
  if (existing) {
    const receipt = await fs.readFile(path.join(target, "release.json"), "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!receipt) return;
    const release = JSON.parse(receipt);
    if (release.source !== "bundled") return;
    const current = await fs.readFile(path.join(target, "index.html"));
    if (crypto.createHash("sha256").update(current).digest("hex") !== release.sha256) return;
  } else if (entries.length) {
    throw new Error(
      "Persistent web directory is nonempty but has no index.html; review it before initializing.",
    );
  }
  const html = await fs.readFile(path.join(source, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  if (!scripts.length) throw new Error("Bundled web UI has no JavaScript entry point");
  for (const script of scripts) {
    if (!script.startsWith("/") || script.includes("..")) throw new Error("Unexpected script URL");
    await fs.access(path.join(source, script));
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(target), ".web-init-"));
  try {
    await fs.cp(source, staging, { recursive: true });
    await fs.writeFile(
      path.join(staging, "release.json"),
      JSON.stringify(
        {
          source: "bundled",
          publishedAt: new Date().toISOString(),
          sha256: crypto.createHash("sha256").update(html).digest("hex"),
          scripts,
        },
        null,
        2,
      ) + "\n",
    );
    if (existing) {
      // Keep prior hashed chunks for clients that were open during the image update.
      for (const entry of await fs.readdir(staging)) {
        if (entry === "index.html" || entry === "release.json") continue;
        await fs.cp(path.join(staging, entry), path.join(target, entry), { recursive: true });
      }
      await fs.rename(path.join(staging, "index.html"), path.join(target, "index.html"));
      await fs.rename(path.join(staging, "release.json"), path.join(target, "release.json"));
    } else {
      // Rename refuses a nonempty target if a publisher wins the race.
      await fs.rename(staging, target);
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function initializeHome(home) {
  // Enable managed workers only for a new home; existing operator choices survive upgrades.
  const config = path.join(home, "config.json");
  await fs
    .writeFile(
      config,
      JSON.stringify(
        {
          daemon: { mcp: { enabled: true, injectIntoAgents: true }, relay: { enabled: false } },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    )
    .catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await initializeHome(process.env.PASEO_HOME);
  const entry = (await fs.readFile("/etc/paseo-server-entry", "utf8")).trim();
  const source = path.resolve(path.dirname(entry), "../server/web-ui");
  const destination = process.env.PASEO_WEB_UI_DIST_DIR;
  if (!destination) throw new Error("PASEO_WEB_UI_DIST_DIR is required");
  await initializeWeb(source, destination);
}
