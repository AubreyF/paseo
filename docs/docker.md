# Container operations

This fork runs the Paseo daemon, agents and provider tools inside Docker. Vorton is a client mode on that same daemon. Start with the [installer](../docker/multiplex/README.md); there is no separate native-daemon installation path. Browser and mobile clients run on their own devices.

## Build and install

From the repository root:

```sh
./docker/multiplex/install.sh "$HOME/paseo-instance"
```

The image builds for Linux AMD64 or ARM64. On macOS use Docker Desktop; on Windows use Docker's Linux-container backend. The installer needs Bash and Docker Compose, not host Node, Python or Tailscale. Only mount projects the agents should access. The default workspace is an empty private directory; clone projects into `/workspace` from the container.

Installation generates a password and separate random instance name, pins the image to a digest or local image ID, and keeps state outside the checkout. Startup waits for Tailscale enrollment, configures private HTTPS 443, and starts Paseo as a non-root user with an exact hostname/origin. The daemon binds container loopback; Compose publishes no host ports. Existing HTTPS routes are never replaced to claim 443.

If enrollment is interrupted, run `./connect.sh` from the deployment directory. Approve HTTPS in the tailnet administration page if Tailscale requests it; the container logs include the enablement link. Review the complete tailnet policy before admitting other users: permit only intended clients to this node's TCP 443. Keep Funnel disabled. The optional preview broker has its own port requirements.

The installer builds your checkout locally and pins the resulting image ID. No published image or registry account is required. The [Container workflow](../.github/workflows/docker.yml) checks AMD64 and ARM64 builds without publishing images. To reuse a reviewed local or registry image, pass its reference as the installer's second argument.

## Accounts and tools

Connect accounts using [provider configuration](custom-providers.md#multiple-profiles-for-the-same-provider). The bundled Codex and Pi versions are pinned in the Dockerfile. Authentication happens after installation and stays in the persistent home. Different accounts in one container are available to that container's OS user; they are not separate security sandboxes.

From the private deployment directory, run administration commands as `paseo`:

```sh
docker compose exec --user paseo paseo paseo daemon status --json
docker compose exec --user paseo paseo codex login --device-auth
docker compose exec --user paseo paseo gh auth login
docker compose exec --user paseo paseo bash
```

For an additional Codex account configured manually, give its provider a distinct `env.CODEX_HOME` under `/home/paseo`, then supply that same path with `docker compose exec --user paseo -e CODEX_HOME=/home/paseo/ACCOUNT paseo codex login --device-auth`. Existing installations need a coordinated daemon restart after manual provider configuration changes.

New homes enable Paseo's agent-tool injection for managed workers. Existing configuration is preserved. Use `profileId` for preset launches as described in [agent operation](../skills/paseo/SKILL.md).

Local inference is optional. MTPLX runs natively on a Mac and is reached from Pi over its authenticated endpoint. Merge [the Pi template](../docker/multiplex/pi-models.example.json) into `/home/paseo/.pi/agent/models.json`, set the real model ID and limits, and add `MTPLX_API_KEY` to the deployment `.env`. Recreate the instance during maintenance to apply environment changes. Start with one managed worker; endpoint reachability does not prove model availability or capacity.

## Updates and rollback

Updates interrupt this instance's tasks. Coordinate a maintenance window and back up its state first. Build your updated checkout from its repository root, then update the deployment:

```sh
docker build -f docker/base/Dockerfile -t paseo-multiplex:review .
"$HOME/paseo-instance/update.sh" paseo-multiplex:review
```

The updater retains the previous `.env` as `.env.previous`, checks the new image contract, and replaces only this Compose service. It does not remove orphan containers, delete volumes or automatically roll back a failed update. Use the previous image reference with the same command for an explicit rollback. An image rollback does not reverse data or project edits.

Untouched bundled web assets follow image updates. A separately published web release is preserved; use [instance continuity](instance-continuity.md) to replace it deliberately. Old hashed assets remain available for open clients.

Back up the deployment's `.env`, home, workspace and Tailscale volume while the instance is stopped. Use `docker compose stop paseo` and `docker compose start paseo`; never run two instances against the same home or identity. Do not use `docker compose down -v` on retained state. Keep backups and image receipts private.

## Existing installations

Do not run the fresh installer over an existing deployment. The updater requires the new installation marker and intentionally refuses legacy directories. Preserve the current private Compose files, exact home/workspace mounts, Tailscale identity volume, web release and rollback image. Pause optional host recovery before maintenance.

For a reviewed migration, compare the rendered old and new Compose configurations locally, without sharing their credential-bearing output. Map the existing identity volume explicitly, retain mounts, and check that the node's existing HTTPS 443 route points to this daemon. Recreate only after coordinating active tasks and taking a consistent backup. The old hostname-file mount is no longer needed by the new runtime; do not discard its identity volume. Reinstall optional broker tools against the serving container afterward. Record destination acceptance in the [private handoff](host-handoff.md).

## Troubleshooting

Run `docker compose ps` and `docker compose logs --tail=100 paseo` from the private deployment directory. An unhealthy container before enrollment is expected. Enrollment, node approval, HTTPS enablement and an occupied Serve route require administrator action; a timeout does not authorize restarting an active instance.

Use `docker compose exec --user paseo paseo paseo provider diagnostic PROVIDER --json` for provider failures. Check mounted-file ownership if the non-root user cannot access a project. Never recursively change ownership of an existing project tree to fix an unrelated startup error.

Docker must remain running and the host awake. Automated host recovery and agent-managed HTTPS previews are [optional macOS tools](../docker/tailscale/README.md); ordinary Paseo access does not depend on them. Xcode and the iOS simulator do not run inside this Linux environment.
