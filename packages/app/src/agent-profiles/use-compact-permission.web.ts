import { useLayoutEffect, useState, type RefObject } from "react";
import type { View } from "react-native";

export function useCompactPermission(
  ref: RefObject<View | null>,
  enabled: boolean,
  fullCaption: string,
  contentKey: string,
) {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element: unknown = ref.current;
    if (!enabled || !(element instanceof HTMLElement)) {
      setCompact(false);
      return;
    }
    const target = element;
    let active = true;
    function measure() {
      if (!active) return;
      // Measure the full captions without changing the live controls or their focus.
      const clone = target.cloneNode(true);
      if (!(clone instanceof HTMLElement)) return;
      clone.setAttribute("aria-hidden", "true");
      clone.inert = true;
      Object.assign(clone.style, {
        position: "fixed",
        visibility: "hidden",
        pointerEvents: "none",
        width: "max-content",
        maxWidth: "none",
        flex: "none",
        flexWrap: "nowrap",
      });
      const trigger = clone.querySelector('[data-testid="preset-permission-trigger"]');
      const label = Array.from(trigger?.querySelectorAll("div") ?? []).find(
        (node) => node.childElementCount === 0 && node.textContent,
      );
      if (label) label.textContent = fullCaption;
      target.parentElement?.appendChild(clone);
      const required = clone.getBoundingClientRect().width;
      clone.remove();
      setCompact(required > target.getBoundingClientRect().width + 1);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    void document.fonts.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [enabled, fullCaption, contentKey, ref]);
  return enabled && compact;
}
