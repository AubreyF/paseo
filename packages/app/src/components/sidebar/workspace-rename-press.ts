import { isWeb } from "@/constants/platform";
import { useCallback, useEffect, useState } from "react";

export function useWorkspaceRenameDoubleClick({
  enabled,
  onRename,
}: {
  enabled: boolean;
  onRename?: () => void;
}) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const ref = useCallback((node: unknown) => {
    if (isWeb) setElement(node instanceof HTMLElement ? node : null);
  }, []);
  useEffect(() => {
    if (!element || !enabled || !onRename) return;
    const row = element;
    function rename(event: MouseEvent) {
      if (!isWorkspaceRenamePress({ nativeEvent: event, currentTarget: row }, true)) return;
      onRename?.();
    }
    // PressResponder can suppress onPress when a double-click selects title text.
    row.addEventListener("dblclick", rename);
    return () => row.removeEventListener("dblclick", rename);
  }, [element, enabled, onRename]);
  return ref;
}

interface RenamePress {
  nativeEvent: unknown;
  currentTarget: unknown;
}

export function isWorkspaceRenamePress(event: RenamePress, enabled: boolean): boolean {
  if (!isWeb || !enabled) return false;
  const mouse = event.nativeEvent;
  if (!(mouse instanceof MouseEvent) || mouse.button !== 0 || mouse.detail !== 2) return false;
  if ("pointerType" in mouse && mouse.pointerType !== "mouse") return false;
  const target = mouse.target;
  if (!(target instanceof Element)) return false;
  // Nested menu and navigation controls own their clicks.
  return target.closest('button, a, input, [role="button"]') === event.currentTarget;
}
