import { expect, it } from "vitest";
import { profileDetails } from "./profile-details";
const profile = { id: "p", name: "Codex 2 Astra Medium", provider: "codex", modeId: "auto-review" };
const entry = {
  provider: "codex",
  enabled: true,
  status: "ready" as const,
  defaultModeId: "default",
  modes: [
    {
      id: "auto-review",
      label: "Auto review",
      description: "Workspace write with reviewed approvals.",
    },
    { id: "default", label: "Default", description: "Ask for approval." },
  ],
};
it("describes the profile mode rather than the provider default", () => {
  expect(profileDetails(profile, entry)[0].text).toBe(
    "Auto review\nWorkspace write with reviewed approvals.",
  );
});
it("resolves an unset mode using the provider catalog", () => {
  expect(profileDetails({ ...profile, modeId: undefined }, entry)[0].text).toBe(
    "Default (provider default)\nAsk for approval.",
  );
});
it("retains a stored mode when catalog details are unavailable", () => {
  expect(profileDetails(profile)[0].text).toContain("auto-review");
});
it("shows nickname, disabled features, and usage guidance", () => {
  const sections = profileDetails({
    ...profile,
    nickname: "C2-AM",
    notes: "Use for UI work",
    featureValues: { plan: false, effort: "medium" },
  });
  expect(sections.map((section) => section.text)).toEqual(
    expect.arrayContaining(["C2-AM", "Plan: Off\nEffort: medium", "Use for UI work"]),
  );
});
