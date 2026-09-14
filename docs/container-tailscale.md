# Single-container Paseo and Tailscale

Run one container per user with Paseo and kernel-mode Tailscale sharing a network namespace. Each instance owns its persistent home, credentials, workspace mounts and Tailscale identity. The host administrator remains trusted. Reusable files live in [docker/tailscale](../docker/tailscale/README.md).

## Privilege boundary

A root supervisor starts Tailscale and Paseo independently. Only Tailscale needs the TUN device and network administration capability. Paseo and its agents run as the non-root user after all capabilities are dropped, with no-new-privileges enabled. Keep identity state and the control socket protected from agents. Do not expose Docker's socket or sibling environments.

Use an immutable existing Paseo base that contains the required provider tools. Add pinned networking packages through a Dockerfile, never by capturing a populated container. Provider and GitHub logins belong in persistent home, not image layers. Preserve custom web assets through an explicit persistent web-directory configuration.

## Private connectivity

Bind the host-published daemon port to loopback. Use private Tailscale Serve for the daemon and broker-managed HTTPS workspace previews. Grant only intended users the required destination ports. Keep Funnel disabled. Framework listeners must bind a reachable interface and permit their configured hostname.

HTTP remains an insecure browser origin despite Tailscale transport encryption. Install the narrow host broker described in docker/tailscale/README.md for HTTPS lifecycle requests. Configure exact application and WebSocket origins from its reservation. Agent users do not receive Tailscale control privileges.

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
