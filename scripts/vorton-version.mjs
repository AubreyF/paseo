import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const mode = process.argv[2] ?? "--bump";
if (!["--bump", "--hook", "--check"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
const root = readJson("package.json");
const previous = JSON.parse(git("show", "HEAD:package.json")).version;
const pattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*)(?:\.vorton\.([1-9]\d*))?|-vorton\.([1-9]\d*))?$/;
const before = pattern.exec(previous);
const current = pattern.exec(root.version);
if (!before || !current)
  throw new Error("Expected a stable or beta base, optionally with a Vorton counter.");
const base = current.slice(1, 4).join(".") + (current[4] ? `-beta.${current[4]}` : "");
const oldBase = before.slice(1, 4).join(".") + (before[4] ? `-beta.${before[4]}` : "");
const currentParts = [
  ...current.slice(1, 4).map(Number),
  current[4] ? Number(current[4]) : Infinity,
];
const previousParts = [...before.slice(1, 4).map(Number), before[4] ? Number(before[4]) : Infinity];
const difference = currentParts.findIndex((n, i) => n !== previousParts[i]);
if (difference !== -1 && currentParts[difference] < previousParts[difference]) {
  throw new Error("The upstream base cannot decrease. Revert code under a newer Vorton version.");
}
const counter = base === oldBase ? Number(before[5] ?? before[6] ?? 0) + 1 : 1;
if (!Number.isSafeInteger(counter)) throw new Error("Vorton counter exceeds safe integer range.");
const next = `${base}${current[4] ? "." : "-"}vorton.${counter}`;
const files = [
  "package.json",
  ...root.workspaces.map((workspace) => `${workspace}/package.json`),
  "package-lock.json",
];
// A hook must never stage unrelated working-tree edits in these files.
if (mode === "--hook") {
  git("ls-files", "--error-unmatch", "--", ...files);
  const dirty = git("diff", "--name-only", "--", ...files);
  if (dirty) throw new Error(`Stage or stash manifest changes before committing:\n${dirty}`);
}
const packages = files.slice(0, -1).map((file) => [file, readJson(file)]);
const names = new Set(packages.map(([, pkg]) => pkg.name));
const lock = readJson("package-lock.json");
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
for (const [file, pkg] of packages) {
  pkg.version = next;
  for (const section of sections) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      if (names.has(name) && name !== pkg.name) pkg[section][name] = pkg.private ? "*" : next;
    }
  }
  const key = file === "package.json" ? "" : file.slice(0, -"/package.json".length);
  const entry = lock.packages[key];
  if (!entry) throw new Error(`Missing workspace lock entry: ${key}`);
  entry.version = next;
  for (const section of sections) {
    for (const name of Object.keys(entry[section] ?? {})) {
      if (names.has(name) && pkg[section]?.[name]) entry[section][name] = pkg[section][name];
    }
  }
}
lock.version = next;
packages.push(["package-lock.json", lock]);
if (mode === "--check") {
  for (const [file, expected] of packages) {
    const staged = JSON.parse(git("show", `:${file}`));
    if (JSON.stringify(staged) !== JSON.stringify(expected))
      throw new Error(`Stage synchronized version ${next}: ${file}`);
  }
} else {
  for (const [file, pkg] of packages) writeJson(file, pkg);
  if (mode === "--hook") git("add", "--", ...files);
}
console.log(`Vorton version: ${next}`);
