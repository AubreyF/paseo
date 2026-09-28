import { describe, expect, it } from "vitest";
import { AgentProfileSchema } from "./agent-profile.js";
import { AgentProfileLaunchSchema, AgentProfileSchema as WireProfileSchema } from "./messages.js";

describe("profile schema compatibility", () => {
  it("preserves Vorton launch settings through the extracted and wire schemas", () => {
    const profile = {
      id: "supervisor",
      name: "Supervisor",
      nickname: "Lead",
      provider: "codex-work",
      instructions: "Review the worker's changes before finishing.",
      isDefault: true,
      workerProfileId: "local-worker",
      maxWorkers: 3,
      quotaReservePolicy: { kind: "protected", cruisePct: 25, redlinePct: 10 },
    };
    const worker = { id: "local-worker", name: "Worker", provider: "pi" };

    expect(AgentProfileSchema.parse(profile)).toEqual(profile);
    expect(WireProfileSchema.parse(profile)).toEqual(profile);
    expect(AgentProfileLaunchSchema.parse({ profile, worker })).toEqual({ profile, worker });
  });

  it("continues accepting profiles without Vorton fields", () => {
    const profile = { id: "standard", name: "Standard", provider: "claude" };
    expect(AgentProfileSchema.parse(profile)).toEqual(profile);
  });
});
