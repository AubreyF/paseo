import { expect, it } from "vitest";
import {
  notifyOutboxChange,
  watchOutboxChanges,
  type OutboxNotice,
} from "./outbox-notifications.web";

it("receives another tab's durable changes without rebroadcasting them", async () => {
  const received: OutboxNotice[] = [];
  const echoed: unknown[] = [];
  const stop = watchOutboxChanges((notice) => received.push(notice));
  const otherTab = new BroadcastChannel("paseo-message-outbox");
  otherTab.addEventListener("message", ({ data }) => echoed.push(data));
  try {
    // BroadcastChannel has no targetOrigin argument.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    otherTab.postMessage({ serverId: "host", flush: true });
    await expect.poll(() => received).toEqual([{ serverId: "host", flush: true }]);
    notifyOutboxChange("host", false);
    await expect.poll(() => echoed).toEqual([{ serverId: "host", flush: false }]);
    expect(received).toEqual([
      { serverId: "host", flush: true },
      { serverId: "host", flush: false },
    ]);
  } finally {
    stop();
    otherTab.close();
  }
});

it("recovers on foreground and removes listeners when the last host unmounts", () => {
  const received: OutboxNotice[] = [];
  const stop = watchOutboxChanges((notice) => received.push(notice));
  window.dispatchEvent(new Event("focus"));
  expect(received).toEqual([{ serverId: null, flush: true }]);
  stop();
  window.dispatchEvent(new Event("focus"));
  expect(received).toHaveLength(1);
});
