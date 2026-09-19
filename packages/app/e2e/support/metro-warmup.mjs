/** @param {number} port */
export async function warmMetro(port) {
  // Shared runners may need longer to compile; assertion deadlines stay unchanged.
  const timeoutMs = Number(process.env.E2E_METRO_WARMUP_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("E2E_METRO_WARMUP_TIMEOUT_MS must be between 1000 and 600000");
  }
  const origin = `http://127.0.0.1:${port}`;
  const documentResponse = await fetch(origin, { signal: AbortSignal.timeout(timeoutMs) });
  if (!documentResponse.ok) {
    throw new Error(`Metro document warmup failed with HTTP ${documentResponse.status}`);
  }
  const document = await documentResponse.text();
  const scriptSources = [...document.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  if (scriptSources.length === 0) {
    throw new Error("Metro document warmup found no scripts to compile");
  }
  for (const source of scriptSources) {
    const scriptUrl = new URL(source, origin);
    if (scriptUrl.origin !== origin) continue;
    const response = await fetch(scriptUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 4000);
      throw new Error(
        `Metro bundle warmup failed for ${scriptUrl.pathname}: HTTP ${response.status}\n${details}`,
      );
    }
    await response.arrayBuffer();
  }
}
