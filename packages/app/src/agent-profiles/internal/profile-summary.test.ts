import { describe, expect, it } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { buildAgentProfilePickerSummary } from "./profile-summary";

function profile(name: string): AgentProfile {
  return {
    id: "profile_test",
    name,
    provider: "codex-primary",
    modeId: "auto-review",
  };
}

const entries = [
  {
    provider: "codex-primary",
    status: "ready" as const,
    enabled: true,
    label: "Codex Primary",
    models: [],
    modes: [{ id: "auto-review", label: "Auto-review" }],
  },
];

describe("buildAgentProfilePickerSummary", () => {
  it("removes a provider label that duplicates the profile name", () => {
    expect(
      buildAgentProfilePickerSummary({
        profile: profile("Codex Primary"),
        entries,
        formatFeatureCount: String,
      }),
    ).toBe("Auto-review");
  });

  it("keeps the provider label when it identifies a differently named profile", () => {
    expect(
      buildAgentProfilePickerSummary({
        profile: profile("Careful review"),
        entries,
        formatFeatureCount: String,
      }),
    ).toBe("Codex Primary · Auto-review");
  });
});
