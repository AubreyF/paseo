# Paseo with kernel-mode Tailscale

Run Paseo and Tailscale in one container while keeping agent processes unprivileged. This is a reusable image and Compose overlay, not a saved installation. Keep your actual Compose files, environment, identity volume, account state, backups and acceptance records outside the source checkout. See [the architecture](../../docs/container-tailscale.md).

## Build

Start from an immutable Paseo image that already supplies your required agent providers. The Dockerfile adds the pinned Tailscale release, GitHub CLI and process supervision without capturing a running container's filesystem. This recipe currently supports ARM64.

```sh
docker build --build-arg PASEO_BASE="$PASEO_BASE" \
  -t "$PASEO_TAILSCALE_IMAGE" docker/tailscale
```

Supply `PASEO_BASE` as a reviewed image digest. Record the resulting image ID privately. Never use `docker commit` to package account state. Test the candidate with disposable home and identity volumes and no live workspace mounts before replacement. Confirm provider binaries, non-root execution, daemon health and persistent web assets.

## Private installation files

Copy `compose.yaml` into your private deployment directory and merge it with the existing service configuration. Preserve home, workspace and web mounts, environment and authentication. The overlay requires `PASEO_TAILSCALE_IMAGE` and `PASEO_TAILSCALE_VOLUME`; it deliberately has no installation defaults. It requires an existing external identity volume and a `tailscale-hostname` file containing the node's DNS name. Enroll a fresh identity through an administrator-controlled session before using that metadata. Do not attach a staging daemon to production home or identity state.

The base service should publish its web port on host loopback only. Do not mount Docker's socket or a whole personal home. The container root supervisor holds networking and identity privileges; `start-paseo` drops all capabilities and enables no-new-privileges before starting Paseo. Keep Tailscale's state and socket unavailable to agent users.

A private environment file can define these host administration settings:

| Variable                        | Meaning                                            |
| ------------------------------- | -------------------------------------------------- |
| `PASEO_DEPLOYMENT_DIR`          | Absolute private deployment directory outside Git  |
| `PASEO_CONTAINER_NAME`          | Existing serving container                         |
| `PASEO_ROLLBACK_CONTAINER_NAME` | Existing stopped rollback container                |
| `PASEO_DOCKER_BIN`              | Docker executable, default `/usr/local/bin/docker` |
| `PASEO_DOCKER_CONTEXT`          | Docker context, default `desktop-linux`            |
| `PASEO_RECOVERY_LABEL`          | Optional unique macOS login-agent label            |

The HTTPS broker installer discovers the existing deployment from the stable container name and Docker mount metadata. It persists non-secret settings in `host-config.json` outside agent mounts. Both runtime tools and recovery load that file without shell exports. Existing environment settings remain an initial recovery-installer fallback; missing values produce a diagnostic rather than creating a deployment.

## Recovery

On the macOS Docker host, review the scripts, then run `python3 install-host-recovery.py` with the private settings exported. It copies the worker outside the checkout and installs a login agent that checks once per minute. An awake, logged-in Mac is required. This does not bypass FileVault or start Docker before login.

From the private deployment directory:

```sh
python3 host-recovery.py status
python3 host-recovery.py pause
python3 host-recovery.py resume
```

Pause before planned Docker maintenance or rollback. The worker starts Docker if absent, with three attempts spaced ten minutes apart. It starts an existing stopped serving container with three attempts spaced five minutes apart. It never recreates a container or restarts a running unhealthy daemon. A running rollback container suppresses replacement recovery. Restore operations run as the agent user with all capabilities removed. Review private `recovery-status.json` and logs when manual attention is needed.

## Preview lifecycle and private HTTPS

On the Mac host, review and test this directory, then install against the retained serving container:

```sh
python3 -B test_https_broker.py
python3 -B test_host_recovery.py
python3 install-https-broker.py --container EXISTING_NAME \
  --allowed-root /absolute/development/root --rollback RETAINED_ROLLBACK_NAME
```

