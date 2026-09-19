import { useVortonMode } from "@/vorton-mode";
import { useVortonTouch } from "@/vorton-touch";

const desktopRow = {
  minHeight: 32,
  paddingTop: 0,
  paddingBottom: 0,
  paddingRight: 8,
  marginBottom: 2,
};
const touchRow = { ...desktopRow, minHeight: 44 };

export function useSidebarRowDensity() {
  const vorton = useVortonMode();
  const touch = useVortonTouch();
  if (!vorton) return undefined;
  return touch ? touchRow : desktopRow;
}
