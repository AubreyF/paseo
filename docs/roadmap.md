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

For the complementary connector, use **Claude Code (Claude account)**. Both connectors run the provider's coding runtime on the host; “Web” would describe the sign-in surface rather than where tasks run. The Claude connector is a proposal, not implemented behavior. The current delivery scope is CLI sign-in guidance and accurate authentication monitoring for the existing connector.

The immediate Claude change uses the existing connector. Its details explain how to open the container shell and run `claude auth login` and `claude auth status`. The daemon availability probe checks the CLI's authentication result before advertising readiness. The Vorton provider settings screen refreshes that check every minute while active. The daemon update requires a coordinated restart before these checks take effect.

- [ ] Add **Claude Code (Claude account)** to the web interface for connecting additional accounts, distinct from the auto-detected CLI provider.

Reuse the existing Claude Agent SDK adapter with private `CLAUDE_CONFIG_DIR` directories and account-scoped history, resume, credentials and usage. First confirm the authentication route: Anthropic requires prior approval for third-party products offering claude.ai login. Without that approval, choose API credentials or leave sign-in in the official CLI. Then prove remote login completion for the chosen route and extend the existing account controls and compatible login protocol.

Target 1 to 2 engineering hours for a minimal implementation only if that experiment confirms a supported flow. Budget the work as 20 minutes to prove authentication, 40 minutes to reuse account creation and isolated runtime configuration, and 60 minutes for lifecycle handling and focused validation. Re-estimate if authentication requires unsupported endpoints or new infrastructure. Acceptance requires two isolated accounts, cancellation and timeout handling, correct signed-out status, and no credentials in logs or browser storage. Cross-platform acceptance and a new OAuth implementation are outside this estimate.

Claude Code retains its [official CLI login flow](https://code.claude.com/docs/en/authentication). Anthropic's [third-party authentication guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) is a separate constraint; the continued availability of CLI login does not establish permission to offer a third-party subscription login flow.

Account isolation groundwork is implemented: configured Claude providers use their own environment for session discovery, resumed history and model settings. Account creation also has a retry-safe persistence helper, and managed-file removal recognizes Claude directories while preserving shared and external storage. Legacy configuration removal cannot orphan those managed files. Activation requires a daemon update. The additional-account RPC, UI and authentication lifecycle remain pending.
