import { describe, expect, it } from "vitest";
import { buildWorkspaceDraftAgentConfig } from "./workspace-draft-agent-config";

describe("workspace-draft-agent-config", () => {
  it("builds chat-only config for workspace draft agents", () => {
    expect(
      buildWorkspaceDraftAgentConfig({
        provider: "codex",
        cwd: "/tmp/project",
        modeId: "auto",
        model: "gpt-5.4",
        thinkingOptionId: "high",
      }),
    ).toEqual({
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "auto",
      model: "gpt-5.4",
      thinkingOptionId: "high",
    });
  });
});

it("lets the daemon resolve profile permissions instead of sending a stale draft override", () => {
  expect(
    buildWorkspaceDraftAgentConfig({
      provider: "codex",
      profileId: "p",
      cwd: "/repo",
      modeId: "full-access",
    }),
  ).toEqual({ provider: "codex", profileId: "p", cwd: "/repo" });
});
