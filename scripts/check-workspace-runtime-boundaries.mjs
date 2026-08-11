#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const SERVER_ROOT = "packages/server/src/server";
const FIXTURE_ROOT = "packages/fixture-workspace-runtime";
const migratedOwners = [
  "/session/files/",
  "/session/git-mutation/",
  "/session/provider/",
  "/session/workspace-git-observer/",
  "/session/workspace-provisioning/",
  "/session/workspace-scripts/",
];
const hostModules = new Set(["child_process", "fs", "fs/promises", "module", "which"]);

export async function findWorkspaceBoundaryViolations(repoRoot) {
  const files = [
    ...(await collectSources(path.join(repoRoot, SERVER_ROOT))),
    ...(await collectSources(path.join(repoRoot, FIXTURE_ROOT))),
  ];
  const modules = await Promise.all(
    files.map(async (filename) => {
      const source = await readFile(filename, "utf8");
      return { filename, sourceFile: parseSource(filename, source) };
    }),
  );
  const publicOwners = new Set(
    modules
      .filter(({ sourceFile }) => staticSpecifiers(sourceFile).some(isPublicEntryPoint))
      .map(({ filename }) => toRepoPath(repoRoot, filename)),
  );
  const violations = [];
  for (const { filename, sourceFile } of modules) {
    const importer = toRepoPath(repoRoot, filename);
    const external = importer.startsWith(`${FIXTURE_ROOT}/`);
    const governed =
      external ||
      (!isTestFile(importer) && (ownsMigratedSurface(importer) || publicOwners.has(importer)));
    for (const load of moduleLoads(sourceFile)) {
      if (load.specifier === null) {
        if (governed) violations.push(violation(importer, "<computed>", "nonliteral-module-load"));
        continue;
      }
      const specifier = load.specifier;
      if (isForbiddenInternal(importer, specifier)) {
        violations.push(violation(importer, specifier, "module-entrypoint"));
      }
      if (governed && !external && isHostCapability(specifier)) {
        violations.push(violation(importer, specifier, "workspace-host-access"));
      }
      if (external && isExternalEscape(importer, specifier)) {
        violations.push(violation(importer, specifier, "external-runtime-contract"));
      }
    }
  }
  return violations.sort((left, right) =>
    `${left.file}:${left.import}:${left.rule}`.localeCompare(
      `${right.file}:${right.import}:${right.rule}`,
    ),
  );
}

function parseSource(filename, source) {
  return ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function staticSpecifiers(sourceFile) {
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function moduleLoads(sourceFile) {
  const loads = [];
  visit(sourceFile);
  return loads;

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
      loads.push({ specifier: argument && ts.isStringLiteral(argument) ? argument.text : null });
    }
    ts.forEachChild(node, visit);
  }
}

function isPublicEntryPoint(specifier) {
  return /workspace-(?:runtime|helper)\/index\.(?:js|ts)$/.test(specifier);
}

function ownsMigratedSurface(importer) {
  return !isTestFile(importer) && migratedOwners.some((owner) => importer.includes(owner));
}

function isHostCapability(specifier) {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return (
    hostModules.has(normalized) || /(?:^|\/)utils\/run-git-command\.(?:js|ts)$/.test(normalized)
  );
}

function isForbiddenInternal(importer, specifier) {
  const target = resolveSpecifier(importer, specifier);
  if (!target || !target.includes("/internal/")) return false;
  if (target.includes("/workspace-runtime/command/internal/")) {
    return !(
      importer.endsWith("/workspace-runtime/command/index.ts") ||
      importer.includes("/workspace-runtime/command/internal/")
    );
  }
  if (target.includes("/workspace-runtime/git-observation/internal/")) {
    return !(
      importer.endsWith("/workspace-runtime/git-observation/index.ts") ||
      importer.includes("/workspace-runtime/git-observation/internal/") ||
      importer.endsWith("/workspace-runtime/internal/service.ts")
    );
  }
  if (target.includes("/workspace-runtime/internal/")) {
    return !(
      importer.endsWith("/workspace-runtime/index.ts") ||
      importer.includes("/workspace-runtime/internal/")
    );
  }
  if (target.includes("/workspace-helper/internal/")) {
    return !(
      importer.endsWith("/workspace-helper/index.ts") ||
      importer.includes("/workspace-helper/internal/") ||
      importer.endsWith("/workspace-runtime/internal/service.ts")
    );
  }
  return false;
}

function isExternalEscape(importer, specifier) {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (normalized === "module") return true;
  if (specifier.startsWith("node:") || hostModules.has(specifier) || specifier === "node-pty") {
    return false;
  }
  if (specifier === "@getpaseo/workspace-runtime-contract") return false;
  if (path.posix.isAbsolute(specifier) || specifier.startsWith("file:")) return true;
  if (specifier.startsWith(".")) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    return !target.startsWith(`${FIXTURE_ROOT}/`);
  }
  return (
    specifier === "@getpaseo/server" ||
    specifier.startsWith("@getpaseo/server/") ||
    specifier.includes("packages/server/") ||
    specifier.includes("/internal/")
  );
}

function resolveSpecifier(importer, specifier) {
  if (specifier.startsWith(".")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  }
  return specifier.replace(/^@getpaseo\/server\/?/, `${SERVER_ROOT}/`);
}

function isTestFile(filename) {
  return /\.(?:test|spec)\.[^.]+$/.test(filename);
}

function violation(file, imported, rule) {
  return {
    file,
    import: imported,
    rule,
    message: `${file}: ${rule} forbids ${imported}`,
  };
}

async function collectSources(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectSources(target);
      return [".js", ".mjs", ".ts", ".tsx"].includes(path.extname(entry.name)) ? [target] : [];
    }),
  );
  return nested.flat();
}

function toRepoPath(repoRoot, filename) {
  return path.relative(repoRoot, filename).split(path.sep).join("/");
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = await findWorkspaceBoundaryViolations(repoRoot);
  for (const item of violations) process.stderr.write(`${item.message}\n`);
  if (violations.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
