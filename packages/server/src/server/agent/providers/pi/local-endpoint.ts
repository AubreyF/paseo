import net from "node:net";
import type { AgentModelDefinition } from "../../agent-sdk-types.js";

/** Only probe explicit loopback/private endpoints. Never infer that Pi means local. */
export function localEndpointAddress(baseUrl: string | undefined): URL | null {
  if (!baseUrl) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const parts = host.split(".").map(Number);
  const privateV4 =
    net.isIPv4(host) &&
    (parts[0] === 127 ||
      parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168));
  return privateV4 || host === "::1" || host === "localhost" || host === "host.docker.internal"
    ? url
    : null;
}

/** TCP reachability only. No inference, authentication request, or capacity claim. */
export async function probeLocalEndpoint(
  url: URL,
  signal?: AbortSignal,
): Promise<NonNullable<AgentModelDefinition["localEndpoint"]>> {
  const reachable = await new Promise<boolean>((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const socket = net.createConnection({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      // eslint-disable-next-line promise/no-multiple-resolved -- The settled guard makes competing socket, deadline and abort callbacks single-shot.
      resolve(value);
    };
    const abort = () => finish(false);
    signal?.addEventListener("abort", abort, { once: true });
    // A wall-clock bound also covers DNS lookup, unlike socket inactivity timeout.
    const timeout = setTimeout(() => finish(false), 500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
  return { status: reachable ? "reachable" : "unreachable", checkedAt: new Date().toISOString() };
}
