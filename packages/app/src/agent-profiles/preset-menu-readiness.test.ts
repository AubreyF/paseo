import { expect, test } from "vitest";
import { presetMenuReady } from "./preset-menu-readiness";

const pending = { enabled: true, hasData: false, failed: false };
const loaded = { enabled: true, hasData: true, failed: false };

test("keeps the menu closed until the last provider and its details arrive", () => {
  expect(
    presetMenuReady({ catalogLoading: true, usageLoading: true, resets: [pending, pending] }),
  ).toBe(false);
  expect(
    presetMenuReady({ catalogLoading: true, usageLoading: false, resets: [loaded, loaded] }),
  ).toBe(false);
  expect(
    presetMenuReady({ catalogLoading: false, usageLoading: true, resets: [loaded, loaded] }),
  ).toBe(false);
  expect(
    presetMenuReady({ catalogLoading: false, usageLoading: false, resets: [loaded, pending] }),
  ).toBe(false);
  expect(
    presetMenuReady({ catalogLoading: false, usageLoading: false, resets: [loaded, loaded] }),
  ).toBe(true);
});

test("failed reads settle as unavailable without blocking the menu forever", () => {
  expect(
    presetMenuReady({
      catalogLoading: false,
      usageLoading: false,
      resets: [loaded, { ...pending, failed: true }],
    }),
  ).toBe(true);
});

test("unavailable reset capability does not block other provider details", () => {
  expect(
    presetMenuReady({
      catalogLoading: false,
      usageLoading: false,
      resets: [{ ...pending, enabled: false }],
    }),
  ).toBe(true);
});

test("a populated snapshot remains usable after a failed refresh", () => {
  expect(
    presetMenuReady({
      catalogLoading: false,
      usageLoading: false,
      resets: [{ ...loaded, failed: true }, loaded],
    }),
  ).toBe(true);
});
