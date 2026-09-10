import { expect, it } from "vitest";
import { generatedPresetNickname, presetNickname } from "./nickname";
import { permissionCaption } from "./permission-caption";
import { selectedPresetPresentation } from "./selected-preset-presentation";
import { remainingRingValue } from "../provider-usage/remaining-ring-value";

it.each([false, true])("gates selected nicknames and quota rings with Vorton %s", (vortonMode) => {
  const result = selectedPresetPresentation({
    selectedProfileId: "secondary",
    selectedProfileName: "Codex 2 Astra Medium",
    currentProvider: "codex-secondary",
    definitions: [
      {
        id: "secondary",
        name: "Codex 2 Astra Medium",
        nickname: "C2-AM",
        provider: "codex-secondary",
      },
    ],
    vortonMode,
    now: 100,
    view: {
      kind: "ready",
      isRefreshing: false,
      payload: {
        requestId: "test",
        fetchedAt: new Date(0).toISOString(),
        providers: [
          {
            providerId: "codex-secondary",
            displayName: "Codex Secondary",
            status: "available",
            planLabel: null,
            windows: [{ id: "weekly", label: "Weekly", remainingPct: 50 }],
          },
        ],
      },
    },
  });
  expect(result.triggerLabel).toBe(vortonMode ? "C2-AM" : "Codex 2 Astra Medium");
  expect(result.showRing).toBe(vortonMode);
  if (vortonMode) expect(result.accessibilityLabel).toContain("50 percent remaining");
});

it("generates nicknames and preserves separately editable overrides", () => {
  expect(generatedPresetNickname("Codex 2 Astra Medium")).toBe("C2-AM");
  expect(generatedPresetNickname("Local Fast")).toBe("LF");
  expect(presetNickname({ name: "Codex 2 Astra Medium", nickname: " My coder " })).toBe("My coder");
  expect(presetNickname({ name: "Codex 2 Astra Medium", nickname: " " })).toBe("C2-AM");
});

it.each([
  ["Auto-review", "Auto"],
  ["Full access", "Full"],
  ["Default permissions", "Default"],
  ["Read only", "Read only"],
])("shortens %s only in Vorton", (label, expected) => {
  expect(permissionCaption(label, true)).toBe(expected);
  expect(permissionCaption(label, false)).toBe(label);
  expect(permissionCaption(label, true, true)).toBe(expected.slice(0, 1).toUpperCase());
  expect(permissionCaption(label, false, true)).toBe(label);
});

it.each([0, 50, 100])("uses %s percent remaining, ignoring code review", (remainingPct) => {
  expect(
    remainingRingValue(
      {
        providerId: "codex",
        displayName: "Codex",
        status: "available",
        planLabel: null,
        windows: [
          { id: "session", label: "Session", remainingPct },
          { id: "code_review", label: "Code review", remainingPct: 0 },
        ],
      },
      new Date(0).toISOString(),
      100,
    ),
  ).toBe(remainingPct);
});

it("does not turn stale or unavailable readings into zero", () => {
  const usage = {
    providerId: "codex",
    displayName: "Codex",
    status: "available" as const,
    planLabel: null,
    windows: [{ id: "session", label: "Session", remainingPct: 50 }],
  };
  expect(remainingRingValue(usage, new Date(0).toISOString(), 300001)).toBeNull();
  expect(remainingRingValue(undefined, new Date(0).toISOString(), 100)).toBeNull();
  expect(
    remainingRingValue(
      {
        ...usage,
        windows: [...usage.windows, { id: "weekly", label: "Weekly", remainingPct: NaN }],
      },
      new Date(0).toISOString(),
      100,
    ),
  ).toBeNull();
});
