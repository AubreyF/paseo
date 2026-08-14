import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";

export async function resolveCommand(
  workspaceRoot,
  name,
  {
    environment = process.env,
    executablePath = process.execPath,
    platform = process.platform,
  } = {},
) {
  if (!name) throw new Error("--name is required");
  if (name.includes("/") || (platform === "win32" && name.includes("\\"))) {
    const candidate = path.isAbsolute(name) ? name : path.resolve(workspaceRoot, name);
    return resolveFirstExecutable(executableCandidates(candidate, platform, environment));
  }
  const searchPath = environment.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const directory of new Set([path.dirname(executablePath), ...searchPath.split(delimiter)])) {
    const resolved = await resolveFirstExecutable(
      executableCandidates(path.join(directory, name), platform, environment),
    );
    if (resolved) return resolved;
  }
  return null;
}

function executableCandidates(candidate, platform, environment) {
  if (platform !== "win32") return [candidate];
  const extensions = (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidateExtension = path.extname(candidate).toLowerCase();
  if (extensions.some((extension) => extension.toLowerCase() === candidateExtension)) {
    return [candidate];
  }
  return [candidate, ...extensions.map((extension) => `${candidate}${extension}`)];
}

async function resolveFirstExecutable(candidates) {
  for (const candidate of candidates) {
    const resolved = await resolveExecutable(candidate);
    if (resolved) return resolved;
  }
  return null;
}

async function resolveExecutable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return await realpath(candidate);
  } catch {
    return null;
  }
}
