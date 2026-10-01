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

### Account connectors

The Codex naming update is published in the web interface. The Add provider entry is **Codex (ChatGPT account)**. Each new account suggests **Codex N**, counting enabled additional Codex providers on the selected host, excluding the built-in CLI entry and skipping existing names, including names held by disabled accounts. The suggestion remains editable. Two enabled additional accounts produce **Codex 3** unless that name is already taken.

The complementary connector is **Claude Code (Claude account)**. It wraps the official CLI's browser login inside the account panel. The CLI owns authentication and credential storage; tasks still run on the host.

- [x] Add the account catalog entry, editable **Claude N** suggestions, account creation RPC and isolated configuration directories.
- [x] Support browser return codes, cancellation, expiry, reconnect and authentication checks through the official CLI.
- [x] Keep credentials, session history, resumed tasks, model settings and usage scoped to the selected account. Preserve shared and external directories on removal.
- [ ] Activate the daemon and interface updates in the primary installation and complete a real subscription sign-in and task.

The browser flow requires a host with Claude Code installed. New container builds include it. Older hosts show an update message until they advertise account creation support. The built-in CLI provider remains available for existing configurations.

Claude Code retains its [official CLI login flow](https://code.claude.com/docs/en/authentication). This implementation uses that CLI and does not implement a separate OAuth client. Anthropic's [third-party authentication guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) still applies; CLI availability does not establish approval for third-party subscription authentication.
