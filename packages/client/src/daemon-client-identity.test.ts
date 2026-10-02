import { expect, test } from "vitest";
import { DaemonClient, type DaemonTransport } from "./daemon-client.js";

class Peer {
  sent: Array<string | Uint8Array | ArrayBuffer> = [];
  closed = false;
  message: (data: unknown, binary: boolean) => void = () => {};
  opened: () => void = () => {};
  disconnected: (event?: unknown) => void = () => {};
  transport: DaemonTransport = {
    send: (data) => {
      this.sent.push(data);
    },
    close: () => {
      this.closed = true;
    },
    onMessage: (listener) => {
      this.message = listener;
      return () => {
        this.message = () => {};
      };
    },
    onOpen: (listener) => {
      this.opened = listener;
      return () => {};
    },
    onClose: (listener) => {
      this.disconnected = listener;
      return () => {};
    },
    onError: () => () => {},
  };
  identify(serverId: string) {
    this.message(
      JSON.stringify({
        type: "session",
        message: {
          type: "status",
          payload: {
            status: "server_info",
            serverId,
            hostname: null,
            version: null,
            features: { ownedSubscriptions: true },
          },
        },
      }),
      false,
    );
  }
}

test("a wrong environment identity never connects or delivers inbound messages", async () => {
  const peer = new Peer();
  const client = new DaemonClient({
    url: "ws://localhost/ws",
    clientId: "identity-test",
    expectedServerId: "container-id",
    reconnect: { enabled: false },
    transportFactory: () => peer.transport,
  });
  let delivered = 0;
  const unsubscribe = client.on("status", () => {
    delivered++;
  });
  const connecting = client.connect();
  const rejection = expect(connecting).rejects.toThrow("identity");
  peer.opened();
  peer.identify("host-id");
  await rejection;
  expect(peer.closed).toBe(true);
  expect(delivered).toBe(0);
  expect(client.getLastServerInfoMessage()).toBeNull();
  unsubscribe();
  await client.close();
});

test("identity is checked again on reconnect before restoring a session", async () => {
  const first = new Peer();
  const second = new Peer();
  let count = 0;
  const client = new DaemonClient({
    url: "ws://localhost/ws",
    clientId: "identity-test",
    expectedServerId: "container-id",
    reconnect: { enabled: false },
    transportFactory: () => (count++ === 0 ? first.transport : second.transport),
  });
  const connecting = client.connect();
  first.opened();
  first.identify("container-id");
  await connecting;
  expect(client.getLastServerInfoMessage()?.serverId).toBe("container-id");
  first.disconnected();
  const reconnecting = client.connect();
  const rejection = expect(reconnecting).rejects.toThrow("identity");
  second.opened();
  second.identify("host-id");
  await rejection;
  expect(second.closed).toBe(true);
  expect(client.getLastServerInfoMessage()).toBeNull();
  await client.close();
});
