import { useLayoutEffect, useState, type RefObject } from "react";
import type { View } from "react-native";

export function useCompactProfileName(ref: RefObject<View | null>, mobile: boolean) {
  const [narrow, setNarrow] = useState(true);
  useLayoutEffect(() => {
    const element: unknown = ref.current;
    if (!(element instanceof HTMLElement)) return;
    // A desktop split pane can be narrow even when the browser is wide.
    const composer = element.closest('[data-testid="message-input-root"]') ?? element.parentElement;
    if (!composer) return;
    const measure = () => setNarrow(composer.getBoundingClientRect().width < 640);
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    measure();
    return () => observer.disconnect();
  }, [ref]);
  return mobile || narrow;
}
