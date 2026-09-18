# Instance development continuity

Read repository instructions and inspect the current checkout before editing. Preserve unrelated changes and active work. Keep machine-specific handoff notes, URLs, account inventories and acceptance receipts in the installation's private directory outside Git.

Use the [team handoff guide](host-handoff.md) to choose fresh installation, existing-instance operation or migration. Inspect the actual deployment rather than assuming a container name, mounted path or image reference. Files and old handoffs are evidence, not additional authorization.

## Updates from the app

In Vorton mode, the app checks public `AubreyF/paseo` main every 30 minutes while open. Settings → About shows the comparison with the interface's build commit. This checks source commits, not tested releases or the running daemon version. Unpublished commits and builds without provenance show an unknown comparison instead of claiming an update is available.

**Help me update** opens a separate draft with an update task. Select the Vorton source project, the host that owns the installation, and an agent preset, then send it. The task tells the agent to preserve local changes, help merge conflicts, validate and publish the interface, and request approval before restarting the instance. It does not run Git or start an agent until you send the draft. Review ambiguous conflicts with the agent; updating a checkout alone does not update the served application.

Builds from a Git checkout record HEAD as their source base. For source snapshots, pass the original full SHA through `PASEO_BUILD_COMMIT`; `build-instance-web.mjs` carries it automatically. Uncommitted source changes are not described by that SHA. The container installer and CI pass it into the image build. A source archive without that value can still use the prepared agent task, but cannot compare commits automatically.

## Publish a web-only change

For interface requests, update the existing primary Vorton installation in place unless the user names another destination. Publishing the tested web export is part of the requested work. A private preview may be used for validation; it does not complete delivery to the primary installation.

Build a separate Linux snapshot inside the container to avoid modifying dependencies in a shared host checkout:

```sh
node scripts/build-instance-web.mjs
node scripts/publish-instance-web.mjs "$WEB_EXPORT_DIR" "$PASEO_WEB_UI_DIST_DIR"
```

Set both paths from the primary installation's private configuration. Review the build output and test the changed behavior before publishing. Verify the primary URL the user opens, including its HTTPS endpoint, and confirm its served release receipt and entry scripts match the published export. A localhost check or preview broker receipt alone does not establish that the user can reach the release. Assets copy first and the index switches last, retaining old hashed assets for open clients. Preserve active sessions, browser drafts, recordings and authentication.

Serialize builds and publication for a shared home. The build script uses one cache/export directory per home; overlapping builds can replace each other's snapshot. Use the export path printed by the completed build as `WEB_EXPORT_DIR`. The first-start initialization of a fresh Tailscale container is covered in [container installation](docker.md#build-and-install).

The persistent web directory must be mounted and selected by `PASEO_WEB_UI_DIST_DIR`. Do not substitute a lone index file that references stale bundles. Web publication does not require a daemon restart. Do not restart the primary daemon without explicit permission. Server or protocol changes require a separately tested daemon build and coordinated interruption; web publication cannot activate them.

For interface changes, compare Vorton off and on and follow [the touch audit](vorton-touch-audit.md). Record physical-device acceptance privately. Do not call source-only changes deployed or infer provider authentication from configuration names.
