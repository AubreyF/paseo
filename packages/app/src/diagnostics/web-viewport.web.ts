import { formatDiagnosticSection } from "./app-diagnostic-report";

const history: string[] = [];
function dimensions() {
  const viewport = window.visualViewport;
  const root = document.getElementById("root")?.getBoundingClientRect();
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;width:0;height:100vh;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);box-sizing:content-box";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const vh = style.height;
  const safeArea = `${style.paddingTop}/${style.paddingBottom}`;
  probe.style.height = "100dvh";
  const dvh = getComputedStyle(probe).height;
  probe.remove();
  return JSON.stringify({
    standalone: matchMedia("(display-mode: standalone)").matches,
    screen: [screen.width, screen.height],
    inner: [innerWidth, innerHeight],
    root: root ? [root.x, root.y, root.width, root.height] : null,
    visual: viewport ? [viewport.width, viewport.height, viewport.offsetTop, viewport.scale] : null,
    vh,
    dvh,
    safeArea,
  });
}
export function observeWebViewport(): () => void {
  const record = (event: Event | string) => {
    history.push(
      `${new Date().toISOString()} ${typeof event === "string" ? event : event.type} ${dimensions()}`,
    );
    if (history.length > 12) history.shift();
  };
  record("mount");
  window.addEventListener("resize", record);
  window.addEventListener("pageshow", record);
  window.visualViewport?.addEventListener("resize", record);
  return () => {
    window.removeEventListener("resize", record);
    window.removeEventListener("pageshow", record);
    window.visualViewport?.removeEventListener("resize", record);
  };
}
export function collectWebViewportDiagnostics(): string[] {
  return [
    formatDiagnosticSection("Browser viewport", [
      { label: "Current", value: dimensions() },
      { label: "Recent measurements", value: history.join("\n    ") },
      {
        label: "Entry scripts",
        value: Array.from(document.scripts)
          .filter((script) => script.src)
          .map((script) => new URL(script.src).pathname)
          .join(", "),
      },
    ]),
  ];
}
