// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyVortonWeb } from "./vorton-web.web";

vi.mock("../diagnostics/web-viewport.web", () => ({ observeWebViewport: () => () => {} }));

let stop = () => {};
beforeEach(() => {
  document.head.innerHTML = `
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="Paseo">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <link rel="manifest" href="/manifest.json">
  `;
});
afterEach(() => {
  stop();
  document.head.innerHTML = "";
});
function legacyMetadata() {
  return document.head.querySelectorAll(
    'meta[name="apple-mobile-web-app-capable"], meta[name="apple-mobile-web-app-status-bar-style"]',
  );
}
describe("Vorton Home Screen metadata", () => {
  it("preserves baseline Paseo installation metadata", () => {
    stop = applyVortonWeb(false, true);
    expect(legacyMetadata()).toHaveLength(2);
    expect(
      document.head
        .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
        ?.getAttribute("content"),
    ).toBe("black-translucent");
  });
  it("preserves installation metadata in Vorton without requiring a new shortcut", () => {
    stop = applyVortonWeb(true, true);
    expect(legacyMetadata()).toHaveLength(2);
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute("href")).toBe(
      "/manifest.json",
    );
    expect(document.head.querySelector('meta[name="viewport"]')?.getAttribute("content")).toContain(
      "viewport-fit=cover",
    );
    expect(
      document.head
        .querySelector('meta[name="apple-mobile-web-app-title"]')
        ?.getAttribute("content"),
    ).toBe("Paseo");
  });
  it("restores the original metadata nodes when switching back to Paseo", () => {
    const original = Array.from(legacyMetadata());
    stop = applyVortonWeb(true, true);
    stop();
    stop = applyVortonWeb(false, true);
    expect(Array.from(legacyMetadata())).toEqual(original);
    expect(document.documentElement.dataset.vortonMode).toBe("false");
  });
  it("does not duplicate metadata across repeated mode changes", () => {
    for (let i = 0; i < 3; i++) {
      stop = applyVortonWeb(true, true);
      expect(legacyMetadata()).toHaveLength(2);
      stop();
      expect(legacyMetadata()).toHaveLength(2);
    }
    stop = () => {};
  });
});
