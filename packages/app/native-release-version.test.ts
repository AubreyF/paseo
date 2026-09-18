import { describe, expect, it } from "vitest";

const {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
} = require("./native-release-version");

describe("native release version", () => {
  it("orders Vorton builds within and across upstream bases", () => {
    const first = getNativeReleaseVersion("0.7.2-vorton.9999");
    const next = getNativeReleaseVersion("0.7.2-vorton.10000");
    const upstream = getNativeReleaseVersion("0.7.3-vorton.1");
    expect(first.appVersion).toBe("0.7.2");
    expect(next.androidVersionCode).toBeGreaterThan(first.androidVersionCode);
    expect(upstream.androidVersionCode).toBeGreaterThan(next.androidVersionCode);
    expect(Number(next.iosBuildNumber)).toBeGreaterThan(Number(first.iosBuildNumber));
    expect(() => getNativeReleaseVersion("0.7.2-vorton.100000")).toThrow("out of range");
  });

  it("reserves the final iOS build slot for a stable release", () => {
    expect(getNativeReleaseVersion("0.2.6")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006999",
    });
  });

  it("gives each beta a unique iOS build slot under the stable app version", () => {
    expect(getNativeReleaseVersion("0.2.6-beta.2")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006002",
    });
  });

  it("rejects beta numbers that consume the stable iOS build slot", () => {
    expect(() => getNativeReleaseVersion("0.2.6-beta.999")).toThrow(
      "iOS beta number must be between 1 and 998",
    );
  });

  it("derives one F-Droid version code per published ABI", () => {
    expect(FDROID_ABI_VERSION_CODE_SUFFIXES).toEqual({
      "armeabi-v7a": 1,
      "arm64-v8a": 2,
      x86: 3,
      x86_64: 4,
    });
    expect(getFdroidVersionCodes("0.5.0")).toEqual([
      { abi: "armeabi-v7a", versionCode: 50001 },
      { abi: "arm64-v8a", versionCode: 50002 },
      { abi: "x86", versionCode: 50003 },
      { abi: "x86_64", versionCode: 50004 },
    ]);
  });
});
