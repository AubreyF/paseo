# Task containers through Docker

Status: future project, not required for native host execution.

Build host-owned creation, inspection, start, stop, and removal of task containers. Running Vorteo inside Docker today does not provide these orchestration capabilities. Reuse Docker rather than replacing the current development container.

Define a small lifecycle contract with environment ID, generation, image digest, approved mounts, CPU/memory limits, state, and connection endpoint. Keep runtime credentials and sockets on the host. Run a normal daemon inside agent workspaces so terminals, files, Git, and agents share one boundary. Service-only test containers need no daemon.

Start with a fixed image and manually approved directories. Dynamic folder browsing and credential brokering are separate projects. Document Docker's shared-kernel boundary on Linux; do not claim equivalence to a VM boundary.

Acceptance: two concurrent environments, restart reconciliation, failed-start cleanup, bounded resources, separate state, no runtime socket in guests, and deletion that preserves source/data unless explicitly requested. Qualify native Linux separately from Docker Desktop.

Can ship before Apple support. Share lifecycle definitions with that backend, not platform-specific commands. Estimate after the first release settles; the previous 2 to 4 day second-backend allowance assumed this contract already existed and excluded full cross-platform qualification.
