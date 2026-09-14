/**
 * @vitest-environment jsdom
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_FORM_PREFERENCES } from "@/create-agent-preferences/preferences";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentControlTrigger } from "./control";

vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("React", React);
  client = new QueryClient();
  client.setQueryData(["form-preferences"], DEFAULT_FORM_PREFERENCES);
});
afterEach(() => {
  cleanup();
  client.clear();
});

function TestIcon() {
  return null;
}

describe("AgentControlTrigger", () => {
  it("forwards interaction handlers to the rendered trigger", () => {
    const onPointerEnter = vi.fn();
    const onFocus = vi.fn();
    const onPress = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <AgentControlTrigger
          icon={TestIcon}
          surface="toolbar"
          label="Mode"
          onPress={onPress}
          onPointerEnter={onPointerEnter}
          onFocus={onFocus}
          accessibilityLabel="Select mode"
        />
      </QueryClientProvider>,
    );
    const trigger = view.getByRole("button", { name: "Select mode" });

    fireEvent.pointerEnter(trigger);
    fireEvent.focus(trigger);

    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
