import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import { getE2EDaemonPort } from "./daemon-port";
import { waitForConnectedHost } from "./hosts";
import {
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  submitNewWorkspaceEmpty,
} from "./new-workspace";
import { connectSeedClient } from "./seed-client";
import { getServerId } from "./server-id";
import { getTerminalBufferText } from "./terminal-perf";
import { createTempDirectory, createTempGitRepo } from "./workspace";
import { clickFirstTerminalTab } from "./workspace-tabs";

export interface SeededRuntimeProject {
  projectId: string;
  projectKey: string;
  projectDisplayName: string;
  sourceDirectory: string;
  cleanup(): Promise<void>;
}

interface HostDecoySnapshot {
  content: string;
  mtimeMs: number;
}

export interface SeededDockerRuntimeProject extends SeededRuntimeProject {
  hostMutationPath: string;
  expectHostDecoysUntouched(): Promise<void>;
  mutateHostAfterDockerCreation(): Promise<void>;
}

const run = promisify(execFile);
const DOCKER_CREATED_FILE = "made-in-container.txt";
const DOCKER_SCRIPT_FILE = "workspace-script-output.txt";
const DOCKER_AGENT_FILE = "stdio-agent-output.txt";
const DOCKER_RUNTIME_LABELS = {
  runtime: "sh.paseo.runtime",
  runtimeOwner: "sh.paseo.runtime-owner",
  workspaceId: "sh.paseo.workspace-id",
} as const;

const SETUP_MARKER = "runtime-user-setup-ran.txt";

export async function seedGitProjectForRuntime(
  options?: Parameters<typeof createTempGitRepo>[1],
): Promise<SeededRuntimeProject> {
  const repo = await createTempGitRepo("runtime-selector-", {
    ...options,
    paseoConfig: options?.paseoConfig ?? {
      worktree: { setup: [`printf setup > ${SETUP_MARKER}`] },
    },
  });
  return seedRuntimeProject(repo);
}

export async function seedGitProjectWithDockerDecoys(): Promise<SeededDockerRuntimeProject> {
  const repo = await createTempGitRepo("runtime-docker-", {
    paseoConfig: {
      worktree: {
        setup: ['node -e "setTimeout(() => {}, 65000)"'],
      },
      scripts: {
        "docker-proof": {
          command: "pwd > workspace-script-output.txt; sleep 10",
        },
      },
    },
    files: [
      { path: "committed.txt", content: "committed host baseline\n" },
      { path: "provider-model.txt", content: "docker-fixture-model\n" },
      { path: "host-mutation.txt", content: "committed before Docker creation\n" },
    ],
  });
  const decoyContents = new Map([
    [DOCKER_CREATED_FILE, "host decoy: terminal must not overwrite this\n"],
    [DOCKER_SCRIPT_FILE, "host decoy: script must not overwrite this\n"],
    [DOCKER_AGENT_FILE, "host decoy: agent must not overwrite this\n"],
  ]);
  for (const [name, content] of decoyContents) {
    await writeFile(path.join(repo.path, name), content);
  }
  const snapshots = new Map<string, HostDecoySnapshot>();
  for (const name of decoyContents.keys()) {
    const filePath = path.join(repo.path, name);
    const metadata = await stat(filePath);
    snapshots.set(name, { content: await readFile(filePath, "utf8"), mtimeMs: metadata.mtimeMs });
  }
  const project = await seedRuntimeProject(repo);
  return {
    ...project,
    hostMutationPath: path.join(repo.path, "host-mutation.txt"),
    mutateHostAfterDockerCreation: async () => {
      await writeFile(
        path.join(repo.path, "host-mutation.txt"),
        "host changed after Docker creation\n",
      );
    },
    expectHostDecoysUntouched: async () => {
      for (const [name, snapshot] of snapshots) {
        const filePath = path.join(repo.path, name);
        const metadata = await stat(filePath);
        expect(await readFile(filePath, "utf8"), `${name} host decoy content`).toBe(
          snapshot.content,
        );
        expect(metadata.mtimeMs, `${name} host decoy mtime`).toBe(snapshot.mtimeMs);
      }
    },
  };
}

