import { describe, expect, it } from "vitest";
import { resolveSubmitAction, supportsSubmitModifiers } from "./submit-action";

const running = {
  enabled: true,
  modifier: "none",
  isCompact: false,
  isAgentRunning: true,
  canQueue: true,
  defaultActionQueues: false,
} as const;

describe("composer submit action", () => {
  it("shows queue for Command while running, and restores send after release", () => {
    expect(resolveSubmitAction({ ...running, modifier: "alternate" })).toEqual({
      action: "alternate",
      queues: true,
    });
    expect(resolveSubmitAction(running)).toEqual({ action: "default", queues: false });
  });
  it("shows send for Command when Enter already queues by default", () => {
    expect(resolveSubmitAction({ ...running, defaultActionQueues: true })).toEqual({
      action: "default",
      queues: true,
    });
    expect(
      resolveSubmitAction({ ...running, defaultActionQueues: true, modifier: "alternate" }),
    ).toEqual({ action: "alternate", queues: false });
  });
  it.each([{ isAgentRunning: false }, { canQueue: false }, { isCompact: true }])(
    "does not advertise unavailable Command queue behavior: %j",
    (override) => {
      expect(resolveSubmitAction({ ...running, modifier: "alternate", ...override })).toEqual({
        action: "default",
        queues: false,
      });
    },
  );
  it("always inserts a newline for Shift, including compact and idle composers", () => {
    expect(
      resolveSubmitAction({
        ...running,
        modifier: "newline",
        isCompact: true,
        isAgentRunning: false,
      }),
    ).toEqual({ action: "newline", queues: false });
  });
  it("preserves Paseo buttons even with Shift held and default queue enabled", () => {
    expect(
      resolveSubmitAction({
        ...running,
        enabled: false,
        modifier: "newline",
        defaultActionQueues: true,
      }),
    ).toEqual({ action: "default", queues: false });
  });
  it.each([
    { vortonMode: false },
    { isWeb: false },
    { inputMode: "terminal" as const },
    { readOnly: true },
    { isSubmitLoading: true },
  ])("preserves baseline controls outside editable Vorton web chats: %j", (override) => {
    expect(
      supportsSubmitModifiers({
        vortonMode: true,
        isWeb: true,
        inputMode: "chat",
        readOnly: false,
        isSubmitLoading: false,
        ...override,
      }),
    ).toBe(false);
  });
  it("enables modifier controls in editable Vorton web chats", () => {
    expect(
      supportsSubmitModifiers({
        vortonMode: true,
        isWeb: true,
        inputMode: "chat",
        readOnly: false,
        isSubmitLoading: false,
      }),
    ).toBe(true);
  });
});
