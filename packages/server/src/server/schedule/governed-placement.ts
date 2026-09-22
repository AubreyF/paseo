import type { QuotaGovernedSessionInput } from "../agent/agent-sdk-types.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";

/** Read-only host boundary. Never infer membership from a directory or revive records. */
export function createGovernedPlacementValidator(input: {
  hostId: string;
  projects: Pick<ProjectRegistry, "get">;
  workspaces: Pick<WorkspaceRegistry, "get">;
}) {
  return async (session: QuotaGovernedSessionInput): Promise<void> => {
    const placement = session.placement;
    if (!placement || placement.hostId !== input.hostId)
      throw new Error("Governed workspace belongs to a different host.");
    const [project, workspace] = await Promise.all([
      input.projects.get(placement.projectId),
      input.workspaces.get(placement.workspaceId),
    ]);
    if (
      !project ||
      project.archivedAt ||
      project.projectId !== placement.projectId ||
      project.kind !== "git" ||
      project.rootPath !== placement.projectRoot ||
      project.projectKey !== placement.projectKey ||
      !workspace ||
      workspace.archivedAt ||
      workspace.workspaceId !== placement.workspaceId ||
      workspace.projectId !== placement.projectId ||
      workspace.cwd !== session.config.cwd
    )
      throw new Error("Governed workspace placement changed; reconciliation is required.");
  };
}
