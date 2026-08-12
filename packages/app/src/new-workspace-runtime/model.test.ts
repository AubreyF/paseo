import { describe, expect, test } from "vitest";
import type { WorkspaceRuntimeCatalogEntry } from "@getpaseo/protocol/messages";

import { resolveWorkspaceRuntimeSelection, runtimeLabel } from "./model";

const LOCAL: WorkspaceRuntimeCatalogEntry = {
  runtimeId: "local",
  builtin: true,
  requiresGitProject: false,
};
const WORKTREE: WorkspaceRuntimeCatalogEntry = {
  runtimeId: "worktree",
  builtin: true,
  requiresGitProject: true,
};
const FIXTURE: WorkspaceRuntimeCatalogEntry = {
  runtimeId: "fixture",
  builtin: false,
  label: "Fixture",
  requiresGitProject: true,
};

describe("new workspace runtime selection", () => {
  test("keeps the exact legacy isolation vocabulary when the runtime feature is absent", () => {
    const selection = resolveWorkspaceRuntimeSelection({
      catalog: { status: "legacy" },
      selectedRuntimeId: "worktree",
      supportsMultiplicity: true,
      worktreeSupport: "supported",
    });

    expect(selection).toMatchObject({
      runtimeId: "worktree",
      vocabulary: "isolation",
      canCreateWorkspace: true,
    });
    const translate = (key: string) =>
      ({
        "newWorkspace.isolation.local": "Local",
        "newWorkspace.isolation.worktree": "New worktree",
      })[key] ?? key;
    expect(runtimeLabel(LOCAL, selection.vocabulary, translate)).toBe("Local");
    expect(runtimeLabel(WORKTREE, selection.vocabulary, translate)).toBe("New worktree");
  });

  test.each([
    { catalog: { status: "loading" } as const, expectedError: null },
    {
      catalog: { status: "error", error: "Runtime catalog failed" } as const,
      expectedError: "Runtime catalog failed",
    },
  ])(
    "preserves a remembered runtime and gates creation while the catalog is $catalog.status",
    ({ catalog, expectedError }) => {
      expect(
        resolveWorkspaceRuntimeSelection({
          catalog,
          selectedRuntimeId: "fixture",
          supportsMultiplicity: true,
          worktreeSupport: "supported",
        }),
      ).toMatchObject({
        runtimeId: "fixture",
        availableRuntimes: [],
        canCreateWorkspace: false,
        catalogError: expectedError,
        vocabulary: "runtime",
      });
    },
  );

  test("omits disabled Docker from the selector after authoritative catalog resolution", () => {
    const selection = resolveWorkspaceRuntimeSelection({
      catalog: { status: "ready", runtimes: [LOCAL, WORKTREE, FIXTURE] },
      selectedRuntimeId: "docker",
      supportsMultiplicity: true,
      worktreeSupport: "supported",
    });

    expect(selection.runtimeId).toBe("local");
    expect(selection.availableRuntimes.map((runtime) => runtime.runtimeId)).toEqual([
      "local",
      "worktree",
      "fixture",
    ]);
    expect(selection.canCreateWorkspace).toBe(true);
    expect(
      runtimeLabel(WORKTREE, selection.vocabulary, (key) =>
        key === "newWorkspace.runtime.worktree" ? "Worktree" : key,
      ),
    ).toBe("Worktree");
  });
});
