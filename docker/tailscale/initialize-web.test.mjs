import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initializeHome, initializeWeb } from "./initialize-web.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-web-init-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "bundled");
  const destination = path.join(root, "home", "web-ui");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "index.html"), '<script src="/entry.js"></script>');
  await fs.writeFile(path.join(source, "entry.js"), "bundled entry");
  return { source, destination };
}

test("seeds a fresh home and preserves an independently published release", async (t) => {
  const { source, destination } = await fixture(t);
  await initializeWeb(source, destination);
  assert.equal(await fs.readFile(path.join(destination, "entry.js"), "utf8"), "bundled entry");
  const receipt = JSON.parse(await fs.readFile(path.join(destination, "release.json"), "utf8"));
  assert.deepEqual(receipt.scripts, ["/entry.js"]);
  await fs.writeFile(path.join(destination, "index.html"), "custom publication");
  await fs.writeFile(path.join(source, "entry.js"), "newer image");
  await initializeWeb(source, destination);
  assert.equal(
    await fs.readFile(path.join(destination, "index.html"), "utf8"),
    "custom publication",
  );
  assert.equal(await fs.readFile(path.join(destination, "entry.js"), "utf8"), "bundled entry");
});

test("initializes an existing empty directory", async (t) => {
  const { source, destination } = await fixture(t);
  await fs.mkdir(destination, { recursive: true });
  await initializeWeb(source, destination);
  assert.equal(
    await fs.readFile(path.join(destination, "index.html"), "utf8"),
    '<script src="/entry.js"></script>',
  );
});

test("refuses to overwrite a partial publication", async (t) => {
  const { source, destination } = await fixture(t);
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "keep.js"), "private export");
  await assert.rejects(initializeWeb(source, destination), /nonempty/);
  assert.deepEqual(await fs.readdir(destination), ["keep.js"]);
  assert.equal(await fs.readFile(path.join(destination, "keep.js"), "utf8"), "private export");
});

test("missing bundled assets fail before creating a persistent release", async (t) => {
  const { source, destination } = await fixture(t);
  await fs.rm(path.join(source, "entry.js"));
  await assert.rejects(initializeWeb(source, destination), { code: "ENOENT" });
  await assert.rejects(fs.access(destination), { code: "ENOENT" });
});

test("rejects an entry point outside the bundle", async (t) => {
  const { source, destination } = await fixture(t);
  await fs.writeFile(path.join(source, "index.html"), '<script src="/../entry.js"></script>');
  await assert.rejects(initializeWeb(source, destination), /Unexpected script URL/);
  await assert.rejects(fs.access(destination), { code: "ENOENT" });
});

test("image upgrades refresh an untouched bundled release and retain old assets", async (t) => {
  const { source, destination } = await fixture(t);
  await initializeWeb(source, destination);
  await fs.writeFile(path.join(source, "index.html"), '<script src="/next.js"></script>');
  await fs.writeFile(path.join(source, "next.js"), "new image");
  await fs.rm(path.join(source, "entry.js"));
  await initializeWeb(source, destination);
  assert.equal(await fs.readFile(path.join(destination, "next.js"), "utf8"), "new image");
  assert.equal(await fs.readFile(path.join(destination, "entry.js"), "utf8"), "bundled entry");
  assert.equal(
    await fs.readFile(path.join(destination, "index.html"), "utf8"),
    '<script src="/next.js"></script>',
  );
});

test("new homes enable managed workers without overwriting existing configuration", async (t) => {
  const { source } = await fixture(t);
  await initializeHome(source);
  const config = path.join(source, "config.json");
  assert.deepEqual(JSON.parse(await fs.readFile(config, "utf8")), {
    daemon: { mcp: { enabled: true, injectIntoAgents: true }, relay: { enabled: false } },
  });
  await fs.writeFile(config, '{"daemon":{"mcp":{"injectIntoAgents":false}}}');
  await initializeHome(source);
  assert.equal(await fs.readFile(config, "utf8"), '{"daemon":{"mcp":{"injectIntoAgents":false}}}');
});