async function readProbeRecords(projectId: string): Promise<Array<{ workspaceId: string }>> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
  const records = JSON.parse(
    await readFile(path.join(paseoHome, "projects", "provider-probes.json"), "utf8"),
  ) as Array<{ workspaceId: string; projectId: string }>;
  return records.filter((record) => record.projectId === projectId);
}

async function markerExists(root: string): Promise<boolean> {
  return access(path.join(root, SETUP_MARKER)).then(
    () => true,
    () => false,
  );
}

export async function expectProbeSkippedProjectSetup(project: SeededRuntimeProject): Promise<void> {
  expect(await markerExists(project.sourceDirectory)).toBe(false);
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
  const probeIds = new Set(
    (await readProbeRecords(project.projectId)).map((record) => record.workspaceId),
  );
  const stateDirectory = path.join(paseoHome, "fixture-runtime");
  const stateFiles = await readdir(stateDirectory);
  const states = await Promise.all(
    stateFiles.map(
      async (file) =>
        JSON.parse(await readFile(path.join(stateDirectory, file), "utf8")) as {
          workspaceId: string;
          root: string;
        },
    ),
  );
  const probe = states.find((state) => probeIds.has(state.workspaceId));
  expect(probe, "fixture probe runtime state").toBeDefined();
  expect(await markerExists(probe!.root)).toBe(false);
}

export async function expectUserWorkspaceRanProjectSetup(
  project: SeededRuntimeProject,
): Promise<void> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
  const records = JSON.parse(
    await readFile(path.join(paseoHome, "projects", "workspaces.json"), "utf8"),
  ) as Array<{ projectId: string; workspaceId: string; runtime?: { runtimeId: string } }>;
  const workspace = records.find(
    (record) => record.projectId === project.projectId && record.runtime?.runtimeId === "fixture",
  );
  expect(workspace, "fixture user workspace record").toBeDefined();
  const stateFiles = await readdir(path.join(paseoHome, "fixture-runtime"));
  const states = await Promise.all(
    stateFiles.map(
      async (file) =>
        JSON.parse(await readFile(path.join(paseoHome, "fixture-runtime", file), "utf8")) as {
          workspaceId: string;
          root: string;
        },
    ),
  );
  const state = states.find((candidate) => candidate.workspaceId === workspace!.workspaceId);
  expect(state, "fixture user runtime state").toBeDefined();
  expect(await markerExists(state!.root)).toBe(true);
}

export async function expectProviderAvailable(page: Page, providerLabel: string): Promise<void> {
  const trigger = page.getByRole("button", { name: /Select model/ });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Back", exact: true }).click();
  await page.getByText(providerLabel, { exact: true }).click();
  await expect(page.getByRole("button", { name: `Open ${providerLabel} settings` })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

export async function selectRuntimeProviderModel(
  page: Page,
  input: { provider: string; model: string },
): Promise<void> {
  const trigger = page.getByRole("button", { name: /Select model/ });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByText(input.provider, { exact: true }).click();
  const model = dialog.getByText(input.model, { exact: true });
  await expect(model).toBeVisible({ timeout: 30_000 });
  await model.click();
  await expect(trigger).toContainText(input.model);
}

export async function expectRuntimeProviderUnavailable(
  page: Page,
  providerLabel: string,
): Promise<void> {
  const trigger = page.getByRole("button", { name: /Select model/ });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  const providerId = providerLabel.toLowerCase().replaceAll(" ", "");
  const providerRow = dialog.getByTestId(`model-provider-${providerId}`);
  await expect(providerRow).toBeVisible({ timeout: 30_000 });
  await expect(providerRow).toHaveText(`${providerLabel}Error`);
  await page.keyboard.press("Escape");
}

export async function expectFixtureProviderUnavailable(page: Page): Promise<void> {
  const providerLabel = "Fixture Agent";
  const trigger = page.getByRole("button", { name: /Select model/ });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Back", exact: true }).click();
  await page.getByText(providerLabel, { exact: true }).click();
  await expect(page.getByRole("button", { name: `Open ${providerLabel} settings` })).toBeVisible();
  await expect(page.getByText(/^Fixture Model/u)).not.toBeVisible();
  await page.keyboard.press("Escape");
}

export async function expectProbeFailureWithRetry(page: Page, message: string): Promise<void> {
  await expect(page.getByRole("alert")).toContainText(message, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Select model/ })).toBeDisabled();
  await expect(page.getByText("Fixture Agent", { exact: true })).not.toBeVisible();
}

