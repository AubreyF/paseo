import path from "node:path";
import { z } from "zod";
import type { DaemonConfigStore } from "../../server/daemon-config-store.js";

export class CodexAccountCreationError extends Error {}

const AccountEnvironmentSchema = z.object({ CODEX_HOME: z.string() });

/** A retry uses the same provider ID and home, including after a lost response or restart. */
export function createCodexAccount(input: {
  paseoHome: string;
  store: Pick<DaemonConfigStore, "get" | "patch">;
  creationId: string;
  name: string;
}): { providerId: string; name: string } {
  const creationId = z.string().uuid().parse(input.creationId);
  const name = input.name.trim();
  if (!name || name.length > 100)
    throw new CodexAccountCreationError("Enter an account name of 1 to 100 characters.");
  const providerId = `codex-account-${creationId}`;
  const home = path.join(input.paseoHome, "codex-accounts", providerId);
  const existing = input.store.get().providers[providerId];
  if (existing) {
    const env = AccountEnvironmentSchema.safeParse(existing.env);
    if (existing.extends !== "codex" || !env.success || env.data.CODEX_HOME !== home) {
      throw new CodexAccountCreationError("This account identifier is already in use.");
    }
    if (typeof existing.label !== "string")
      throw new CodexAccountCreationError("The account configuration has no name.");
    return { providerId, name: existing.label };
  }
  // The login session creates the directory. Never copy another account's credentials.
  input.store.patch({
    providers: {
      [providerId]: {
        extends: "codex",
        label: name,
        enabled: true,
        env: { CODEX_HOME: home },
      },
    },
  });
  return { providerId, name };
}
