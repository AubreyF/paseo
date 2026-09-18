# Paseo + Vorton Roadmap

### Automatic desktop builds and updates

- [ ] Ship automatic custom-branch builds and private app updates for macOS, Windows, and Linux. See the [desktop build proposal](desktop-auto-builds.md) for findings, architecture, platform scope, versioning requirements, acceptance criteria, and the 7 to 10 engineering-day estimate. Recorded September 16, 2026; implementation is pending.

### Current implementation and acceptance work

- [ ] Complete the remaining [quota reserve integration and acceptance](agent-presets.md#implementation-and-deployment-status).
- [ ] Deploy the tested account-window labeling fix and outstanding daemon fixes through a coordinated daemon update. Preserve each installation's configured default.
- [ ] Complete supervisor/Pi, missing-worker-skill, physical-device, dictation, accessibility, performance, and CI acceptance in the [team handoff checklist](host-handoff.md#acceptance).

### Long-term goals across models

Paseo already exposes Codex-native `/goal <objective>`, `pause`, `resume`, and `clear` through the [Codex adapter](../packages/server/src/server/agent/providers/codex-app-server-agent.ts). Bare `/goal` currently prints usage rather than status. OMP goal events appear as timeline notices. Neither provides a shared daemon-owned goal lifecycle or dashboard. Existing [Codex goal tests](../packages/server/src/server/daemon-e2e/codex-goal-mid-turn.real.e2e.test.ts) were inspected during research, not rerun against this installation.

- [ ] Add durable goals with objectives, acceptance criteria, checkpoints, evidence, linked runs, budgets, revisions, and explicit stop reasons. Expose scoped tools, RPCs, and cross-device state.
- [ ] Give each execution exactly one continuation owner. Daemon-managed goals use bounded provider turns; never run a native autonomous goal loop alongside the daemon loop or silently convert existing goals.
- [ ] Integrate continuation with queued messages and reserve admission. Persist intent before dispatch, reconcile restart ambiguity, honor permission waits and manual stops, and block repeated attempts without progress.
- [ ] Require completion evidence or user acceptance. Agent tools must not raise budgets, switch accounts, or override pauses. Show measured usage separately from unavailable data; exact token and cost limits depend on provider support.
- [ ] Qualify Codex Secondary and Pi first, then Claude Code, Copilot, and OpenCode. Transfer objectives and checkpoints through reviewed successors; provider-private session state does not transfer across models.
- [ ] Add a Vorton goal card and inspector with accessible progress, evidence, blockers, and pause/resume/stop controls. Test two-device changes, restart recovery, worker races, false completion, and native-loop conflicts.

Both proposals require a tested daemon update and the [container web build, persistent publication, and private HTTPS verification workflow](instance-continuity.md#publish-a-web-only-change). Web publication alone cannot activate daemon behavior.
