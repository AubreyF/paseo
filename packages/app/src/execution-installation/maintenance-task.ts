import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";

export function maintenanceTaskTarget(
  installation: ExecutionInstallation | null,
  serverIds: readonly string[],
): string {
  const host = installation?.environments.find((environment) => environment.kind === "host");
  if (!host || !serverIds.includes(host.serverId)) {
    throw new Error(
      "Connect this installation's host environment before preparing an update task.",
    );
  }
  return host.serverId;
}

export function installationMaintenancePrompt(prompt: string): string {
  return `${prompt}\n\nExecution and installation boundaries\nThis task is explicitly targeted at the trusted native host environment. Inspect the installation record and both daemon identities. Preserve the running development container and unrelated work. Build a reviewed release outside guest-writable directories; do not execute the installed host service from a shared development checkout. Use the installation-maintenance skill to request any necessary restart, wait for owner approval of that exact request, and verify its durable readiness result. Do not bypass the coordinator with shell restarts or recreate the primary container. Report source, installed release, remote publication, and real-device acceptance separately.`;
}
