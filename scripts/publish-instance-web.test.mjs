import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

test("publication compresses fresh assets, replaces stale sidecars, and preserves old chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publish-web-test-"));
  try {
    const source = path.join(root, "export");
    const destination = path.join(root, "served");
    await mkdir(source);
    await mkdir(destination);
    const html = '<script src="/entry.js"></script>';
    const script = 'console.log("current application");'.repeat(100);
    await writeFile(path.join(source, "index.html"), html);
    await writeFile(path.join(source, "entry.js"), script);
    await writeFile(path.join(source, "entry.js.br"), "stale compressed content");
    await writeFile(path.join(destination, "old-chunk.js"), "old chunk");
    await writeFile(path.join(destination, "index.html"), "previous index");
    execFileSync(process.execPath, ["scripts/publish-instance-web.mjs", source, destination]);
    assert.equal(
      brotliDecompressSync(await readFile(path.join(destination, "entry.js.br"))).toString(),
      script,
    );
    assert.equal(
      gunzipSync(await readFile(path.join(destination, "entry.js.gz"))).toString(),
      script,
    );
    assert.equal(await readFile(path.join(destination, "index.html"), "utf8"), html);
    assert.equal(
      await readFile(path.join(destination, "index.previous.html"), "utf8"),
      "previous index",
    );
    assert.equal(await readFile(path.join(destination, "old-chunk.js"), "utf8"), "old chunk");
    const compressed = path.join(destination, "entry.js.br");
    const stamp = new Date("2000-01-01T00:00:00Z");
    await utimes(compressed, stamp, stamp);
    execFileSync(process.execPath, ["scripts/publish-instance-web.mjs", source, destination]);
    assert.equal((await stat(compressed)).mtimeMs, stamp.getTime());
    await writeFile(path.join(source, "entry.js"), "updated content");
    execFileSync(process.execPath, ["scripts/publish-instance-web.mjs", source, destination]);
    assert.equal(brotliDecompressSync(await readFile(compressed)).toString(), "updated content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
