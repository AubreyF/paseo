import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isWeb } from "@/constants/platform";
import { useVortonMode } from "@/vorton-mode";
import { getStatusBarClearance } from "./status-bar-clearance";

export function useChromeInsets() {
  const insets = useSafeAreaInsets();
  const vorton = useVortonMode();
  const clearance = getStatusBarClearance(
    isWeb && typeof navigator !== "undefined" ? navigator : null,
    insets.top,
    vorton,
  );
  return { ...insets, top: insets.top + clearance };
}