export async function retryFailedProbe(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Retry", exact: true }).click();
}

export async function expectNoProbeInWorkspaceProjection(
  page: Page,
  project: SeededRuntimeProject,
): Promise<void> {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  try {
    const probeIds = new Set(
      (await readProbeRecords(project.projectId)).map((record) => record.workspaceId),
    );
    const workspaces = await client.fetchWorkspaces({ filter: { projectId: project.projectId } });
    expect(workspaces.entries.some((workspace) => probeIds.has(workspace.id))).toBe(false);
    for (const probeId of probeIds) {
      await expect(page.getByTestId(`sidebar-workspace-${probeId}`)).toHaveCount(0);
    }
  } finally {
    await client.close();
  }
}

export async function seedNonGitProjectForRuntime(): Promise<SeededRuntimeProject> {
  const directory = await createTempDirectory("runtime-selector-non-git-");
  return seedRuntimeProject(directory);
}

async function seedRuntimeProject(resource: {
  path: string;
  cleanup(): Promise<void>;
}): Promise<SeededRuntimeProject> {
  const client = await connectSeedClient();
  const added = await client.addProject(resource.path);
  if (added.error || !added.project) {
    await client.close();
    await resource.cleanup();
    throw new Error(added.error ?? "Runtime project was not added");
  }
  const listed = await client.listProjects();
  const project = listed.projects.find(
    (candidate) => candidate.projectId === added.project?.projectId,
  );
  if (!project?.projectKey) {
    await client.close();
    await resource.cleanup();
    throw new Error("Runtime project has no project key");
  }
  return {
    projectId: added.project.projectId,
    projectKey: project.projectKey,
    projectDisplayName: added.project.projectDisplayName,
    sourceDirectory: resource.path,
    cleanup: async () => {
      await client.removeProject(added.project!.projectId);
      await client.close();
      await resource.cleanup();
    },
  };
}

export async function gotoNewWorkspaceForRuntime(
  page: Page,
  project: SeededRuntimeProject,
): Promise<void> {
  await gotoAppShell(page);
  await waitForConnectedHost(page, {
    serverId: getServerId(),
    endpoint: `localhost:${getE2EDaemonPort()}`,
  });
  await openGlobalNewWorkspaceComposer(page);
  await selectNewWorkspaceProject(page, project);
  await expect(page.getByRole("button", { name: "Runtime", exact: true })).toContainText("Local");
}

