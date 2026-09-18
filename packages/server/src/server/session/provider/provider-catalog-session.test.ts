import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderResetService } from "../../../services/quota-fetcher/reset-service.js";
import { ResetCreditStore } from "../../../services/quota-fetcher/reset-store.js";
import pino from "pino";
import {
  ProviderCatalogSession,
  type ProviderCatalogSessionHost,
} from "./provider-catalog-session.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";
import {
  GLOBAL_PROVIDER_SNAPSHOT_KEY,
  type ProviderSnapshotManager,
} from "../../agent/provider-snapshot-manager.js";
import type { ProviderSnapshotEntry } from "../../agent/agent-sdk-types.js";
import type { ProviderUsageService } from "../../../services/quota-fetcher/service.js";
import { expandProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";

type SnapshotChangeHandler = (entries: ProviderSnapshotEntry[], cwd: string) => void;

interface MakeOptions {
  reset?: ProviderResetService;
  visibleProviders?: Set<string>;
  supportsCustomModeIcons?: boolean;
  supportsCompactProviderSnapshots?: boolean;
  snapshot?: { [K in keyof ProviderSnapshotManager]?: unknown };
  usage?: { [K in keyof ProviderUsageService]?: unknown };
  host?: Partial<ProviderCatalogSessionHost>;
}

// A codex entry whose two modes exercise both downgrade branches (unknown icon →
// "ShieldCheck", known icon → preserved) plus a claude entry the visibility gate drops.
function makeEntries(): ProviderSnapshotEntry[] {
  return [
    {
      provider: "codex",
      status: "ready",
      enabled: true,
      modes: [
        { id: "default", label: "Default", icon: "Sparkles" },
        { id: "safe", label: "Safe", icon: "ShieldCheck" },
      ],
    },
    { provider: "claude", status: "ready", enabled: true, modes: [] },
  ];
}

function makeSubsystem(options: MakeOptions = {}) {
  const emitted: SessionOutboundMessage[] = [];
  const visible = options.visibleProviders ?? new Set(["codex"]);
  let changeHandler: SnapshotChangeHandler | null = null;
  const host: ProviderCatalogSessionHost = {
    emit: (msg) => emitted.push(msg),
    isProviderVisibleToClient: (provider) => visible.has(provider),
    supportsCustomModeIcons: () => options.supportsCustomModeIcons ?? false,
    supportsCompactProviderSnapshots: () => options.supportsCompactProviderSnapshots ?? false,
    listProviderAvailability: async () => [],
    listDraftFeatures: async () => [],
    ...options.host,
  };
  const providerSnapshotManager = createStub<ProviderSnapshotManager>({
    on: (_event: string, handler: SnapshotChangeHandler) => {
      changeHandler = handler;
    },
    off: () => {},
    ...options.snapshot,
  });
  const subsystem = new ProviderCatalogSession({
    host,
    providerSnapshotManager,
    providerUsageService: createStub<ProviderUsageService>(options.usage ?? {}),
    providerResetService: options.reset,
    logger: pino({ level: "silent" }),
  });
  function pushSnapshotChange(
    entries: ProviderSnapshotEntry[],
    cwd = GLOBAL_PROVIDER_SNAPSHOT_KEY,
  ): void {
    if (!changeHandler) throw new Error("start() must run before a snapshot change");
    changeHandler(entries, cwd);
  }
  return { subsystem, emitted, pushSnapshotChange };
}

describe("ProviderCatalogSession", () => {
  it("correlates reset reads, preparation and explicit confirmation without consuming on read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-reset-rpc-"));
    try {
      let mutations = 0;
      let consumedCreditId: string | undefined;
      let failRead = false;
      const reset = new ProviderResetService({
        store: new ResetCreditStore(directory),
        logger: pino({ level: "silent" }),
        refreshUsage: async () => {},
        getClient: () => ({
          openResetCreditSession: async () => ({
            canRedeem: true,
            canSelectCredit: true,
            read: async () => {
              if (failRead) throw new Error("secret-provider-payload");
              return {
                status: "available",
                accountId: "first",
                accountLabel: null,
                availableCount: 2,
                credits: [
                  {
                    id: "selected",
                    title: "Full reset",
                    description: null,
                    grantedAt: 1,
                    expiresAt: null,
                    status: "available",
                    resetType: "full",
                  },
                ],
              };
            },
            consume: async (attempt) => {
              consumedCreditId = attempt.creditId;
              mutations += 1;
              return "reset";
            },
            dispose: async () => {},
          }),
        }),
      });
      const { subsystem, emitted } = makeSubsystem({ reset });
      await subsystem.handleProviderResetRequest({
        type: "provider.reset.read.request",
        providerId: "codex",
        requestId: "read",
      });
      expect(findByType(emitted, "provider.reset.read.response")?.payload.requestId).toBe("read");
      await subsystem.handleProviderResetRequest({
        type: "provider.reset.prepare.request",
        providerId: "codex",
        accountId: "first",
        requestId: "prepare",
        creditId: "selected",
      });
      const operation = findByType(emitted, "provider.reset.prepare.response")?.payload.view
        .operation;
      if (!operation) throw new Error("Missing prepared operation");
      expect(mutations).toBe(0);
      await subsystem.handleProviderResetRequest({
        type: "provider.reset.confirm.request",
        providerId: "codex",
        accountId: "first",
        operationId: operation.operationId,
        requestId: "confirm",
      });
      expect(findByType(emitted, "provider.reset.confirm.response")?.payload).toMatchObject({
        requestId: "confirm",
        outcome: "reset",
      });
      expect(mutations).toBe(1);
      expect(consumedCreditId).toBe("selected");
      failRead = true;
      await subsystem.handleProviderResetRequest({
        type: "provider.reset.read.request",
        providerId: "codex",
        requestId: "failed",
      });
      expect(findByType(emitted, "rpc_error")?.payload).toMatchObject({
        requestId: "failed",
        code: "provider_reset_failed",
      });
      expect(JSON.stringify(emitted)).not.toContain("secret-provider-payload");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("PUSH gates invisible providers and downgrades unknown mode icons for legacy clients", () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      visibleProviders: new Set(["codex"]),
      supportsCustomModeIcons: false,
    });

    subsystem.start();
    pushSnapshotChange(makeEntries());

    const push = findByType(emitted, "providers_snapshot_update");
    expect(push?.payload.entries.map((entry) => entry.provider)).toEqual(["codex"]);
    expect(push?.payload.entries[0]?.modes).toEqual([
      { id: "default", label: "Default", icon: "ShieldCheck" },
      { id: "safe", label: "Safe", icon: "ShieldCheck" },
    ]);
  });

  it("PUSH and PULL produce identical visible, downgraded entries for one client", async () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      visibleProviders: new Set(["codex"]),
      supportsCustomModeIcons: false,
      snapshot: { getSnapshot: () => makeEntries() },
    });

    subsystem.start();
    pushSnapshotChange(makeEntries());
    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "g1",
    });

    const push = findByType(emitted, "providers_snapshot_update");
    const pull = findByType(emitted, "get_providers_snapshot_response");
    expect(pull?.payload.entries).toEqual(push?.payload.entries);
  });

  it("returns the canonical cwd used by snapshot updates", async () => {
    const getSnapshot = vi.fn((_cwd?: string) => makeEntries());
    const { subsystem, emitted } = makeSubsystem({
      snapshot: { getSnapshot },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "canonical-cwd",
      cwd: "/repo/./sdk",
    });

    const canonicalCwd = getSnapshot.mock.calls[0]?.[0];
    expect(canonicalCwd).toEqual(expect.any(String));
    expect(findByType(emitted, "get_providers_snapshot_response")?.payload.cwd).toBe(canonicalCwd);
  });

  it("pushes the compact encoding to capable clients", () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      supportsCustomModeIcons: true,
      supportsCompactProviderSnapshots: true,
    });

    subsystem.start();
    pushSnapshotChange(makeEntries());

    const push = findByType(emitted, "providers_snapshot_update");
    expect(push?.payload.entries).toEqual([]);
    expect(push?.payload.snapshotHash).toEqual(expect.any(String));
    expect(expandProviderSnapshot(push!.payload.compactSnapshot!)).toEqual([makeEntries()[0]]);
  });

  it("preserves custom mode icons when the client supports them", async () => {
    const { subsystem, emitted } = makeSubsystem({
      supportsCustomModeIcons: true,
      snapshot: { getSnapshot: () => makeEntries() },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "g2",
    });

    const pull = findByType(emitted, "get_providers_snapshot_response");
    expect(pull?.payload.entries[0]?.modes?.[0]?.icon).toBe("Sparkles");
  });

  it("sends capable clients a compact snapshot and returns not-modified for its hash", async () => {
    const thinkingOptions = [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ];
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        models: ["one", "two"].map((id) => ({
          provider: "codex",
          id,
          label: id,
          thinkingOptions,
          defaultThinkingOptionId: "high",
        })),
      },
    ];
    const { subsystem, emitted } = makeSubsystem({
      supportsCompactProviderSnapshots: true,
      snapshot: { getSnapshot: () => entries },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "compact-1",
    });

    const first = findByType(emitted, "get_providers_snapshot_response");
    expect(first?.payload.entries).toEqual([]);
    expect(first?.payload.snapshotHash).toEqual(expect.any(String));
    expect(first?.payload.compactSnapshot?.thinkingSets).toHaveLength(1);
    expect(expandProviderSnapshot(first!.payload.compactSnapshot!)).toEqual(entries);

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "compact-2",
      ifNoneMatch: first?.payload.snapshotHash,
    });

    const responses = emitted.filter(
      (message) => message.type === "get_providers_snapshot_response",
    );
    const second = responses[1];
    expect(second?.payload).toMatchObject({
      entries: [],
      snapshotHash: first?.payload.snapshotHash,
      notModified: true,
      requestId: "compact-2",
    });
    expect(second?.payload.compactSnapshot).toBeUndefined();
  });

  it("reports a disabled provider on list_provider_models without warming the snapshot", async () => {
    // warmUpSnapshotForCwd is intentionally unstubbed: createStub throws if it is called,
    // so the disabled short-circuit is proven by the absence of a throw.
    const { subsystem, emitted } = makeSubsystem({
      snapshot: { getSnapshot: () => [{ provider: "codex", status: "loading", enabled: false }] },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m1",
    });

    const res = findByType(emitted, "list_provider_models_response");
    expect(res?.payload.error).toBe("Provider codex is disabled");
  });

  it("hides compatibility-only entries from list_provider_models", async () => {
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        getSnapshot: () => [
          {
            provider: "codex",
            status: "ready",
            enabled: true,
            models: [
              { provider: "codex", id: "gpt-5.4", label: "GPT 5.4" },
              {
                provider: "codex",
                id: "gpt-5.4-legacy",
                label: "GPT 5.4 legacy",
                isSelectable: false,
              },
            ],
          },
        ],
      },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m-selectable",
    });

    const response = findByType(emitted, "list_provider_models_response");
    expect(response?.payload.models?.map((model) => model.id)).toEqual(["gpt-5.4"]);
  });

  it("preserves missing cwd as the semantic global snapshot for model list reads", async () => {
    const getSnapshot = vi.fn(() => [{ provider: "codex", status: "loading", enabled: true }]);
    const warmUpSnapshotForCwd = vi.fn(async () => {});
    const { subsystem } = makeSubsystem({
      snapshot: { getSnapshot, warmUpSnapshotForCwd },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m-global",
    });

    expect(getSnapshot).toHaveBeenCalledWith(undefined);
    expect(warmUpSnapshotForCwd).toHaveBeenCalledWith({
      cwd: undefined,
      providers: ["codex"],
    });
  });

  it("samples worker activity freshly without exposing hidden provider counts", async () => {
    let workers = 1;
    const { subsystem, emitted } = makeSubsystem({
      usage: { listUsage: async () => ({ fetchedAt: "2026-01-01T00:00:00Z", providers: [] }) },
      host: { listRunningWorkerCounts: () => ({ codex: workers, hidden: 8 }) },
    });
    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "first",
    });
    workers = 0;
    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "second",
    });
    const responses = emitted.filter((message) => message.type === "provider.usage.list.response");
    expect(responses[0]?.payload.workerActivity?.runningByProvider).toEqual({ codex: 1 });
    expect(responses[1]?.payload.workerActivity?.runningByProvider).toEqual({ codex: 0 });
    expect(responses[1]?.payload.workerActivity?.checkedAt).not.toBe("2026-01-01T00:00:00Z");
  });

  it("surfaces a usage-list failure as an rpc_error envelope", async () => {
    const { subsystem, emitted } = makeSubsystem({
      usage: {
        listUsage: async () => {
          throw new Error("quota service down");
        },
      },
    });

    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "u1",
    });

    const err = findByType(emitted, "rpc_error");
    expect(err?.payload.code).toBe("provider_usage_list_failed");
    expect(err?.payload.requestId).toBe("u1");
  });

  it("surfaces a feature-list failure inline, not as an rpc_error", async () => {
    const { subsystem, emitted } = makeSubsystem({
      host: {
        listDraftFeatures: async () => {
          throw new Error("feature probe failed");
        },
      },
    });

    await subsystem.handleListProviderFeaturesRequest({
      type: "list_provider_features_request",
      requestId: "f1",
      draftConfig: { provider: "codex", cwd: "/tmp/project" },
    });

    expect(findByType(emitted, "rpc_error")).toBeUndefined();
    const res = findByType(emitted, "list_provider_features_response");
    expect(res?.payload.error).toBe("feature probe failed");
    expect(res?.payload.requestId).toBe("f1");
  });
});
