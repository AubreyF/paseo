import { expect, test } from "vitest";
import { isQuotaExhaustionMessage } from "./quota-notice";

test("recognizes structured quota failures without replacing ordinary messages", () => {
  expect(
    isQuotaExhaustionMessage("[System Error] Usage limit reached.\n\ncode: quota_exhausted"),
  ).toBe(true);
  expect(isQuotaExhaustionMessage("[System Error] Network unavailable")).toBe(false);
  expect(isQuotaExhaustionMessage("Please explain code: quota_exhausted")).toBe(false);
});