The installer uses Docker mount metadata to locate the existing deployment. It rejects host code or policy targets beneath writable container mounts, preserves configuration backups, installs a bounded login consumer, and updates the persistent helper and instructions without restarting Paseo. Run the same installer after upgrading these tools. The image also distributes the helper module for new installations. Keep the existing Tailscale identity and grants. Review the current packet-filter scope; installation must not broaden it. The runtime fails closed if that scope or node identity changes.

Agents use the [approved helper workflow](AGENT-INSTRUCTIONS.md). Starts request HTTPS by default for host-approved local development roots. Requests contain only lifecycle operation, workspace ID, service name, request ID, timestamp and optional preferred frontend port. The filesystem inbox is the only request interface. No Docker or Tailscale socket is exposed to agents.

The host resolves live daemon workspace and script records, checks the configuration fingerprint and managed terminal, and verifies the actual loopback listener process before publishing. It reserves a stable frontend, writes startup origin configuration, and starts the registered command through the existing unprivileged daemon CLI. The command wrapper supplies `PASEO_PREVIEW_ORIGIN` at launch. Applications must consume it where framework hosts, callback URLs or WSS origins need explicit configuration. A caller's environment does not reach a daemon-launched service.

The mapping ledger, deduplication journal and lock remain outside agent-writable mounts. Repeated start adopts an unchanged owned mapping without probing its occupied frontend or replacing it. Stop persists its barrier and removes the exact owned route before stopping the service. Old queued starts and replays cannot undo a stop. Recovery revalidates ownership and process identity, removes stale routes, and never automatically restarts broker-managed services after a crash or daemon restart. An explicit new start is required. This conservative policy prevents backend reuse from being adopted during recovery.

The consumer checks every ten seconds while the user session is available. It has bounded file sizes, queue batches, command timeouts and reconciliation work. It is not a synchronous process-death firewall: an external process exit or replacement can precede the next check. Use the helper for deliberate stop/restart so route removal precedes process termination. Never run a new unrelated listener on a reserved backend before its route is removed. Unexpected route changes require administrator review and are never evicted.

Only `ready` receipts contain usable URLs after certificate-validating HTTPS and HTTP checks. Browser rendering, Web Crypto, clipboard permissions and application origin checks are separate acceptance checks. HTTPS adds neither application authentication nor tailnet authorization. Keep direct listeners' forwarded-header trust disabled and preserve explicit bind scope. Tailscale Serve supports WebSocket upgrades; frameworks with explicit HMR client origins must use the reserved HTTPS origin and WSS.

`https-preview.py WORKSPACE_ID SERVICE HTTPS_PORT` remains an administrator compatibility entry point using the same policy, ledger and lock. Never use `serve reset`, enable Funnel or replace another mapping to claim a port.

## Broker rollback

Stop each broker-managed preview with the helper when its process may stop. This removes and verifies only its owned mapping, and keeps the frontend reservation. For a capability-only rollback that preserves processes, unload `local.paseo.https-preview-broker` with launchctl, then use `uninstall-https-broker.py` from the trusted installation. It verifies each exact route before removal and disables request handling without resetting Tailscale or touching unrelated mappings. Keep the helper's environment loader and origin files for already-wrapped commands. Restore backed-up recovery code/configuration only after checking that its container identities still match. Do not restore stale whole-home or whole-Tailscale state.

An awake, logged-in Mac and available Docker are prerequisites. FileVault unlock, login and host wake are not supplied by this broker. Installation or recovery does not authorize restarting Paseo, Docker or unrelated services.

## Backup and replacement

Coordinate active work and announce immediately before interruption. Pause recovery, preserve deployment configuration and exact image references, stop production with its configured grace period, then take a consistent home and Tailscale-state backup. Keep the old stopped container and image for rollback. Never run two daemons against the same persistent home.

Recreate with the reviewed candidate, preserving mounts, environment, accounts and persistent web directory. Verify daemon health, node identity, provider catalogs, GitHub identity and repository discovery, served release, preview restoration and physical-device access. Rollback means stopping the replacement before starting the retained old container with its saved configuration. Keep recovery paused while the old container serves. Do not remove volumes, prune rollback artifacts or unenroll host Tailscale as part of cleanup.

Use focused tests with disposable state. `python3 -B test_host_recovery.py` verifies bounded recovery behavior without touching Docker. Record installation-specific test results privately.
