export interface HostedConnectionDefaults {
  host: string;
  port: string;
  useTls: boolean;
}

/** Use the browser's alias, never the daemon's internal address or URL credentials. */
export function hostedConnectionDefaults(pageUrl: string): HostedConnectionDefaults | undefined {
  const url = new URL(pageUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port || (url.protocol === "https:" ? "443" : "80"),
    useTls: url.protocol === "https:",
  };
}
