/** Running Paseo child agents only, never native subagents or another daemon's queue. */
export function countRunningWorkers(
  agents: Iterable<{
    provider: string;
    lifecycle: string;
    parentId: string | undefined;
    hasRun?: boolean;
  }>,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    if ((agent.lifecycle !== "running" && !agent.hasRun) || !agent.parentId) continue;
    counts.set(agent.provider, (counts.get(agent.provider) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}
