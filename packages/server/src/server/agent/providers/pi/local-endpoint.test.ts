import net from "node:net";
import { expect, test } from "vitest";
import { localEndpointAddress, probeLocalEndpoint } from "./local-endpoint.js";

test("only explicit private and loopback HTTP endpoints qualify", () => {
  for (const input of [
    undefined,
    "bad",
    "https://api.example.com/v1",
    "https://8.8.8.8",
    "file:///tmp/model",
    "http://172.32.0.1",
  ]) {
    expect(localEndpointAddress(input)).toBeNull();
  }
  for (const input of [
    "http://localhost:8000/v1",
    "http://host.docker.internal:8000/v1",
    "https://[::1]",
    "http://127.0.0.1",
    "http://10.1.2.3",
    "http://192.168.1.2",
    "http://172.31.1.2",
  ]) {
    expect(localEndpointAddress(input)).not.toBeNull();
  }
});

test("reports actual TCP reachability without sending an inference request", async () => {
  let receivedBytes = 0;
  const server = net.createServer((socket) =>
    socket.on("data", (data) => {
      receivedBytes += data.length;
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const url = new URL(`http://127.0.0.1:${address.port}/v1`);
  try {
    expect((await probeLocalEndpoint(url)).status).toBe("reachable");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
  }
  expect(receivedBytes).toBe(0);
  expect((await probeLocalEndpoint(url)).status).toBe("unreachable");
});

test("an aborted catalog does not connect", async () => {
  const signal = AbortSignal.abort();
  expect((await probeLocalEndpoint(new URL("http://127.0.0.1:1"), signal)).status).toBe(
    "unreachable",
  );
});
