# Host directory browsing and sharing

Status: future project. Existing host-to-container path translation has already been repaired in the observed deployment.

Let the owner browse host directories and grant selected paths to a container from the trusted interface. Browsing permission is not mount permission. Native host workspaces need no container mount and benefit immediately from native browsing.

The host owns canonicalization, grant storage, runtime mount requests, and visible host/guest path mappings. Bind grants to environment identity and generation. Start with selected read-only or read-write roots; do not mount the entire home directory for convenience.

Handle symlink escapes, nonexistent paths, renamed roots, removable-volume identity, spaces, Unicode, and service-context macOS privacy permissions. Keep runtime and credential directories outside eligible roots. Explain when adding a mount requires container replacement; never silently recreate the primary container.

Acceptance: share a new development directory without a Docker command, reject escapes, retain explicit mappings across reconnects, and revoke through a documented stop/recreate workflow where required. Existing open file descriptors and completed writes are not retroactively revoked.

Dependencies: a host service; runtime lifecycle integration only for automatic mounting. Browsing and grant UX can ship independently. Migration of the current primary mounts depends on its recovery project.
