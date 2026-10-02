import { createHash } from "node:crypto";

export function installationWebEntry(input) {
  const target = new URL(input);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw new Error(
      "The installation entry requires an HTTPS origin without credentials or a path.",
    );
  }
  const origin = target.origin;
  const script = `const origin = ${JSON.stringify(origin)};
if (origin === window.location.origin) {
  document.getElementById("entry-status").textContent = "The installation entry points to itself. Restore its previous release and correct the destination.";
} else {
  const destination = new URL(origin);
  destination.pathname = window.location.pathname;
  destination.search = window.location.search;
  destination.hash = window.location.hash;
  window.location.replace(destination.href);
}
`;
  const hash = createHash("sha256").update(script).digest("hex");
  const scriptName = `installation-entry-${hash}.js`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Vorteo</title></head>
<body><p id="entry-status">Opening your Vorteo installation...</p><noscript>Enable JavaScript to keep your current conversation link, or <a href="${origin}/">open Vorteo</a>.</noscript><script src="/${scriptName}"></script></body></html>
`;
  return { origin, scriptName, script, html };
}
