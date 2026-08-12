import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { ProviderWorkspace } from "../agent/providers/workspace/index.js";
import type {
  CreateWorkspaceInput,
  WorkspaceRuntimeInspection,
  WorkspaceRuntimePlacement,
} from "../workspace-runtime/index.js";
import { createProviderProbeService } from "./index.js";

const roots: string[] = [];
const posixDescribe = describe.runIf(process.platform !== "win32");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

posixDescribe("provider probe service", () => {
  test("converges concurrent ensures on one deterministic persisted runtime create", async () => {
    const fixture = await createFixture();
    let releaseCreate!: () => void;
    const createBarrier = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    fixture.runtime.create = async (input) => {
      fixture.creates.push(input);
      await createBarrier;
      fixture.inspection = { status: "ready", cwd: fixture.projectRoot };
      await fixture.service.records.persistRuntimeId(input.workspaceId, input.runtimeId, {
        cwd: fixture.projectRoot,
      });
      return placement(input, fixture.projectRoot);
    };

    const first = fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    const second = fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    releaseCreate();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.workspaceId).toMatch(/^wksprobe_[a-f0-9]{32}$/u);
    expect(fixture.creates).toHaveLength(1);
    expect(fixture.creates[0]).toEqual({
      workspaceId: firstResult.workspaceId,
      runtimeId: "fixture",
      project: {
        id: "project-1",
        source: { kind: "host-directory", path: fixture.projectRoot },
      },
      placement: { kind: "existing" },
      purpose: "provider-probe",
      setupFromPaseoConfig: false,
    });
    await expect(fixture.service.records.resolveRuntimeId(firstResult.workspaceId)).resolves.toBe(
      "fixture",
    );
  });

  test("reuses persisted ready identity and resolves only probe provider workspaces", async () => {
    const first = await createFixture();
    const ensured = await first.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    const reopened = createService(first);

    first.inspection = { status: "ready", cwd: first.projectRoot };
    await expect(
      reopened.ensure({ projectId: "project-1", runtimeId: "fixture" }),
    ).resolves.toEqual(ensured);
    expect(first.creates).toHaveLength(1);
    await expect(reopened.resolveProviderWorkspace(ensured.workspaceId)).resolves.toBe(
      first.providerWorkspace,
    );
    await expect(reopened.resolveProviderWorkspace("ordinary-workspace")).resolves.toBeNull();
  });

  test("removes a failed materialization so an explicit retry can create again", async () => {
    const fixture = await createFixture();
    fixture.runtime.create = async (input) => {
      fixture.creates.push(input);
      if (fixture.creates.length === 1) throw new Error("fixture materialization failed");
      fixture.inspection = { status: "ready", cwd: fixture.projectRoot };
      await fixture.service.records.persistRuntimeId(input.workspaceId, input.runtimeId, {
        cwd: fixture.projectRoot,
      });
      return placement(input, fixture.projectRoot);
    };

    await expect(
      fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" }),
    ).rejects.toThrow("fixture materialization failed");
    await expect(
      fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" }),
    ).resolves.toMatchObject({ workspaceId: expect.stringMatching(/^wksprobe_/u) });
    expect(fixture.creates).toHaveLength(2);
  });

  test("recreation replaces a persisted stale fingerprint with the freshly computed value", async () => {
    const fixture = await createFixture();
    const ensured = await fixture.service.ensure({ projectId: "project-1", runtimeId: "fixture" });
    const recordsPath = path.join(fixture.root, "provider-probes.json");
    const [record] = JSON.parse(await readFile(recordsPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    await writeFile(
      recordsPath,
      `${JSON.stringify([{ ...record, fingerprint: "stale", status: "materializing" }], null, 2)}\n`,
    );
    fixture.inspection = { status: "missing" };
    const reopened = createService(fixture);

    await reopened.ensure({ projectId: "project-1", runtimeId: "fixture" });

    const [recreated] = JSON.parse(await readFile(recordsPath, "utf8")) as Array<{
      workspaceId: string;
      fingerprint: string;
    }>;
    expect(recreated.workspaceId).toBe(ensured.workspaceId);
    expect(recreated.fingerprint).not.toBe("stale");
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-provider-probe-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  let inspection: WorkspaceRuntimeInspection = { status: "missing" };
  const creates: CreateWorkspaceInput[] = [];
  const providerWorkspace = { cwd: "." } as ProviderWorkspace;
  const runtime = {
    create: async (input: CreateWorkspaceInput) => {
      creates.push(input);
      inspection = { status: "ready", cwd: projectRoot };
      await service.records.persistRuntimeId(input.workspaceId, input.runtimeId, {
        cwd: projectRoot,
      });
      return placement(input, projectRoot);
    },
    inspect: async () => inspection,
    resume: async () => {},
  };
  const fixture = {
    root,
    projectRoot,
    creates,
    providerWorkspace,
    runtime,
    get inspection() {
      return inspection;
    },
    set inspection(value: WorkspaceRuntimeInspection) {
      inspection = value;
    },
    service: undefined as unknown as ReturnType<typeof createProviderProbeService>,
  };
  const service = createService(fixture);
  fixture.service = service;
  return fixture;
}

function createService(fixture: {
  root: string;
  projectRoot: string;
  providerWorkspace: ProviderWorkspace;
  runtime: {
    create(input: CreateWorkspaceInput): Promise<WorkspaceRuntimePlacement>;
    inspect(workspaceId: string): Promise<WorkspaceRuntimeInspection>;
    resume(workspaceId: string): Promise<void>;
  };
}) {
  return createProviderProbeService({
    filePath: path.join(fixture.root, "provider-probes.json"),
    logger: pino({ enabled: false }),
    projects: {
      get: async (projectId: string) =>
        projectId === "project-1"
          ? { projectId, rootPath: fixture.projectRoot, updatedAt: "2026-08-12T00:00:00.000Z" }
          : null,
    },
    runtime: fixture.runtime,
    runtimeConfiguration: { fixture: { type: "command", options: { sentinel: true } } },
    bindWorkspaceProviderCapability: async () => fixture.providerWorkspace,
  });
}

function placement(input: CreateWorkspaceInput, cwd: string): WorkspaceRuntimePlacement {
  return { workspaceId: input.workspaceId, runtimeId: input.runtimeId, cwd };
}
