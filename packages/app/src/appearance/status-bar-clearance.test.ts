import { describe, expect, it } from "vitest";
import { getStatusBarClearance } from "./status-bar-clearance";

const phone = {
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Version/27.0 Mobile Safari/604.1",
  platform: "iPhone",
  maxTouchPoints: 5,
  standalone: true,
};

describe("Home Screen toolbar clearance", () => {
  it("clears the native blur despite Safari's frozen OS token", () => {
    expect(getStatusBarClearance(phone, 62, true)).toBe(20);
  });
  it.each([0, -1])("does not add a landscape gap with inset %s", (inset) => {
    expect(getStatusBarClearance(phone, inset, true)).toBe(0);
  });
  it("restores Standard mode geometry", () => {
    expect(getStatusBarClearance(phone, 62, false)).toBe(0);
  });
  it("does not move Safari tab controls", () => {
    expect(getStatusBarClearance({ ...phone, standalone: false }, 62, true)).toBe(0);
  });
  it("does not move older Home Screen apps", () => {
    expect(
      getStatusBarClearance(
        { ...phone, userAgent: phone.userAgent.replace("Version/27.0", "Version/26.5") },
        62,
        true,
      ),
    ).toBe(0);
  });
  it("supports a Home Screen UA without a Safari version", () => {
    expect(
      getStatusBarClearance(
        { ...phone, userAgent: "iPhone; CPU iPhone OS 27_0 like Mac OS X" },
        62,
        true,
      ),
    ).toBe(20);
  });
  it("does not guess clearance from an unversioned UA", () => {
    expect(getStatusBarClearance({ ...phone, userAgent: "iPhone" }, 62, true)).toBe(0);
  });
  it("keeps desktop and Android geometry", () => {
    expect(
      getStatusBarClearance(
        { ...phone, userAgent: "Android Version/27.0", platform: "Linux" },
        24,
        true,
      ),
    ).toBe(0);
    expect(
      getStatusBarClearance(
        { ...phone, userAgent: "Macintosh Version/27.0", platform: "MacIntel", maxTouchPoints: 0 },
        24,
        true,
      ),
    ).toBe(0);
    expect(getStatusBarClearance(null, 62, true)).toBe(0);
  });
  it("covers iPad desktop identity and subsequent Safari releases", () => {
    expect(
      getStatusBarClearance(
        { ...phone, userAgent: "Macintosh Version/28.0", platform: "MacIntel" },
        24,
        true,
      ),
    ).toBe(20);
  });
});
