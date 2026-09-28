import path from "node:path";
import { z } from "zod";
import type { DaemonConfigStore } from "../../server/daemon-config-store.js";

export class AccountCreationError extends Error {}

const AccountEnvironmentSchema = z.record(z.string(), z.string());

interface AccountCreationInput {
  paseoHome: string;
  store: Pick<DaemonConfigStore, "get" | "patch">;
  creationId: string;
  name: string;
}

export function createCodexAccount(input: AccountCreationInput) {
  return createAccount(input, "codex", "CODEX_HOME");
}

export function createClaudeAccount(input: AccountCreationInput) {
  return createAccount(input, "claude", "CLAUDE_CONFIG_DIR");
}

/** A retry uses the same provider ID and home, including after a lost response or restart. */
function createAccount(
  input: AccountCreationInput,
  provider: "codex" | "claude",
  homeVariable: "CODEX_HOME" | "CLAUDE_CONFIG_DIR",
): { providerId: string; name: string } {
  const creationId = z.string().uuid().parse(input.creationId);
  const name = input.name.trim();
  if (!name || name.length > 100)
    throw new AccountCreationError("Enter an account name of 1 to 100 characters.");
  const providerId = `${provider}-account-${creationId}`;
  const home = path.join(input.paseoHome, `${provider}-accounts`, providerId);
  const existing = input.store.get().providers[providerId];
  if (existing) {
    const env = AccountEnvironmentSchema.safeParse(existing.env);
    if (existing.extends !== provider || !env.success || env.data[homeVariable] !== home) {
      throw new AccountCreationError("This account identifier is already in use.");
    }
    if (typeof existing.label !== "string")
      throw new AccountCreationError("The account configuration has no name.");
    return { providerId, name: existing.label };
  }
  // The login session creates the directory. Never copy another account's credentials.
  input.store.patch({
    providers: {
      [providerId]: {
        extends: provider,
        label: name,
        enabled: true,
        env: { [homeVariable]: home },
      },
    },
  });
  return { providerId, name };
}
