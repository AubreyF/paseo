// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectOptionId, type ScheduleProjectTarget } from "./schedule-project-targets";
import { useScheduleFormModel } from "./use-schedule-form-model";
import type { ScheduleFormSnapshot } from "./schedule-form-model";

const HOSTS = [{ serverId: "host-a", label: "Host A" }] as const;
const PROJECT_A_ID = buildProjectOptionId("host-a", "project-a");

function projectTarget(input: {
  projectKey: string;
  projectName: string;
  cwd: string;
}): ScheduleProjectTarget {
  return {
    optionId: buildProjectOptionId("host-a", input.projectKey),
    serverId: "host-a",
    serverName: "Host A",
    projectViewKey: input.projectKey,
    projectName: input.projectName,
    cwd: input.cwd,
    isGit: true,
  };
}

function createSnapshot(projectTargets: readonly ScheduleProjectTarget[]): ScheduleFormSnapshot {
  return {
    mode: "create",
    hosts: HOSTS,
    defaults: {
      serverId: "host-a",
      projectTargets,
      preferences: {},
    },
  };
}

describe("useScheduleFormModel", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps one model instance and draft state while open snapshot inputs churn", () => {
    const firstTargets = [
      projectTarget({ projectKey: "project-a", projectName: "Project A", cwd: "/repo/a" }),
    ];
    const { result, rerender } = renderHook(({ snapshot }) => useScheduleFormModel(snapshot), {
      initialProps: { snapshot: createSnapshot(firstTargets) },
    });
    const openedModel = result.current;

    act(() => {
      openedModel.setName("Draft name");
      openedModel.setPrompt("Run the draft");
      openedModel.setProject(PROJECT_A_ID, { label: "Project A" });
    });

    rerender({
      snapshot: createSnapshot([
        projectTarget({ projectKey: "project-a", projectName: "Project A", cwd: "/repo/a" }),
      ]),
    });

    expect(result.current).toBe(openedModel);
    expect(result.current.getState()).toMatchObject({
      name: "Draft name",
      prompt: "Run the draft",
      selectedServerId: "host-a",
      workingDir: "/repo/a",
      projectDisplay: { label: "Project A" },
      selectedProjectOptionId: PROJECT_A_ID,
    });
  });
  it("retains the opened revision with draft fields across background record refreshes", () => {
    const snapshot: ScheduleFormSnapshot = {
      ...createSnapshot([]),
      mode: "edit",
      schedule: {
        id: "schedule",
        name: "Original",
        prompt: "Original prompt",
        configurationRevision: "opened-revision",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent", config: { provider: "codex-secondary", cwd: "/repo" } },
        status: "active",
        createdAt: "2026-09-14T00:00:00Z",
        updatedAt: "2026-09-14T00:00:00Z",
        nextRunAt: null,
        lastRunAt: null,
        pausedAt: null,
        maxRuns: null,
        expiresAt: null,
      },
    };
    const { result, rerender, unmount } = renderHook(
      ({ current }) => useScheduleFormModel(current),
      {
        initialProps: { current: snapshot },
      },
    );
    act(() => result.current.setPrompt("Owner draft"));
    const refreshed: ScheduleFormSnapshot = {
      ...snapshot,
      schedule: {
        ...snapshot.schedule!,
        configurationRevision: "newer-revision",
        prompt: "Other editor",
      },
    };
    rerender({ current: refreshed });
    expect(result.current.getState()).toMatchObject({
      initialConfigurationRevision: "opened-revision",
      prompt: "Owner draft",
    });
    unmount();
    const reopened = renderHook(() => useScheduleFormModel(refreshed));
    expect(reopened.result.current.getState()).toMatchObject({
      initialConfigurationRevision: "newer-revision",
      prompt: "Other editor",
    });
  });
});
