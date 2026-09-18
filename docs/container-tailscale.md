# Single-container Paseo and Tailscale

Run one container per user with Paseo and kernel-mode Tailscale sharing a network namespace. Each instance owns its persistent home, credentials, workspace mounts and Tailscale identity. The host administrator remains trusted. Use the [single container installer](../docker/multiplex/README.md).

## Privilege boundary

A root supervisor starts Tailscale and Paseo independently. Only Tailscale needs the TUN device and network administration capability. Paseo and its agents run as the non-root user after all capabilities are dropped, with no-new-privileges enabled. Keep identity state and the control socket protected from agents. Do not expose Docker's socket or sibling environments.

The installer builds the checkout locally using [one Dockerfile](../docker/base/Dockerfile). Provider and GitHub logins belong in persistent home, not image layers. Accounts and projects in the same container share an OS user and are not isolated from each other. Mounted files remain writable by agents; containerization does not protect those files from destructive commands or prevent network exfiltration. Provider permissions are an additional control.

## Private connectivity

The daemon binds container loopback. Compose publishes no host ports. Internal Tailscale provides private HTTPS on port 443 after enrollment. Grant only intended users access and keep Funnel disabled. Connecting devices need Tailscale; the Docker host does not need its own client.

Agent-managed workspace HTTPS previews use the [optional macOS broker](../docker/tailscale/README.md). Agent users do not receive Tailscale control privileges. Browser access to Paseo works without the broker.

## Lifecycle and recovery

Use Paseo's service allocator and lifecycle. Persist a preview's allocated port and explicit restoration intent. Legacy HTTP recovery restores only unchanged registered services after a new daemon session, with bounded retries. The HTTPS broker conservatively requires explicit start after a service or daemon restart and removes stale owned mappings. A deliberate stop must remain stopped. Reject occupied ports without killing their owner.

Host recovery can start Docker after login and start the retained stopped container. It must not recreate containers, restart an unhealthy running daemon, or run production alongside rollback against the same home. Pause automatic recovery before maintenance. Keep consistent backups and exact rollback images outside Git.

## Installation acceptance

Record dated evidence in the private deployment directory, including:

- Host and Docker identity, immutable image references and exact mounted state.
- Daemon health, distinct provider identities and real model availability.
- GitHub login under the non-root user, repository listing and search.
- Persistent web release and assets, remote previews, live reload and stable ports.
- Recreation with disposable state, bounded restoration and preserved stop intent.
- Protected identity state and socket, process capabilities, intended-user access and denied access.
- Physical device and microphone acceptance where used.

Never infer physical-device acceptance from a host browser. Preserve active tasks and announce before any approved interruption. Host Tailscale retirement is a separate decision with its own connectivity checks; this architecture does not authorize unenrollment.

## Source and private state

Public source contains reusable code, configuration templates and generic instructions only. Keep actual hostnames, addresses, machine paths, device IDs, account inventories, workspace IDs, image receipts, operational logs and backups outside Git. A secret environment file is only one part of an installation: persistent credential directories, Tailscale identity state and private operations records also need protection.

See [repository publication hygiene](publication-hygiene.md) before sharing source or rewriting history.
