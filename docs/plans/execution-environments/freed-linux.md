# Linux Freed soak testing

Status: future project owned jointly by the Freed test harness and optional Vorteo task scheduling.

Package reproducible Linux headless builds with synthetic datasets, unique writable volumes, bounded CPU/memory, run IDs, explicit ports, and per-run logs. Start through existing operator-managed Docker before depending on automatic task containers if that is faster.

Define measurable soak outcomes: crash/restart behavior, resource growth over time, data consistency, and cleanup. Record build/image provenance, duration, workload, host pressure, and failure artifacts. Stop only the run's processes and preserve failed-run evidence.

The reviewed Freed Linux desktop vault implementation is incomplete. Headless success must not be reported as macOS desktop, Keychain, WebKit, or Linux desktop acceptance. Select supported components first and track platform gaps separately.

Acceptance: concurrent runs have independent state, produce attributable metrics, survive the intended duration, and leave no orphan services. Native Freed installation isolation is not a prerequisite for Linux headless testing. Apple Container can later run the same compatible Linux image after platform qualification.
