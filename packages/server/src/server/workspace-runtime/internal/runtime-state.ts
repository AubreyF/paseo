import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceDriverState } from "../drivers/index.js";

export function createRuntimeStateStore(paseoHome: string, runtimeId: string) {
  const directory = path.join(paseoHome, "workspace-runtimes", runtimeId);
  const fileFor = (workspaceId: string) =>
    path.join(directory, `${createHash("sha256").update(workspaceId).digest("hex")}.json`);
  return {
    async read(workspaceId: string): Promise<WorkspaceDriverState | null> {
      try {
        const parsed = JSON.parse(await readFile(fileFor(workspaceId), "utf8")) as unknown;
        if (!isWorkspaceDriverState(parsed, workspaceId)) return null;
        return parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(state: WorkspaceDriverState): Promise<void> {
      await mkdir(directory, { recursive: true });
      const target = fileFor(state.workspaceId);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await rename(temporary, target);
    },
    async remove(workspaceId: string): Promise<void> {
      await rm(fileFor(workspaceId), { force: true });
    },
  };
}

function isWorkspaceDriverState(
  value: unknown,
  workspaceId: string,
): value is WorkspaceDriverState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<WorkspaceDriverState>;
  return (
    state.workspaceId === workspaceId &&
    typeof state.root === "string" &&
    typeof state.revision === "string" &&
    typeof state.executionDomainId === "string" &&
    (state.lifecycle === "ready" || state.lifecycle === "paused")
  );
}
