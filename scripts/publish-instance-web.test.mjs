import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { watch } from "node:fs";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import { installationWebEntry } from "./installation-web-entry.mjs";
import {
  assertIntegratedSource,
  digest,
  git,
  readLiveState,
  sealArtifact,
  snapshotSource,
} from "./instance-web-artifact.mjs";
const run = promisify(execFile);
const publisher = path.resolve("scripts/publish-instance-web.mjs");

test("installation entry preserves deep links without reading client credentials or storage", () => {
  const entry = installationWebEntry("https://owner.example.test:44444");
  let replaced;
  const location = {
    origin: "https://container.example.test",
    pathname: "/h/container/workspace/known-conversation",
    search: "?serverId=container&projectId=existing",
    hash: "#draft",
    replace: (url) => {
      replaced = url;
    },
  };
  runInNewContext(entry.script, { window: { location }, URL });
  assert.equal(
    replaced,
    "https://owner.example.test:44444/h/container/workspace/known-conversation?serverId=container&projectId=existing#draft",
  );
  assert.match(entry.html, new RegExp(entry.scriptName));
  assert.match(entry.html, /name="referrer" content="no-referrer"/);
});

test("installation entry rejects insecure or credential-bearing targets and does not loop", () => {
  for (const origin of [
    "http://owner.example.test",
    "https://user:secret@owner.example.test",
    "https://owner.example.test/path",
    "https://owner.example.test?token=secret",
    "https://owner.example.test#token",
  ])
    assert.throws(() => installationWebEntry(origin), /HTTPS origin/);
  const entry = installationWebEntry("https://owner.example.test");
  const status = { textContent: "" };
  runInNewContext(entry.script, {
    window: { location: { origin: entry.origin, replace: () => assert.fail("redirect loop") } },
    document: { getElementById: () => status },
  });
  assert.match(status.textContent, /points to itself/);
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "publish-web-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  const destination = path.join(root, "served");
  await fs.mkdir(repository);
  await fs.mkdir(destination);
  git(repository, ["init", "-b", "integration"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);
  git(repository, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repository, "app.txt"), "first source");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "Initial source"]);
  return { root, repository, destination };
}
async function candidate(f, name, previous = null) {
  const directory = path.join(f.root, name);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "index.html"), `<script src="/${name}.js"></script>`);
  await fs.writeFile(path.join(directory, `${name}.js`), `console.log('${name}');`.repeat(100));
  const live = previous ?? (await readLiveState(f.destination));
  await sealArtifact(directory, {
    buildId: name,
    sourceCommit: git(f.repository, ["rev-parse", "HEAD"]),
    sourceHash: digest("source"),
    deployment: {
      destination: f.destination,
      expectedRelease: live.token,
      integrationRef: "refs/heads/integration",
      repository: f.repository,
    },
  });
  return directory;
}
function publish(source, destination) {
  return run(process.execPath, [publisher, source, destination]);
}

test("installation redirects use guarded publication and record their target", async (t) => {
  const f = await fixture(t);
  const entry = installationWebEntry("https://owner.example.test:44444");
  const directory = path.join(f.root, "redirect");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "index.html"), entry.html);
  await fs.writeFile(path.join(directory, entry.scriptName), entry.script);
  await sealArtifact(directory, {
    buildId: "redirect",
    sourceCommit: git(f.repository, ["rev-parse", "HEAD"]),
    sourceHash: digest("source"),
    entrypoint: { kind: "installation", origin: entry.origin },
    deployment: {
      destination: f.destination,
      expectedRelease: (await readLiveState(f.destination)).token,
      integrationRef: "refs/heads/integration",
      repository: f.repository,
    },
  });
  await publish(directory, f.destination);
  const live = await readLiveState(f.destination);
  assert.deepEqual(live.release.entrypoint, { kind: "installation", origin: entry.origin });
  assert.equal(await fs.readFile(path.join(f.destination, entry.scriptName), "utf8"), entry.script);
});

test("publication switches index and receipt together and preserves old chunks", async (t) => {
  const f = await fixture(t);
  const first = await candidate(f, "first");
  await publish(first, f.destination);
  const firstState = await readLiveState(f.destination);
  const second = await candidate(f, "second");
  await publish(second, f.destination);
  const live = await readLiveState(f.destination);
  assert.notEqual(live.token, firstState.token);
  assert.equal(live.release.buildId, "second");
  assert.equal(await fs.readlink(path.join(f.destination, "index.html")), ".current/index.html");
  assert.equal(
    await fs.readlink(path.join(f.destination, "release.json")),
    ".current/release.json",
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.destination, "index.previous.html")),
    firstState.index,
  );
  const script = await fs.readFile(path.join(first, "first.js"));
  assert.deepEqual(await fs.readFile(path.join(f.destination, "first.js")), script);
  assert.deepEqual(
    brotliDecompressSync(await fs.readFile(path.join(f.destination, "first.js.br"))),
    script,
  );
  assert.deepEqual(gunzipSync(await fs.readFile(path.join(f.destination, "first.js.gz"))), script);
});

