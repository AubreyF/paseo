export interface OutboxNotice {
  serverId: string | null;
  flush: boolean;
}

const listeners = new Set<(notice: OutboxNotice) => void>();
let channel: BroadcastChannel | null = null;

function receive(notice: OutboxNotice): void {
  for (const listener of listeners) listener(notice);
}

function foreground(): void {
  if (document.visibilityState === "visible") receive({ serverId: null, flush: true });
}

export function watchOutboxChanges(listener: (notice: OutboxNotice) => void): () => void {
  if (!listeners.size) {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel("paseo-message-outbox");
      channel.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
        if (!data || typeof data !== "object") return;
        const notice = data as Partial<OutboxNotice>;
        if (typeof notice.serverId === "string" && typeof notice.flush === "boolean")
          receive({ serverId: notice.serverId, flush: notice.flush });
      });
    }
    window.addEventListener("focus", foreground);
    window.addEventListener("online", foreground);
    document.addEventListener("visibilitychange", foreground);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    channel?.close();
    channel = null;
    window.removeEventListener("focus", foreground);
    window.removeEventListener("online", foreground);
    document.removeEventListener("visibilitychange", foreground);
  };
}

export function notifyOutboxChange(serverId: string, flush: boolean): void {
  const notice = { serverId, flush };
  receive(notice);
  // Notifications are hints. IndexedDB remains the authority, and foreground
  // recovery works even when broadcasting is unavailable.
  try {
    // BroadcastChannel is origin-scoped and has no targetOrigin argument.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    channel?.postMessage(notice);
  } catch {
    /* Storage already committed. */
  }
}
