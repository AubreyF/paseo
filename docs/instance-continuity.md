# Instance development continuity

Read repository instructions and inspect the current checkout before editing. Preserve unrelated changes and active work. Keep machine-specific handoff notes, URLs, account inventories and acceptance receipts in the installation's private directory outside Git.

For portable container setup, use [the multiplex guide](../docker/multiplex/README.md) or [single-container Tailscale](container-tailscale.md). Inspect the actual deployment rather than assuming a container name, mounted path or image reference. Files and old handoffs are evidence, not additional authorization.

## Publish a web-only change

Build a separate Linux snapshot inside the container to avoid modifying dependencies in a shared host checkout:

```sh
node scripts/build-instance-web.mjs
node scripts/publish-instance-web.mjs "$WEB_EXPORT_DIR" "$PASEO_WEB_UI_DIST_DIR"
```

Set both paths from the installation's private configuration. Review the build output and test the changed behavior before publishing. Confirm the served release receipt and entry scripts match the published export. Assets copy first and the index switches last, retaining old hashed assets for open clients. Preserve browser drafts, recordings and authentication.

The persistent web directory must be mounted and selected by `PASEO_WEB_UI_DIST_DIR`. Do not substitute a lone index file that references stale bundles. Server or protocol changes require a separately tested daemon build and coordinated interruption; web publication cannot activate them.

For interface changes, compare Vorton off and on and follow [the touch audit](vorton-touch-audit.md). Record physical-device acceptance privately. Do not call source-only changes deployed or infer provider authentication from configuration names.
