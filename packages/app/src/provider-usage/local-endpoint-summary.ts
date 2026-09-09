export function formatLocalEndpointSummary(
  endpoint: { status: "reachable" | "unreachable"; checkedAt: string } | undefined,
  now = Date.now(),
): string | null {
  if (!endpoint) return null;
  const age = now - Date.parse(endpoint.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > 120_000) return "Local endpoint status stale";
  return endpoint.status === "reachable"
    ? "Local endpoint reachable"
    : "Local endpoint unreachable";
}

export function formatWorkerActivity(
  activity: { checkedAt: string; runningByProvider: Record<string, number> } | undefined,
  provider: string,
  now = Date.now(),
): string {
  if (!activity) return "Worker activity unavailable";
  const age = now - Date.parse(activity.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > 30_000) return "Worker activity stale";
  const count = activity.runningByProvider[provider] ?? 0;
  return `${count} running provider ${count === 1 ? "worker" : "workers"}`;
}
