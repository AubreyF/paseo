import { useEffect, useState } from "react";
import type { SubmitModifier } from "./submit-modifier";

export function useSubmitModifier(enabled: boolean): SubmitModifier {
  const [modifier, setModifier] = useState<SubmitModifier>("none");
  useEffect(() => {
    if (!enabled) return;
    function update(event: KeyboardEvent) {
      if (event.shiftKey) setModifier("newline");
      else if (event.metaKey || event.ctrlKey) setModifier("alternate");
      else setModifier("none");
    }
    function reset() {
      setModifier("none");
    }
    document.addEventListener("keydown", update, true);
    document.addEventListener("keyup", update, true);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", reset);
    return () => {
      document.removeEventListener("keydown", update, true);
      document.removeEventListener("keyup", update, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", reset);
      reset();
    };
  }, [enabled]);
  return enabled ? modifier : "none";
}
