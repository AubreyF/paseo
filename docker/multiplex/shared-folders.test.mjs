import { execFileSync } from "node:child_process";
import fs from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
const code = fs.readFileSync(new URL("./shared-folders.mjs", import.meta.url), "utf8");
function stage(previous, source) {
  return execFileSync(
    process.execPath,
    ["--input-type=module", "-e", code, "/Users/example", source],
    { input: previous, encoding: "utf8" },
  );
}
test("shares retain stable mount paths and escape Compose interpolation", () => {
  const first = stage("{}", "/Users/example/Documents/A $folder");
  const next = stage(first, "/Users/example/dev");
  const repeated = JSON.parse(stage(next, "/Users/example/dev"));
  const config = JSON.parse(
    repeated.services.paseo.environment.PASEO_HOST_FILESYSTEM.replaceAll("$$", "$"),
  );
  assert.equal(config.shares.length, 2);
  assert.equal(config.shares[0].hostPath, "/Users/example/Documents/A $folder");
  assert.equal(repeated.services.paseo.volumes[0].source, "/Users/example/Documents/A $$folder");
  assert.equal(repeated.services.paseo.volumes[0].bind.create_host_path, false);
  assert.equal(repeated.services.paseo.volumes[0].target, config.shares[0].containerPath);
});

test("existing mounts retain their project path and read-only access", () => {
  const mounts = [
    { Type: "bind", Source: "/Users/example/dev", Destination: "/workspace/$project", RW: false },
  ];
  const generated = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      code,
      "/Users/example",
      "/Users/example/dev",
      JSON.stringify(mounts),
    ],
    { input: "{}", encoding: "utf8" },
  );
  const volume = JSON.parse(generated).services.paseo.volumes[0];
  assert.equal(volume.target, "/workspace/$$project");
  assert.equal(volume.read_only, true);
});
