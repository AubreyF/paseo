import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type WebSocket } from "@playwright/test";
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
import { createTempDirectory, createTempGitRepo } from "./workspace";

export interface SeededRuntimeProject {
  projectId: string;
  projectKey: string;
  projectDisplayName: string;
  sourceDirectory: string;
  cleanup(): Promise<void>;
}

export async function seedGitProjectForRuntime(
  options?: Parameters<typeof createTempGitRepo>[1],
): Promise<SeededRuntimeProject> {
  const repo = await createTempGitRepo("runtime-selector-", options);
  return seedRuntimeProject(repo);
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

export function expectNewWorkspaceProviderSnapshotUsesProjectCwd(
  page: Page,
  sourceDirectory: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const frameListeners = new Map<WebSocket, (event: { payload: string | Buffer }) => void>();
    const cleanup = () => {
      clearTimeout(timeout);
      page.off("websocket", handleWebSocket);
      for (const [socket, listener] of frameListeners) socket.off("framesent", listener);
      frameListeners.clear();
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleWebSocket = (socket: WebSocket) => {
      const handleFrame = ({ payload }: { payload: string | Buffer }) => {
        if (typeof payload !== "string") return;
        let frame: unknown;
        try {
          frame = JSON.parse(payload);
        } catch {
          return;
        }
        if (!frame || typeof frame !== "object" || !("message" in frame)) return;
        const message = frame.message;
        if (!message || typeof message !== "object") return;
        if (
          "type" in message &&
          message.type === "get_providers_snapshot_request" &&
          "cwd" in message &&
          message.cwd === sourceDirectory
        ) {
          finish();
        }
      };
      frameListeners.set(socket, handleFrame);
      socket.on("framesent", handleFrame);
    };
    const timeout = setTimeout(
      () => finish(new Error(`No provider snapshot request used cwd ${sourceDirectory}`)),
      30_000,
    );
    page.on("websocket", handleWebSocket);
  });
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
): Promise<void> {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  try {
    const workspace = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: "",
      projectDisplayName: project.projectDisplayName,
    });
    const paseoHome = process.env.E2E_PASEO_HOME;
    if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
    const records = JSON.parse(
      await readFile(path.join(paseoHome, "projects", "workspaces.json"), "utf8"),
    ) as Array<{ workspaceId: string; runtime?: { runtimeId: string } }>;
    expect(records.find((record) => record.workspaceId === workspace.workspaceId)?.runtime).toEqual(
      {
        runtimeId,
      },
    );
  } finally {
    await client.close();
  }
}
