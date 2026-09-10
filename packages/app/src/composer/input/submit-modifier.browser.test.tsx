import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useSubmitModifier } from "./submit-modifier.web";

let root: Root;
let container: HTMLDivElement;
function Modifier({ enabled }: { enabled: boolean }) {
  return <output>{useSubmitModifier(enabled)}</output>;
}
function mount(enabled = true) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Modifier enabled={enabled} />));
}
function key(type: "keydown" | "keyup", init: KeyboardEventInit) {
  act(() => document.dispatchEvent(new KeyboardEvent(type, init)));
}
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("composer held modifiers", () => {
  it("tracks Command and gives Shift precedence until it is released", () => {
    mount();
    key("keydown", { key: "Meta", metaKey: true });
    expect(container.textContent).toBe("alternate");
    key("keydown", { key: "Shift", metaKey: true, shiftKey: true });
    expect(container.textContent).toBe("newline");
    key("keyup", { key: "Shift", metaKey: true });
    expect(container.textContent).toBe("alternate");
    key("keyup", { key: "Meta" });
    expect(container.textContent).toBe("none");
  });
  it("supports Control and resets when the browser loses focus", () => {
    mount();
    key("keydown", { key: "Control", ctrlKey: true });
    expect(container.textContent).toBe("alternate");
    act(() => window.dispatchEvent(new Event("blur")));
    expect(container.textContent).toBe("none");
    key("keydown", { key: "Shift", shiftKey: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.textContent).toBe("none");
  });
  it("keeps Paseo unchanged and clears held state when Vorton is disabled", () => {
    mount(false);
    key("keydown", { key: "Shift", shiftKey: true });
    expect(container.textContent).toBe("none");
    act(() => root.render(<Modifier enabled />));
    key("keydown", { key: "Shift", shiftKey: true });
    expect(container.textContent).toBe("newline");
    act(() => root.render(<Modifier enabled={false} />));
    expect(container.textContent).toBe("none");
    act(() => root.render(<Modifier enabled />));
    expect(container.textContent).toBe("none");
  });
});
