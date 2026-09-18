import { describe, expect, it } from "vitest";
import { isConnectionToast } from "./connection-toast";

describe("connection toast presentation", () => {
  it.each([
    "Transport closed (code 1006)",
    "Transport closed",
    "Transport not connected",
    "Transport not connected (status: connecting)",
  ])("uses the quiet connection chip for %s only in Vorton", (content) => {
    expect(isConnectionToast({ vortonMode: true, content })).toBe(true);
    expect(isConnectionToast({ vortonMode: false, content })).toBe(false);
  });

  it("recognizes the persistent reconnect notice independently of its translation", () => {
    expect(
      isConnectionToast({
        vortonMode: true,
        content: "Reconnexion",
        testID: "agent-reconnecting-toast",
      }),
    ).toBe(true);
    expect(
      isConnectionToast({
        vortonMode: false,
        content: "Reconnexion",
        testID: "agent-reconnecting-toast",
      }),
    ).toBe(false);
  });

  it.each([
    "Permission denied",
    "Could not send message",
    "Transport closed: authentication rejected",
    "Provider unavailable",
    null,
  ])("preserves unrelated errors: %s", (content) => {
    expect(isConnectionToast({ vortonMode: true, content })).toBe(false);
  });
});
