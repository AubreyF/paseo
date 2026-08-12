import type pino from "pino";

import type { ProviderWorkspace } from "../agent/providers/workspace/index.js";
import type {
  CreateWorkspaceInput,
  WorkspaceRuntimeInspection,
  WorkspaceRuntimePlacement,
  WorkspaceRuntimeRecordStore,
} from "../workspace-runtime/index.js";
import { createProbeStore } from "./internal/probe-store.js";
import { createService } from "./internal/service.js";

export interface ProviderProbeService {
  ensure(input: { projectId: string; runtimeId: string }): Promise<{ workspaceId: string }>;
  resolveProviderWorkspace(workspaceId: string): Promise<ProviderWorkspace | null>;
  readonly records: WorkspaceRuntimeRecordStore;
}

export interface ProviderProbeServiceOptions {
  filePath: string;
  logger: pino.Logger;
  projects: {
    get(projectId: string): Promise<{
      projectId: string;
      rootPath: string;
      updatedAt: string;
      archivedAt?: string | null;
    } | null>;
  };
  runtime: {
    create(input: CreateWorkspaceInput): Promise<WorkspaceRuntimePlacement>;
    inspect(workspaceId: string): Promise<WorkspaceRuntimeInspection>;
    resume(workspaceId: string): Promise<void>;
  };
  runtimeConfiguration?: Readonly<Record<string, unknown>>;
  bindWorkspaceProviderCapability(
    workspaceId: string,
    runtimeId: string,
  ): Promise<ProviderWorkspace>;
}

export function createProviderProbeService(
  options: ProviderProbeServiceOptions,
): ProviderProbeService {
  const store = createProbeStore(options.filePath, options.logger);
  return createService({ ...options, store });
}
