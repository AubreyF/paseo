import { useVortonMode } from "@/vorton-mode";
import { useVortonTouch } from "@/vorton-touch";
import { useIsCompactFormFactor } from "@/constants/layout";

const desktopRow = { minHeight: 32, paddingTop: 0, paddingBottom: 0, marginBottom: 2 };
const touchRow = { ...desktopRow, minHeight: 44 };

export function useSidebarRowDensity() {
  const vorton = useVortonMode();
  const touch = useVortonTouch();
  const compact = useIsCompactFormFactor();
  if (!vorton) return undefined;
  return touch && !compact ? touchRow : desktopRow;
}
