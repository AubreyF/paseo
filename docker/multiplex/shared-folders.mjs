import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

// Runs inside the image; the host needs only Bash and Docker.
const [hostHome, source, mountsJson = "[]"] = process.argv.slice(1);
const previous = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const encoded = previous.services?.paseo?.environment?.PASEO_HOST_FILESYSTEM;
const config = encoded
  ? JSON.parse(encoded.replaceAll("$$", "$"))
  : { version: 1, hostHome, shares: [] };
if (config.hostHome !== hostHome)
  throw new Error("Run this command as the installation's host user.");
if (source && !config.shares.some((share) => share.hostPath === source)) {
  const id = crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
  const mounts = JSON.parse(mountsJson);
  const existing = mounts.find((mount) => mount.Type === "bind" && mount.Source === source);
  // Keep existing project paths stable when a deployment already shares this source.
  const containerPath = existing ? existing.Destination : `/shared/${id}`;
  if (!path.isAbsolute(containerPath)) throw new Error("Invalid existing mount destination.");
  config.shares.push({ id, hostPath: source, containerPath, readOnly: existing?.RW === false });
}
// Compose interpolates dollar signs even in JSON string values.
function literal(value) {
  return value.replaceAll("$", () => "$$");
}
const result = {
  services: {
    paseo: {
      environment: { PASEO_HOST_FILESYSTEM: literal(JSON.stringify(config)) },
      volumes: config.shares.map((share) => ({
        type: "bind",
        source: literal(share.hostPath),
        target: literal(share.containerPath),
        read_only: share.readOnly ?? false,
        bind: { create_host_path: false },
      })),
    },
  },
};
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
