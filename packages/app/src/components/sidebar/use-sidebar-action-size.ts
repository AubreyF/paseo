import { useVortonMode } from "@/vorton-mode";
import { useVortonTouch } from "@/vorton-touch";

const desktop = { width: 24, height: 24, minWidth: 24, minHeight: 24 };
const touchAction = { width: 44, height: 44, minWidth: 44, minHeight: 44 };

export function useSidebarActionSize() {
  const vorton = useVortonMode();
  const touch = useVortonTouch();
  if (!vorton) return undefined;
  return touch ? touchAction : desktop;
}
