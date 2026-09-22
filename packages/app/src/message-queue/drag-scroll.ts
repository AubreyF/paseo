import { createContext, useCallback, useState } from "react";
import { isNative } from "@/constants/platform";

export const QueueDragScrollContext = createContext<(active: boolean) => void>(() => {});

// Native's parent conversation must yield its pan gesture to the queue drag.
// Browser dnd-kit keeps the parent scrollable for edge auto-scrolling.
export function useQueueDragScroll(enabled: boolean) {
  const [active, setActive] = useState(false);
  const onDragActive = useCallback((value: boolean) => {
    if (isNative) setActive(value);
  }, []);
  return { scrollEnabled: enabled && !active, onDragActive };
}
