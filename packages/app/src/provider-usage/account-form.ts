import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

export interface CreatedCodexAccount {
  providerId: string;
  name: string;
}
interface AccountFormPorts {
  initialName?: string;
  create(creationId: string, name: string): Promise<CreatedCodexAccount>;
  created?(account: CreatedCodexAccount): void;
}
type AccountFormState =
  | { phase: "editing"; name: string; error: string | null }
  | { phase: "creating"; name: string; error: null }
  | { phase: "created"; account: CreatedCodexAccount };

export function suggestedCodexAccountName(providers: MutableDaemonConfig["providers"]): string {
  return suggestedAccountName(providers, "codex");
}

export function suggestedAccountName(
  providers: MutableDaemonConfig["providers"],
  provider: "codex" | "claude",
): string {
  const label = provider === "claude" ? "Claude" : "Codex";
  const accounts = Object.entries(providers).filter(
    ([id, entry]) => id !== provider && entry.extends === provider,
  );
  const active = accounts.filter(([, entry]) => entry.enabled !== false);
  const names = new Set<string>();
  for (const [, entry] of accounts) {
    if (typeof entry.label === "string") names.add(entry.label.trim().toLowerCase());
  }
  let number = active.length + 1;
  while (names.has(`${label.toLowerCase()} ${number}`)) number += 1;
  return `${label} ${number}`;
}

export function openAccountForm(creationId: string, ports: AccountFormPorts) {
  let state: AccountFormState = { phase: "editing", name: ports.initialName ?? "", error: null };
  let closed = false;
  const listeners = new Set<() => void>();
  function publish(next: AccountFormState) {
    if (closed) return;
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    setName(name: string) {
      if (state.phase === "editing") publish({ phase: "editing", name, error: null });
    },
    async submit() {
      if (closed || state.phase !== "editing") return;
      const name = state.name.trim();
      if (!name || name.length > 100) {
        publish({
          phase: "editing",
          name: state.name,
          error: "Enter an account name of 1 to 100 characters.",
        });
        return;
      }
      publish({ phase: "creating", name, error: null });
      try {
        const account = await ports.create(creationId, name);
        if (closed) return;
        publish({ phase: "created", account });
        ports.created?.(account);
      } catch (error) {
        publish({
          phase: "editing",
          name,
          error:
            error instanceof Error
              ? error.message
              : "Account creation could not be confirmed. Try again.",
        });
      }
    },
  };
}
