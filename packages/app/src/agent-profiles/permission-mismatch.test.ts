import { expect, it } from "vitest";
import { profilePermissionMismatch } from "./permission-mismatch";

const profile = { id: "p", name: "Profile", provider: "codex", modeId: "full-access" };
it("warns when a legacy chat keeps different permissions", () => {
  expect(profilePermissionMismatch(profile, "auto-review", undefined)).toEqual({
    current: "auto-review",
    expected: "full-access",
  });
});
it("does not warn for matching or unknown permissions", () => {
  expect(profilePermissionMismatch(profile, "full-access", undefined)).toBeNull();
  expect(profilePermissionMismatch(profile, null, undefined)).toBeNull();
  expect(
    profilePermissionMismatch({ ...profile, modeId: undefined }, "auto-review", undefined),
  ).toBeNull();
});
