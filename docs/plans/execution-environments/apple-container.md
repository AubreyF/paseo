# Apple Container backend

Status: future project. Host hardware eligibility was observed; installation and coexistence were not tested.

Add Apple's Container runtime as an optional macOS backend for Linux task environments. It can coexist with the existing Docker Desktop installation. It is not a macOS guest runtime and does not automatically replace the primary development container. Linux hosts retain Docker.

Implement the lifecycle contract owned by the task-container project. Either backend can be implemented first; neither should force the other to adopt its command syntax or isolation claims. OCI image compatibility, mounts, networking, logs, readiness, and cleanup require actual tests.

First run a small bounded pilot without resizing Docker Desktop. Measure resident memory, memory pressure, swap, peak concurrency, and reclamation after workload completion and container stop. Do not promise elastic live resizing or efficient reclamation based only on a configurable memory limit.

Acceptance: simultaneous Docker and Apple workloads, useful memory evidence, mount semantics, recovery after interruption, and clean removal without disturbing production. Compare the same representative workload and image where supported.

Prior research: [Apple Container](https://github.com/apple/container), its [technical overview](https://github.com/apple/container/blob/main/docs/technical-overview.md), and [releases](https://github.com/apple/container/releases). Recheck runtime behavior and version support at implementation time. No runtime installation is authorized by this document.
