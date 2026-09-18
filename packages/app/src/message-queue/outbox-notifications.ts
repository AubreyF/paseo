import { AppState } from "react-native";

export interface OutboxNotice {
  serverId: string | null;
  flush: boolean;
}
const listeners = new Set<(notice: OutboxNotice) => void>();

export function watchOutboxChanges(listener: (notice: OutboxNotice) => void): () => void {
  listeners.add(listener);
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") listener({ serverId: null, flush: true });
  });
  return () => {
    listeners.delete(listener);
    subscription.remove();
  };
}

export function notifyOutboxChange(serverId: string, flush: boolean): void {
  for (const listener of listeners) listener({ serverId, flush });
}
