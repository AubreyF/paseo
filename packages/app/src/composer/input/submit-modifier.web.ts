import { useCallback, useEffect, useState } from "react";
import type { SubmitModifier } from "./submit-modifier";

export function useSubmitModifier(enabled: boolean) {
  const [modifier, setModifier] = useState<SubmitModifier>("none");
  const reset = useCallback(() => setModifier("none"), []);
  useEffect(() => {
    if (!enabled) return;
    function update(event: KeyboardEvent | PointerEvent) {
      if (event.shiftKey) setModifier("newline");
      else if (event.metaKey || event.ctrlKey) setModifier("alternate");
      else setModifier("none");
    }
    function externalInput(event: Event) {
      const inputType = (event as InputEvent).inputType;
      if (
        !inputType ||
        ["insertFromPaste", "insertReplacementText", "insertFromDictation"].includes(inputType)
      )
        reset();
    }
    function pointer(event: PointerEvent) {
      update(event);
    }
    document.addEventListener("keydown", update, true);
    document.addEventListener("keyup", update, true);
    document.addEventListener("input", externalInput, true);
    document.addEventListener("compositionend", reset, true);
    document.addEventListener("pointermove", pointer, true);
    window.addEventListener("focus", reset);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", reset);
    return () => {
      document.removeEventListener("keydown", update, true);
      document.removeEventListener("keyup", update, true);
      document.removeEventListener("input", externalInput, true);
      document.removeEventListener("compositionend", reset, true);
      document.removeEventListener("pointermove", pointer, true);
      window.removeEventListener("focus", reset);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", reset);
      reset();
    };
  }, [enabled, reset]);
  return { modifier: enabled ? modifier : "none", reset };
}