test("competing publishers allow exactly one winner; stale candidates leave it intact", async (t) => {
  const f = await fixture(t);
  const baseline = await readLiveState(f.destination);
  const a = await candidate(f, "a", baseline);
  const b = await candidate(f, "b", baseline);
  const results = await Promise.allSettled([publish(a, f.destination), publish(b, f.destination)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const live = await readLiveState(f.destination);
  await assert.rejects(
    publish(live.release.buildId === "a" ? b : a, f.destination),
    /Stale candidate/,
  );
  assert.equal((await readLiveState(f.destination)).token, live.token);
});

test("modified, missing, preview and colliding artifacts cannot change a live release", async (t) => {
  const f = await fixture(t);
  await publish(await candidate(f, "initial"), f.destination);
  const before = await readLiveState(f.destination);
  const changed = await candidate(f, "changed");
  await fs.writeFile(path.join(changed, "changed.js"), "tampered");
  await assert.rejects(publish(changed, f.destination), /Artifact changed/);
  const missing = await candidate(f, "missing");
  await fs.rm(path.join(missing, "missing.js"));
  await assert.rejects(publish(missing, f.destination), /Artifact changed/);
  const preview = await candidate(f, "preview");
  const manifest = path.join(preview, ".build-manifest.json");
  const value = JSON.parse(await fs.readFile(manifest));
  value.deployment = null;
  await fs.writeFile(manifest, JSON.stringify(value));
  await assert.rejects(publish(preview, f.destination), /primary build/);
  const collision = await candidate(f, "collision");
  await fs.writeFile(path.join(f.destination, "collision.js"), "old bytes");
  await assert.rejects(publish(collision, f.destination), /Asset URL collision/);
  assert.equal((await readLiveState(f.destination)).token, before.token);
  assert.equal(await fs.readFile(path.join(f.destination, "collision.js"), "utf8"), "old bytes");
});

test("an interrupted publisher lock blocks publication without deleting the lock", async (t) => {
  const f = await fixture(t);
  const artifact = await candidate(f, "locked");
  const before = await readLiveState(f.destination);
  await fs.mkdir(path.join(f.destination, ".publish-lock"));
  await assert.rejects(publish(artifact, f.destination), /Another publisher/);
  assert.equal((await readLiveState(f.destination)).token, before.token);
  assert((await fs.stat(path.join(f.destination, ".publish-lock"))).isDirectory());
});

test("legacy file migration preserves baseline and uses a single release pointer", async (t) => {
  const f = await fixture(t);
  const oldHtml = Buffer.from("old application");
  await fs.writeFile(path.join(f.destination, "index.html"), oldHtml);
  await fs.writeFile(
    path.join(f.destination, "release.json"),
    JSON.stringify({ sha256: digest(oldHtml) }),
  );
  const artifact = await candidate(f, "migrated");
  await publish(artifact, f.destination);
  assert.equal((await readLiveState(f.destination)).release.buildId, "migrated");
  assert.deepEqual(await fs.readFile(path.join(f.destination, "index.previous.html")), oldHtml);
});

test("primary source rejects dirty worktrees, other branches and missing deployed ancestry", async (t) => {
  const f = await fixture(t);
  const first = assertIntegratedSource(f.repository, "refs/heads/integration");
  await fs.writeFile(path.join(f.repository, "app.txt"), "uncommitted");
  assert.throws(
    () => assertIntegratedSource(f.repository, "refs/heads/integration"),
    /clean, committed/,
  );
  git(f.repository, ["add", "."]);
  git(f.repository, ["commit", "-qm", "Second"]);
  const second = assertIntegratedSource(f.repository, "refs/heads/integration", first);
  git(f.repository, ["checkout", "-qb", "task"]);
  assert.throws(
    () => assertIntegratedSource(f.repository, "refs/heads/integration"),
    /integration branch/,
  );
  git(f.repository, ["checkout", "integration"]);
  git(f.repository, ["reset", "--hard", first]);
  assert.throws(() => assertIntegratedSource(f.repository, "refs/heads/integration", second));
});

test("concurrent snapshots have private paths and committed snapshots ignore later edits", async (t) => {
  const f = await fixture(t);
  const options = {
    source: f.repository,
    sourceCommit: git(f.repository, ["rev-parse", "HEAD"]),
    committed: true,
    builds: path.join(f.root, "builds"),
  };
  await fs.writeFile(path.join(f.repository, "app.txt"), "later edit");
  const [a, b] = await Promise.all([snapshotSource(options), snapshotSource(options)]);
  assert.notEqual(a.root, b.root);
  assert.equal(a.sourceHash, b.sourceHash);
  assert.equal(await fs.readFile(path.join(a.root, "app.txt"), "utf8"), "first source");
  await fs.writeFile(path.join(a.root, "app.txt"), "build output");
  assert.equal(await fs.readFile(path.join(b.root, "app.txt"), "utf8"), "first source");
});

test("killing a publisher during staging leaves the previous release usable", async (t) => {
  const f = await fixture(t);
  await publish(await candidate(f, "before"), f.destination);
  const before = await readLiveState(f.destination);
  const artifact = await candidate(f, "interrupted");
  const manifestPath = path.join(artifact, ".build-manifest.json");
  const provenance = JSON.parse(await fs.readFile(manifestPath));
  await fs.rm(manifestPath);
  await fs.writeFile(path.join(artifact, "large.js"), randomBytes(4 * 1024 * 1024));
  delete provenance.files;
  await sealArtifact(artifact, provenance);
  let child;
  const watcher = watch(f.destination, (_event, name) => {
    if (name?.startsWith(".staging-")) child.kill("SIGKILL");
  });
  t.after(() => watcher.close());
  child = spawn(process.execPath, [publisher, artifact, f.destination], { stdio: "ignore" });
  const [, signal] = await once(child, "exit");
  watcher.close();
  assert.equal(signal, "SIGKILL");
  assert.equal((await readLiveState(f.destination)).token, before.token);
  assert.deepEqual(
    await fs.readFile(path.join(f.destination, "before.js")),
    await fs.readFile(path.join(f.root, "before", "before.js")),
  );
  await assert.rejects(publish(artifact, f.destination), /Another publisher/);
  // Recovery is allowed only after the owning process has exited.
  await fs.rm(path.join(f.destination, ".publish-lock"), { recursive: true });
  await publish(artifact, f.destination);
  assert.equal((await readLiveState(f.destination)).release.buildId, "interrupted");
});
