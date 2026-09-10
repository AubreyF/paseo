import { afterEach, describe, expect, test, vi } from "vitest";
import pino from "pino";
import { AgentManager } from "./agent/agent-manager.js";
import { generateStructuredAgentResponseWithFallback } from "./agent/agent-response-loop.js";
import { WorkspaceTitleSuggestions } from "./workspace-title-suggestions.js";

vi.mock("./agent/agent-response-loop.js", () => ({
  generateStructuredAgentResponseWithFallback: vi.fn(),
}));
const titles = [
  "Fix keyboard focus",
  "Restore rename dialog focus",
  "Keep workspace navigation focused",
];
const logger = pino({ level: "silent" });
function fixture() {
  const manager = new AgentManager({ clients: {}, logger });
  const source = vi
    .spyOn(manager, "getFirstWorkspacePrompt")
    .mockResolvedValue({
      sourceId: "agent:1",
      prompt: "Please fix keyboard focus after closing the workspace rename dialog.",
    });
  const generate = vi
    .mocked(generateStructuredAgentResponseWithFallback)
    .mockReset()
    .mockResolvedValue({ titles });
  const service = new WorkspaceTitleSuggestions({
    agentManager: manager,
    providerSnapshotManager: { getSnapshot: () => [], listProviders: async () => [] },
    readDaemonConfig: () => ({
      metadataGeneration: { providers: [{ provider: "codex", model: "configured-model" }] },
    }),
    logger,
  });
  return { service, source, generate };
}
const input = { workspaceId: "workspace", cwd: "/tmp", regenerate: false };
afterEach(() => vi.restoreAllMocks());

describe("workspace title suggestions", () => {
  test("returns three titles, shares concurrent requests, caches reopening and explicitly regenerates", async () => {
    const { service, generate } = fixture();
    expect(await Promise.all([service.suggest(input), service.suggest(input)])).toEqual([
      titles,
      titles,
    ]);
    expect(await service.suggest(input)).toEqual(titles);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        persistSession: false,
        maxRetries: 1,
        providers: [{ provider: "codex", model: "configured-model" }],
        agentConfigOverrides: { title: "Workspace title suggestions", internal: true },
      }),
    );
    await service.suggest({ ...input, regenerate: true });
    expect(generate).toHaveBeenCalledTimes(2);
  });
  test("refreshes when source identity changes", async () => {
    const { service, source, generate } = fixture();
    await service.suggest(input);
    source.mockResolvedValue({ sourceId: "replacement:1", prompt: "Fix a different problem" });
    await service.suggest(input);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  test("missing first message is actionable and makes no inference request", async () => {
    const { service, source, generate } = fixture();
    source.mockResolvedValue(null);
    await expect(service.suggest(input)).rejects.toThrow("Send a message");
    expect(generate).not.toHaveBeenCalled();
  });
  test("failure releases the request for retry and never caches invalid alternatives", async () => {
    const { service, generate } = fixture();
    generate.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(service.suggest(input)).rejects.toThrow("provider unavailable");
    generate.mockResolvedValueOnce({ titles: ["Same", "same", " "] });
    await expect(service.suggest(input)).rejects.toThrow("three distinct titles");
    expect(await service.suggest(input)).toEqual(titles);
    expect(generate).toHaveBeenCalledTimes(3);
  });
  test("bounds concurrent generation across workspaces", async () => {
    const { service, generate } = fixture();
    let release!: (result: { titles: string[] }) => void;
    generate.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = service.suggest(input);
    const second = service.suggest({ ...input, workspaceId: "second" });
    await expect(service.suggest({ ...input, workspaceId: "third" })).rejects.toThrow("busy");
    release({ titles });
    await Promise.all([first, second]);
  });
});
