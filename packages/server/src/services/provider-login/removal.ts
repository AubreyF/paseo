import type { ProviderRemovalPlan } from "@getpaseo/protocol/provider-removal";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";

export class ProviderRemovalError extends Error {}

interface RemovalInput {
  paseoHome: string;
  providers: MutableDaemonConfig["providers"];
  providerId: string;
  defaultCodexHome: string;
}

// Resolve existing ancestors too: an absent child under a symlink still belongs
// to the symlink target, not to the apparent managed directory.
function canonicalPath(location: string): string {
  const absolute = path.resolve(location);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  return path.join(canonicalPath(parent), path.basename(absolute));
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
}

function accountHome(input: RemovalInput): string | null {
  const configured = input.providers[input.providerId];
  if (!configured)
    throw new ProviderRemovalError("This provider was already removed. Refresh the provider list.");
  const provider = ProviderOverrideSchema.parse(configured);
  if (!provider.extends)
    throw new ProviderRemovalError("Built-in providers can be disabled, but cannot be deleted.");
  if (provider.extends !== "codex") return null;
  return provider.env?.CODEX_HOME ?? input.defaultCodexHome;
}

export function planProviderRemoval(input: RemovalInput): ProviderRemovalPlan {
  const home = accountHome(input);
  const provider = ProviderOverrideSchema.parse(input.providers[input.providerId]);
  const sharedWith: string[] = [];
  let credentials: ProviderRemovalPlan["credentials"] = "external";
  let canonicalHome: string | null = null;
  if (home) {
    canonicalHome = canonicalPath(home);
    const root = path.join(canonicalPath(input.paseoHome), "codex-accounts");
    const inManagedRoot = path.dirname(canonicalHome) === root;
    const isAccountDirectory =
      /^codex-account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        path.basename(canonicalHome),
      );
    if (inManagedRoot && isAccountDirectory) credentials = "managed";
    for (const [id, configured] of Object.entries(input.providers)) {
      if (id === input.providerId) continue;
      const candidate = ProviderOverrideSchema.parse(configured);
      const candidateHome = candidate.env?.CODEX_HOME;
      const usesDefault = id === "codex" || candidate.extends === "codex";
      const otherHome = candidateHome ?? (usesDefault ? input.defaultCodexHome : null);
      if (otherHome && overlaps(canonicalHome, canonicalPath(otherHome)))
        sharedWith.push(candidate.label ?? id);
    }
    // Built-ins may be absent from the override map while still using the host's CLI home.
    if (!input.providers.codex && overlaps(canonicalHome, canonicalPath(input.defaultCodexHome)))
      sharedWith.push("Codex");
    if (sharedWith.length > 0) credentials = "shared";
  }
  const revision = createHash("sha256")
    .update(JSON.stringify({ providers: input.providers, canonicalHome, credentials, sharedWith }))
    .digest("hex");
  return {
    providerId: input.providerId,
    name: provider.label ?? input.providerId,
    credentials,
    sharedWith,
    revision,
  };
}

/** Call only after provider processes and sign-in have stopped, then remove config.
 * A cleanup failure leaves the connection present so the user can retry. */
export function deleteManagedProviderCredentials(
  input: RemovalInput,
  expectedRevision: string,
): ProviderRemovalPlan {
  const plan = planProviderRemoval(input);
  if (plan.revision !== expectedRevision)
    throw new ProviderRemovalError("Provider settings changed. Review deletion again.");
  if (plan.credentials !== "managed") return plan;
  const home = accountHome(input);
  if (!home) throw new ProviderRemovalError("The account directory is unavailable.");
  // Refuse a final-component symlink even when it points back inside the managed root.
  // Otherwise unlinking it would leave the actual credential directory behind.
  if (existsSync(home) && lstatSync(home).isSymbolicLink())
    throw new ProviderRemovalError(
      "The account directory is a symbolic link. Remove its credentials manually.",
    );
  rmSync(home, { recursive: true, force: true });
  return plan;
}
