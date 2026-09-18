#!/usr/bin/env node
// Serve a platform-local build in an isolated home through the managed preview
// broker. The source checkout's dependencies and production daemon stay separate.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const checkout = process.env.PASEO_WORKTREE_PATH || process.cwd();
const runtime = path.resolve(
  checkout,
  process.env.PASEO_PREVIEW_RUNTIME_ROOT || ".dev/preview-runtime",
);
const home = path.resolve(checkout, ".dev/preview-home");
const entry = path.join(runtime, "packages/server/dist/scripts/supervisor-entrypoint.js");
const web = path.resolve(checkout, ".dev/preview-web");
const port = Number(process.env.PASEO_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PASEO_PORT is required");
if (!existsSync(entry) || !existsSync(path.join(web, "index.html"))) {
  throw new Error(
    "Build the daemon in .dev/preview-runtime and publish the web export to .dev/preview-web before starting preview",
  );
}
const origin = process.env.PASEO_PREVIEW_ORIGIN;
if (!origin) throw new Error("Start this service with paseo-preview to supply its private origin");
const hostname = new URL(origin).hostname;
const child = spawn(process.execPath, [entry], {
  cwd: runtime,
  stdio: "inherit",
  env: {
    ...process.env,
    PASEO_HOME: home,
    PASEO_LISTEN: `127.0.0.1:${port}`,
    PASEO_WEB_UI_ENABLED: "true",
    PASEO_WEB_UI_DIST_DIR: web,
    PASEO_RELAY_ENABLED: "false",
    PASEO_DICTATION_ENABLED: "false",
    PASEO_VOICE_MODE_ENABLED: "false",
    PASEO_CORS_ORIGINS: origin,
    PASEO_HOSTNAMES: `127.0.0.1,localhost,${hostname}`,
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
