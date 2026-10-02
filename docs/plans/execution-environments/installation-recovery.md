# Reconstructible installation and later migration

Status: future operational project. It must not block the additive host release.

Replace reliance on nonpersistent executable overlays with versioned, reconstructible releases and explicit persistent state. The host diagnostic found that image and Compose configuration alone could not recreate the observed primary installation. Keep exact paths and recovery receipts outside Git.

Inventory launchers, release overlays, temporary dependencies, identity, accounts, active jobs, network routes, watchdogs, and persistent storage. Produce a consistent backup method rather than assuming a copy of mutable files is a snapshot. Test reconstruction in an isolated instance with external actions disabled.

Acceptance: restore the recorded version and identity safely, verify state and route ownership, demonstrate rollback, and account for unfinished tasks. Never run two daemons against one writable state directory.

Only after this project should migration from the primary Docker installation to another runtime be considered. Schedule interruption explicitly with the owner. The first host release neither needs nor authorizes production recreation, Docker restart, bulk container cleanup, or route reassignment.
