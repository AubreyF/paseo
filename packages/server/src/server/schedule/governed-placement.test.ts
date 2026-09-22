import { expect, test, vi } from "vitest";
import { createGovernedPlacementValidator } from "./governed-placement.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";
import type { QuotaGovernedSessionInput } from "../agent/agent-sdk-types.js";

function fixture() {
  const project = createPersistedProjectRecord({
    projectId: "prj_product",
    rootPath: "/product",
    kind: "git",
    displayName: "Product",
    projectKey: "remote:github.com/example/product",
    createdAt: "2026-09-18T00:00:00Z",
    updatedAt: "2026-09-18T00:00:00Z",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "wks_task",
    projectId: project.projectId,
    cwd: "/isolated/task",
    kind: "directory",
    displayName: "Task",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
  const projects = { get: vi.fn(async () => project) };
  const workspaces = { get: vi.fn(async () => workspace) };
  const session: QuotaGovernedSessionInput = {
    config: { provider: "codex", cwd: workspace.cwd },
    account: { issuer: "openai", accountId: "fixture" },
    guard: async () => {
      throw new Error("No inference");
    },
    placement: {
      hostId: "srv_fixture",
      projectId: project.projectId,
      projectRoot: project.rootPath,
      projectKey: project.projectKey!,
      workspaceId: workspace.workspaceId,
    },
  };
  const validate = createGovernedPlacementValidator({
    hostId: "srv_fixture",
    projects,
    workspaces,
  });
  return { project, workspace, projects, workspaces, session, validate };
}

test("explicit membership allows an isolated checkout outside the project root", async () => {
  const f = fixture();
  await expect(f.validate(f.session)).resolves.toBeUndefined();
});

test("foreign host fails before registry lookup", async () => {
  const f = fixture();
  f.session.placement!.hostId = "srv_other";
  await expect(f.validate(f.session)).rejects.toThrow("different host");
  expect(f.projects.get).not.toHaveBeenCalled();
  expect(f.workspaces.get).not.toHaveBeenCalled();
});

test.each(["project archive", "workspace archive", "membership", "cwd", "repository", "root"])(
  "changed %s holds placement without mutation",
  async (change) => {
    const f = fixture();
    if (change === "project archive") f.project.archivedAt = f.project.createdAt;
    if (change === "workspace archive") f.workspace.archivedAt = f.workspace.createdAt;
    if (change === "membership") f.workspace.projectId = "prj_other";
    if (change === "cwd") f.workspace.cwd = "/other";
    if (change === "repository") f.project.projectKey = "remote:github.com/example/other";
    if (change === "root") f.project.rootPath = "/other";
    await expect(f.validate(f.session)).rejects.toThrow("reconciliation");
  },
);

test("removed records hold rather than being recreated", async () => {
  const f = fixture();
  const validate = createGovernedPlacementValidator({
    hostId: "srv_fixture",
    projects: { get: async () => null },
    workspaces: f.workspaces,
  });
  await expect(validate(f.session)).rejects.toThrow("reconciliation");
});
