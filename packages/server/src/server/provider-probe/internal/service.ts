import { createHash } from "node:crypto";

import type { ProviderProbeService, ProviderProbeServiceOptions } from "../index.js";
import type { ProbeStore, ProviderProbeRecord } from "./probe-store.js";

interface ServiceOptions extends ProviderProbeServiceOptions {
  store: ProbeStore;
}

export function createService(options: ServiceOptions): ProviderProbeService {
  const inFlight = new Map<string, Promise<{ workspaceId: string }>>();

  return {
    records: options.store.records,
    ensure(input) {
      const workspaceId = probeWorkspaceId(input.projectId, input.runtimeId);
      const pending = inFlight.get(workspaceId);
      if (pending) return pending;
      const ensurePromise = materialize(input, workspaceId).finally(() => {
        if (inFlight.get(workspaceId) === ensurePromise) inFlight.delete(workspaceId);
      });
      inFlight.set(workspaceId, ensurePromise);
      return ensurePromise;
    },
    async resolveProviderWorkspace(workspaceId) {
      const record = await options.store.get(workspaceId);
      if (!record || record.status !== "ready") return null;
      return options.bindWorkspaceProviderCapability(workspaceId, record.runtimeId);
    },
  };

  async function materialize(
    input: { projectId: string; runtimeId: string },
    workspaceId: string,
  ): Promise<{ workspaceId: string }> {
    const project = await options.projects.get(input.projectId);
    if (!project || project.archivedAt) throw new Error(`Project not found: ${input.projectId}`);
    const timestamp = new Date().toISOString();
    const fingerprint = probeFingerprint({
      projectId: project.projectId,
      rootPath: project.rootPath,
      runtimeId: input.runtimeId,
      runtimeConfiguration: options.runtimeConfiguration?.[input.runtimeId],
    });
    const existing = await options.store.get(workspaceId);
    if (existing?.status === "ready") {
      const inspection = await options.runtime.inspect(workspaceId);
      if (inspection.status === "ready") {
        await touch(existing, timestamp);
        return { workspaceId };
      }
      if (inspection.status === "paused") {
        await options.runtime.resume(workspaceId);
        await options.store.update(workspaceId, (record) => ({
          ...record,
          status: "ready",
          lastUsedAt: timestamp,
        }));
        return { workspaceId };
      }
    }

    const record: ProviderProbeRecord = existing ?? {
      workspaceId,
      projectId: project.projectId,
      runtimeId: input.runtimeId,
      fingerprint,
      status: "materializing",
      lastUsedAt: timestamp,
      createdAt: timestamp,
    };
    await options.store.put({
      ...record,
      fingerprint,
      status: "materializing",
      lastUsedAt: timestamp,
    });
    try {
      await options.runtime.create({
        workspaceId,
        runtimeId: input.runtimeId,
        project: {
          id: project.projectId,
          source: { kind: "host-directory", path: project.rootPath },
        },
        placement: { kind: "existing" },
        purpose: "provider-probe",
        setupFromPaseoConfig: false,
      });
      return { workspaceId };
    } catch (error) {
      await options.store.remove(workspaceId);
      throw error;
    }
  }

  async function touch(record: ProviderProbeRecord, timestamp: string): Promise<void> {
    await options.store.put({ ...record, lastUsedAt: timestamp });
  }
}

function probeWorkspaceId(projectId: string, runtimeId: string): string {
  return `wksprobe_${hash({ projectId, runtimeId }).slice(0, 32)}`;
}

function probeFingerprint(input: {
  projectId: string;
  rootPath: string;
  runtimeId: string;
  runtimeConfiguration: unknown;
}): string {
  return hash(input);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
