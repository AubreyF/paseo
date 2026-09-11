# Host migration handoff

Keep an installation handoff outside Git. Include the current repository revision, active work, private deployment configuration, backed-up state, image references and verified acceptance evidence. Do not place credentials or machine-specific records in public documentation.

On the destination, read repository instructions, [agent presets](agent-presets.md), [development continuity](instance-continuity.md) and the relevant [container recipe](../docker/multiplex/README.md). Inspect installed tools, model endpoints, provider identities and mounted state. A label or previous host's successful test is not evidence that the destination works.

Authenticate accounts independently and transfer private state only through a reviewed private process. Preserve existing services. Coordinate any interruption, take consistent backups and retain rollback artifacts. Verify Vorton off/on behavior, actual model calls, bounded workers, private remote access, persistence and physical-device features. Do not automatically resume old schedules or interrupted tasks from a handoff document.
