import { describe, expect, it } from "vitest";
import { resolveProfileLaunch } from "./profile.js";

describe("profile launch", () => {
  const profile = {
    id: "supervisor",
    name: "Frontier with local workers",
    provider: "codex-primary",
    model: "frontier",
    thinkingOptionId: "high",
    modeId: "unsafe",
    instructions: "Review every worker diff.",
    workerProfileId: "local",
    maxWorkers: 2,
  };
  const worker = { id: "local", name: "Local fast", provider: "pi", model: "local-model" };

  it("resolves on the server without overriding the separately selected permissions", () => {
    const config = resolveProfileLaunch(
      {
        provider: "stale",
        cwd: "/work",
        profileId: profile.id,
        modeId: "read-only",
        systemPrompt: "Project instructions.",
      },
      [profile, worker],
    );
    expect(config.provider).toBe("codex-primary");
    expect(config.modeId).toBe("read-only");
    expect(config.model).toBe("frontier");
    expect(config.systemPrompt).toContain("Review every worker diff.");
    expect(config.systemPrompt).toContain("Project instructions.");
    expect(config.profileLaunch?.worker).toEqual(worker);
    expect(config.profileId).toBeUndefined();
    profile.instructions = "Changed later.";
    expect(config.profileLaunch?.profile.instructions).toBe("Review every worker diff.");
    expect(resolveProfileLaunch(config, [])).toEqual(config);
  });

  it("refuses missing profiles and recursive teams", () => {
    const config = { provider: "codex", cwd: "/work", profileId: "missing" };
    expect(() => resolveProfileLaunch(config, [])).toThrow("not found");
    expect(() =>
      resolveProfileLaunch({ ...config, profileId: profile.id }, [
        profile,
        { ...worker, workerProfileId: profile.id },
      ]),
    ).toThrow("cannot supervise");
  });
});