export async function expectRuntimeChoices(page: Page, labels: readonly string[]): Promise<void> {
  await page.getByRole("button", { name: "Runtime", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  for (const label of labels) {
    await expect(dialog.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await expect(dialog.getByRole("button")).toHaveCount(labels.length);
  await page.keyboard.press("Escape");
}

export async function expectRuntimeSelected(page: Page, label: string): Promise<void> {
  await expect(page.getByRole("button", { name: "Runtime", exact: true })).toContainText(label);
}

export async function selectRuntime(page: Page, label: string): Promise<void> {
  const trigger = page.getByRole("button", { name: "Runtime", exact: true });
  await trigger.click();
  await page.getByRole("dialog").last().getByRole("button", { name: label, exact: true }).click();
  await expect(trigger).toContainText(label);
}

export async function createWorkspaceInSelectedRuntime(page: Page): Promise<void> {
  await submitNewWorkspaceEmpty(page);
}

export async function expectWorkspaceOpenInRuntime(
  page: Page,
  project: SeededRuntimeProject,
  runtimeId: string,
): Promise<string> {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  try {
    const workspace = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: "",
      projectDisplayName: project.projectDisplayName,
      timeoutMs: 120_000,
    });
    const paseoHome = process.env.E2E_PASEO_HOME;
    if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
    const records = JSON.parse(
      await readFile(path.join(paseoHome, "projects", "workspaces.json"), "utf8"),
    ) as Array<{ workspaceId: string; runtime?: { runtimeId: string } }>;
    const record = records.find((candidate) => candidate.workspaceId === workspace.workspaceId);
    expect(record?.runtime).toEqual({ runtimeId });
    return workspace.workspaceId;
  } finally {
    await client.close();
  }
}

export async function expectSelectedHostRuntimePlacement(
  project: SeededRuntimeProject,
  runtimeId: "local" | "worktree",
  setupRan: boolean,
): Promise<void> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
  const records = JSON.parse(
    await readFile(path.join(paseoHome, "projects", "workspaces.json"), "utf8"),
  ) as Array<{
    projectId: string;
    cwd: string;
    hostVisiblePath?: string | null;
    runtime?: { runtimeId: string };
  }>;
  const workspace = records.find(
    (record) => record.projectId === project.projectId && record.runtime?.runtimeId === runtimeId,
  );
  expect(workspace, `${runtimeId} selected workspace record`).toBeDefined();
  expect(workspace?.hostVisiblePath).toBe(workspace?.cwd);
  if (setupRan) {
    await expect.poll(() => markerExists(workspace!.cwd), { timeout: 30_000 }).toBe(true);
  } else {
    expect(await markerExists(workspace!.cwd)).toBe(false);
  }
}

export async function expectHostWorkspaceAffordances(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Open workspace in VS Code" })).toBeVisible();
  await page.getByRole("button", { name: "Choose editor" }).click();
  await expect(page.getByText("VS Code", { exact: true })).toBeVisible();
  await expect(page.getByText("Finder", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
}

export async function expectDockerHasNoHostAffordance(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /Open workspace in/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose editor" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Open in file manager/ })).toHaveCount(0);
}

export async function expectDockerWorkspaceHasNoHostVisiblePath(
  project: SeededDockerRuntimeProject,
): Promise<void> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
  const records = JSON.parse(
    await readFile(path.join(paseoHome, "projects", "workspaces.json"), "utf8"),
  ) as Array<{
    projectId: string;
    runtime?: { runtimeId: string };
    hostVisiblePath?: string;
  }>;
  const workspace = records.find(
    (record) => record.projectId === project.projectId && record.runtime?.runtimeId === "docker",
  );
  expect(workspace, "Docker user workspace record").toBeDefined();
  expect(workspace?.hostVisiblePath).toBeNull();
}

export async function expectDockerTerminalText(page: Page, text: string): Promise<void> {
  await expect.poll(() => getTerminalBufferText(page), { timeout: 30_000 }).toContain(text);
}

export async function expectDockerScriptTerminalOpen(
  page: Page,
  scriptName: string,
): Promise<void> {
  const scriptTab = page
    .locator('[data-testid^="workspace-tab-terminal_"]')
    .filter({ hasText: scriptName });
  await expect(scriptTab).toBeVisible({ timeout: 30_000 });
  await scriptTab.click();
}

export async function openDockerUncommittedChanges(page: Page): Promise<void> {
  await page.getByTestId("explorer-tab-changes").click();
  await page.getByRole("button", { name: "Diff mode", exact: true }).click();
  await page.getByTestId("changes-diff-mode-uncommitted").click();
  await expect(page.getByRole("button", { name: "Diff mode", exact: true })).toHaveText(
    "Uncommitted",
  );
}

export async function commitDockerWorkspaceChanges(page: Page): Promise<void> {
  await clickFirstTerminalTab(page);
  const terminal = page.locator('[data-testid="terminal-surface"]').first();
  await terminal.click();
  await terminal.pressSequentially(
    "git add committed.txt made-in-container.txt && git -c user.name='Paseo E2E' -c user.email='paseo@example.test' commit -m 'Docker UI acceptance commit'\n",
    { delay: 0 },
  );
  await expectDockerTerminalText(page, "Docker UI acceptance commit");
}

export async function cleanupDockerRuntimeProject(
  project: SeededDockerRuntimeProject,
): Promise<void> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
  const recordPaths = [
    path.join(paseoHome, "projects", "provider-probes.json"),
    path.join(paseoHome, "projects", "workspaces.json"),
  ];
  const workspaceIds: string[] = [];
  const userWorkspaceIds: string[] = [];
  for (const recordPath of recordPaths) {
    try {
      await access(recordPath);
    } catch {
      continue;
    }
    const records = JSON.parse(await readFile(recordPath, "utf8")) as Array<{
      projectId: string;
      workspaceId: string;
      runtimeId?: string;
      runtime?: { runtimeId: string };
    }>;
    const matchingWorkspaceIds = records
      .filter(
        (record) =>
          record.projectId === project.projectId &&
          (record.runtimeId === "docker" || record.runtime?.runtimeId === "docker"),
      )
      .map((record) => record.workspaceId);
    workspaceIds.push(...matchingWorkspaceIds);
    if (recordPath.endsWith("workspaces.json")) userWorkspaceIds.push(...matchingWorkspaceIds);
  }
  const names = workspaceIds.map((workspaceId) => dockerResourceName(workspaceId));
  const userNames = userWorkspaceIds.map((workspaceId) => dockerResourceName(workspaceId));
  const runtimeOwner = createHash("sha256").update(path.resolve(paseoHome)).digest("hex");
  let productionCleanupComplete = false;
  try {
    const cleanupClient = await connectSeedClient();
    try {
      const agents = await cleanupClient.fetchAgents({ scope: "active" });
      const ownedAgents = agents.entries.filter((entry) =>
        userWorkspaceIds.includes(entry.agent.workspaceId ?? ""),
      );
      await Promise.all(ownedAgents.map((entry) => cleanupClient.cancelAgent(entry.agent.id)));
      await Promise.all(ownedAgents.map((entry) => cleanupClient.archiveAgent(entry.agent.id)));
      for (const workspaceId of userWorkspaceIds) {
        const scripts = await cleanupClient.listWorkspaceScripts(workspaceId);
        await Promise.all(
          scripts.scripts
            .filter((script) => script.lifecycle === "running")
            .map((script) => cleanupClient.stopWorkspaceScript(workspaceId, script.scriptName)),
        );
        const listed = await cleanupClient.listTerminals(undefined, undefined, { workspaceId });
        await Promise.all(
          listed.terminals.map((terminal) => cleanupClient.killTerminal(terminal.id)),
        );
        await expect
          .poll(
            async () =>
              (await cleanupClient.listTerminals(undefined, undefined, { workspaceId })).terminals
                .length,
            { timeout: 15_000 },
          )
          .toBe(0);
      }
    } finally {
      await cleanupClient.close();
    }
    await cleanupProjectThroughProductionLifecycle(project, userWorkspaceIds, userNames);
    productionCleanupComplete = true;
    await expectDockerRuntimeGone(userWorkspaceIds, userNames);
  } finally {
    await cleanupValidatedDockerResources(workspaceIds, runtimeOwner);
    await expectDockerRuntimeGone(workspaceIds, names);
    expect(productionCleanupComplete).toBe(true);
  }
}

async function cleanupProjectThroughProductionLifecycle(
  project: SeededDockerRuntimeProject,
  workspaceIds: readonly string[],
  names: readonly string[],
): Promise<void> {
  try {
    await project.cleanup();
    return;
  } catch (firstError) {
    const lingeringProcesses = (await dockerRuntimeLeaks(workspaceIds, names)).processes;
    if (lingeringProcesses.length > 0) {
      await run("kill", ["-KILL", ...lingeringProcesses.map(String)]);
      await expect
        .poll(async () => (await dockerRuntimeLeaks(workspaceIds, names)).processes.length, {
          timeout: 15_000,
        })
        .toBe(0);
    }
    try {
      await project.cleanup();
    } catch (retryError) {
      throw new Error(
        `Docker project cleanup failed through the production lifecycle after ${String(firstError)}`,
        { cause: retryError },
      );
    }
  }
}

async function expectDockerRuntimeGone(
  workspaceIds: readonly string[],
  names: readonly string[],
): Promise<void> {
  await expect
    .poll(() => dockerRuntimeLeaks(workspaceIds, names), { timeout: 15_000 })
    .toEqual({ containers: [], processes: [], volumes: [] });
}

async function cleanupValidatedDockerResources(
  workspaceIds: readonly string[],
  runtimeOwner: string,
): Promise<void> {
  for (const workspaceId of workspaceIds) {
    const name = dockerResourceName(workspaceId);
    const [container, volume] = await Promise.all([
      inspectDockerTestResource("container", name),
      inspectDockerTestResource("volume", name),
    ]);
    assertDockerTestResourceOwner(container, { name, runtimeOwner, workspaceId });
    assertDockerTestResourceOwner(volume, { name, runtimeOwner, workspaceId });
    if (container) await removeDockerTestResource("container", name);
    if (volume) await removeDockerTestResource("volume", name);
  }
}

interface DockerTestResourceInspection {
  labels: Record<string, string>;
  name: string;
}

async function inspectDockerTestResource(
  kind: "container" | "volume",
  name: string,
): Promise<DockerTestResourceInspection | null> {
  try {
    const { stdout } = await run("docker", [kind, "inspect", name]);
    const [inspection] = JSON.parse(stdout) as Array<{
      Config?: { Labels?: Record<string, string> | null };
      Labels?: Record<string, string> | null;
      Name?: string;
    }>;
    return {
      labels: (kind === "container" ? inspection?.Config?.Labels : inspection?.Labels) ?? {},
      name: inspection?.Name ?? name,
    };
  } catch (error) {
    if (await dockerTestResourceMissing(kind, name)) return null;
    throw error;
  }
}

function assertDockerTestResourceOwner(
  resource: DockerTestResourceInspection | null,
  expected: { name: string; runtimeOwner: string; workspaceId: string },
): void {
  if (!resource) return;
  expect(resource.labels).toMatchObject({
    [DOCKER_RUNTIME_LABELS.runtime]: "workspace",
    [DOCKER_RUNTIME_LABELS.runtimeOwner]: expected.runtimeOwner,
    [DOCKER_RUNTIME_LABELS.workspaceId]: expected.workspaceId,
  });
}

async function removeDockerTestResource(kind: "container" | "volume", name: string): Promise<void> {
  try {
    await run("docker", kind === "container" ? ["rm", "-f", name] : ["volume", "rm", "-f", name]);
  } catch (error) {
    if (await dockerTestResourceMissing(kind, name)) return;
    throw error;
  }
}

async function dockerTestResourceMissing(
  kind: "container" | "volume",
  name: string,
): Promise<boolean> {
  try {
    await run("docker", [kind, "inspect", name]);
    return false;
  } catch {
    return true;
  }
}

function dockerResourceName(workspaceId: string): string {
  const key = createHash("sha256").update(workspaceId).digest("hex").slice(0, 20);
  return `paseo-ws-${key}`;
}

async function dockerRuntimeLeaks(
  workspaceIds: readonly string[],
  names: readonly string[],
): Promise<{ containers: string[]; processes: number[]; volumes: string[] }> {
  const containers = await existingDockerResources("container", names);
  const volumes = await existingDockerResources("volume", names);
  const { stdout } = await run("ps", ["-axo", "pid=,command="]);
  const needles = workspaceIds.flatMap((workspaceId) => [
    dockerResourceName(workspaceId),
    `--workspace-id ${workspaceId}`,
  ]);
  const processes = stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/u))
    .filter((match): match is RegExpMatchArray =>
      Boolean(match && needles.some((needle) => match[2]?.includes(needle))),
    )
    .map((match) => Number(match[1]));
  return { containers, processes, volumes };
}

async function existingDockerResources(
  kind: "container" | "volume",
  names: readonly string[],
): Promise<string[]> {
  const checks = await Promise.all(
    names.map(async (name) => {
      try {
        await run("docker", [kind, "inspect", name]);
        return name;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((name): name is string => name !== null);
}
