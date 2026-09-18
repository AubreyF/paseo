export interface CreatedCodexAccount {
  providerId: string;
  name: string;
}
interface AccountFormPorts {
  create(creationId: string, name: string): Promise<CreatedCodexAccount>;
  created?(account: CreatedCodexAccount): void;
}
type AccountFormState =
  | { phase: "editing"; name: string; error: string | null }
  | { phase: "creating"; name: string; error: null }
  | { phase: "created"; account: CreatedCodexAccount };

export function openAccountForm(creationId: string, ports: AccountFormPorts) {
  let state: AccountFormState = { phase: "editing", name: "", error: null };
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
