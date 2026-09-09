import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { createProfileSuccessor, readProfileHandoff } from "./successor";

const source = {
  id: "source",
  workspaceId: "workspace",
  cwd: "/work",
  provider: "codex-one",
  title: "Fix tests",
  currentModeId: "auto-review",
  status: "idle",
  activeTurn: null,
  updatedAt: "2026-09-09T00:00:00Z",
} as AgentSnapshotPayload;
const profile = { id: "other", name: "Other account", provider: "codex-two" };
function client() {
  return {
    fetchAgents: vi.fn().mockResolvedValue({ entries: [] }),
    fetchAgentTimeline: vi.fn().mockResolvedValue({
      entries: [
        { item: { type: "user_message", text: "Fix tests" } },
        { item: { type: "tool_call", text: "secret tool result" } },
        { item: { type: "assistant_message", text: "First step completed" } },
      ],
    }),
    fetchAgent: vi.fn().mockResolvedValue({ agent: source }),
    createAgent: vi.fn().mockResolvedValue({ id: "successor" }),
  };
}
describe("explicit preset handoff", () => {
  it("copies bounded recorded text and preserves permissions without waking the old task", async () => {
    const api = client();
    const context = await readProfileHandoff(api, source);
    await createProfileSuccessor(api, source, profile, context);
    expect(api.createAgent).toHaveBeenCalledOnce();
    const request = api.createAgent.mock.calls[0][0];
    expect(request.config).toMatchObject({
      profileId: "other",
      provider: "codex-two",
      modeId: "auto-review",
    });
    expect(request.labels).toEqual({ "paseo:continued-from": "source" });
    expect(request.initialPrompt).toContain("First step completed");
    expect(request.initialPrompt).not.toContain("secret tool result");
  });
  it("rejects active or changed source tasks without starting a successor", async () => {
    const api = client();
    await expect(
      createProfileSuccessor(api, { ...source, status: "running" }, profile, "context"),
    ).rejects.toThrow("Stop");
    api.fetchAgent.mockResolvedValue({ agent: { ...source, updatedAt: "changed" } });
    await expect(createProfileSuccessor(api, source, profile, "context")).rejects.toThrow(
      "changed",
    );
    expect(api.createAgent).not.toHaveBeenCalled();
  });
  it("refuses handoff while a managed worker is active", async () => {
    const api = client();
    api.fetchAgents.mockResolvedValue({ entries: [{ id: "worker" }] });
    await expect(createProfileSuccessor(api, source, profile, "context")).rejects.toThrow(
      "active workers",
    );
    expect(api.createAgent).not.toHaveBeenCalled();
  });
});
