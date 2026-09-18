import React, { act, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { Pressable, Text, type GestureResponderEvent } from "react-native";
import { expect, test, vi } from "vitest";
import { useWorkspaceRenameDoubleClick } from "./workspace-rename-press";

const rename = vi.fn();
const navigate = vi.fn();
const menu = vi.fn();
function Row({ enabled }: { enabled: boolean }) {
  const ref = useWorkspaceRenameDoubleClick({ enabled, onRename: rename });
  const pressMenu = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
    menu();
  }, []);
  return (
    <Pressable accessibilityRole="button" ref={ref} onPress={navigate}>
      <Text testID="title">Workspace title to rename</Text>
      <Pressable accessibilityRole="button" onPress={pressMenu} testID="menu">
        <Text>Workspace actions</Text>
      </Pressable>
    </Pressable>
  );
}

test("title dblclick opens rename even without onPress, with mode and nested-control guards", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function render(enabled: boolean) {
    act(() => root.render(<Row enabled={enabled} />));
  }
  function doubleClick(testID: string) {
    const target = container.querySelector(`[data-testid="${testID}"]`);
    if (!target) throw new Error(`Missing ${testID}`);
    act(() =>
      target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0, detail: 2 })),
    );
  }
  try {
    render(false);
    doubleClick("title");
    expect(rename).not.toHaveBeenCalled();
    render(true);
    // Browser text selection can cancel PressResponder's onPress callback.
    // Rename must respond to dblclick independently of that callback.
    doubleClick("title");
    expect(navigate).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledOnce();
    doubleClick("menu");
    expect(rename).toHaveBeenCalledOnce();
    render(false);
    doubleClick("title");
    expect(rename).toHaveBeenCalledOnce();
    render(true);
    doubleClick("title");
    expect(rename).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
