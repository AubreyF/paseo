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

describe("reserve launch policy", () => {
  const profile = {
    id: "secondary",
    name: "Secondary",
    provider: "codex-secondary",
    quotaReservePolicy: { kind: "protected" as const, cruisePct: 25, redlinePct: 12 },
  };
  const config = { provider: "codex-secondary", cwd: "/work", profileId: profile.id };

  it("does not attach a profile policy without explicit launch opt-in", () => {
    expect(resolveProfileLaunch(config, [profile]).quotaReserve).toBeUndefined();
  });

  it("freezes the profile defaults and consumes the launch-only request", () => {
    const mutableProfile = structuredClone(profile);
    const resolved = resolveProfileLaunch(
      { ...config, quotaReservePolicy: { kind: "profile" } },
      [mutableProfile],
      1000,
    );
    mutableProfile.quotaReservePolicy.cruisePct = 90;
    expect(resolved.quotaReserve).toEqual({
      policy: { kind: "protected", cruisePct: 25, redlinePct: 12 },
      state: { kind: "ready", revision: 0, changedAt: new Date(1000).toISOString() },
    });
    expect(resolved.quotaReservePolicy).toBeUndefined();
    expect(resolveProfileLaunch(resolved, [])).toEqual(resolved);
  });

  it("uses the approved 15/10 defaults when a profile has no reserve setting", () => {
    const resolved = resolveProfileLaunch({ ...config, quotaReservePolicy: { kind: "profile" } }, [
      { id: profile.id, name: profile.name, provider: profile.provider },
    ]);
    expect(resolved.quotaReserve?.policy).toEqual({
      kind: "protected",
      cruisePct: 15,
      redlinePct: 10,
    });
  });

  it("allows an explicit task override including Off", () => {
    expect(
      resolveProfileLaunch({ ...config, quotaReservePolicy: { kind: "off" } }, [profile])
        .quotaReserve?.policy,
    ).toEqual({ kind: "off" });
    expect(
      resolveProfileLaunch(
        { ...config, quotaReservePolicy: { kind: "protected", cruisePct: 40, redlinePct: 20 } },
        [profile],
      ).quotaReserve?.policy,
    ).toEqual({ kind: "protected", cruisePct: 40, redlinePct: 20 });
  });

  it("rejects invalid threshold ordering and reattachment to a frozen task", () => {
    expect(() =>
      resolveProfileLaunch(
        { ...config, quotaReservePolicy: { kind: "protected", cruisePct: 10, redlinePct: 15 } },
        [profile],
      ),
    ).toThrow("Redline must be lower");
    const frozen = resolveProfileLaunch({ ...config, quotaReservePolicy: { kind: "profile" } }, [
      profile,
    ]);
    expect(() =>
      resolveProfileLaunch({ ...frozen, quotaReservePolicy: { kind: "off" } }, [profile]),
    ).toThrow("Use task controls");
  });
});
