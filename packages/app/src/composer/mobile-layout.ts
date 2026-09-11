import { useIsCompactFormFactor } from "@/constants/layout";
import { useVortonTouch } from "@/vorton-touch";

export const COMPOSER_CORNER_INSET = 8;
export const MOBILE_COMPOSER_MARGIN = 16;
export function useMobileComposerLayout() {
  const touch = useVortonTouch();
  const compact = useIsCompactFormFactor();
  // The bottom action's horizontal inset is 12px padding + 1px border - 6px
  // hit-target overhang. Match that 7px inset vertically; screen spacing lives
  // outside the field so recording and idle controls occupy the same positions.
  return { enabled: touch && compact, bottomPadding: 6 };
}
