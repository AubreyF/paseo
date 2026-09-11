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

Export the required settings before running host scripts. The login-agent installer persists their non-secret configuration in the user's private LaunchAgents directory. These tools do not need GitHub tokens, provider tokens or an enrollment key in their environment. GitHub authentication belongs in the persistent container user's `.config/gh`; provider accounts stay in their own persistent credential directories.

## Recovery

On the macOS Docker host, review the scripts, then run `python3 install-host-recovery.py` with the private settings exported. It copies the worker outside the checkout and installs a login agent that checks once per minute. An awake, logged-in Mac is required. This does not bypass FileVault or start Docker before login.

From the private deployment directory:

```sh
python3 host-recovery.py status
python3 host-recovery.py pause
python3 host-recovery.py resume
```

Pause before planned Docker maintenance or rollback. The worker starts Docker if absent, with three attempts spaced ten minutes apart. It starts an existing stopped serving container with three attempts spaced five minutes apart. It never recreates a container or restarts a running unhealthy daemon. A running rollback container suppresses replacement recovery. Restore operations run as the agent user with all capabilities removed. Review private `recovery-status.json` and logs when manual attention is needed.

## Preview lifecycle

Install [AGENT-INSTRUCTIONS.md](AGENT-INSTRUCTIONS.md) in the relevant persistent agent instruction locations. The image supplies `paseo-preview`; host recovery expects a reviewed copy at `/home/paseo/.local/bin/paseo-preview` so persistent installations can update without interrupting agents.

```sh
paseo-preview list --workspace WORKSPACE_ID
paseo-preview start preview --workspace WORKSPACE_ID
paseo-preview status
paseo-preview stop preview --workspace WORKSPACE_ID
```

The helper uses Paseo's existing allocator and service lifecycle. A successful start pins the allocated port in the project's `paseo.json` and records restoration intent in persistent home. It adopts running services without interruption. `restart` keeps the port; `stop` disables restoration immediately. Ordinary UI/CLI stops are observed at the next recovery check. Use the helper's stop before immediate shutdown. A new worktree must not inherit another checkout's occupied fixed port.

Restoration applies only to registered, enabled services after a new daemon session, with at most three attempts per service. Changed commands or ports, moved workspaces and port conflicts require review. Recovery does not continuously restart crashed commands or evict another listener.

## Private HTTPS

Ordinary previews use HTTP over the private tailnet. Secure-context browser APIs need HTTPS. With the host settings exported and the target service registered, an administrator can run:

```sh
python3 https-preview.py WORKSPACE_ID SCRIPT HTTPS_PORT
```

Choose a free frontend port in the installed allocator's approved access-policy range. This helper currently restricts ports to 32768 through 60999. It preserves other Serve mappings, rejects known port conflicts and records the mapping privately. Configure framework host checks and WSS origins for the actual HTTPS endpoint. Never enable Funnel or give agents Tailscale operator privileges.

Remove only a reviewed mapping with `tailscale serve --https=PORT off` through an administrator-controlled container session. Never use `serve reset` to remove one preview. Delete its private receipt only after verifying removal. HTTPS enables browser APIs but does not grant microphone permission.

## Backup and replacement

Coordinate active work and announce immediately before interruption. Pause recovery, preserve deployment configuration and exact image references, stop production with its configured grace period, then take a consistent home and Tailscale-state backup. Keep the old stopped container and image for rollback. Never run two daemons against the same persistent home.

Recreate with the reviewed candidate, preserving mounts, environment, accounts and persistent web directory. Verify daemon health, node identity, provider catalogs, GitHub identity and repository discovery, served release, preview restoration and physical-device access. Rollback means stopping the replacement before starting the retained old container with its saved configuration. Keep recovery paused while the old container serves. Do not remove volumes, prune rollback artifacts or unenroll host Tailscale as part of cleanup.

Use focused tests with disposable state. `python3 -B test_host_recovery.py` verifies bounded recovery behavior without touching Docker. Record installation-specific test results privately.
