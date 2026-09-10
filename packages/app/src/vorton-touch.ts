import { useSyncExternalStore } from "react";
import { isWeb } from "@/constants/platform";
import { useFormPreferences } from "@/hooks/use-form-preferences";

// Capability, not viewport width: a wide iPad can have both touch and a trackpad.
const TOUCH_QUERY = "(any-pointer: coarse)";
function subscribe(listener: () => void) {
  if (!isWeb || typeof window === "undefined") return () => {};
  const query = window.matchMedia(TOUCH_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
function getSnapshot() {
  return !isWeb || (typeof window !== "undefined" && window.matchMedia(TOUCH_QUERY).matches);
}
function serverSnapshot() {
  return !isWeb;
}
export function useVortonTouch() {
  const { preferences } = useFormPreferences();
  const touch = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
  return preferences.vortonMode === true && touch;
}

export const VORTON_ACTION_SLOT = { vortonActionSlot: "true" };
