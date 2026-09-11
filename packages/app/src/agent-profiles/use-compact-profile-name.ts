import type { RefObject } from "react";
import { useWindowDimensions, type View } from "react-native";

export function useCompactProfileName(_ref: RefObject<View | null>, mobile: boolean) {
  return useWindowDimensions().width < 640 || mobile;
}
