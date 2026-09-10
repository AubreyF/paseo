import { isWeb } from "@/constants/platform";

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
