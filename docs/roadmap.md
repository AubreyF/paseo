# Fork roadmap

These proposals are separate from the container installation path. Recording them does not implement or deploy them.

Unless dated separately, research findings below are from source inspection on September 10, 2026. Unchecked items are pending work, not deployed capabilities. Recording a proposal here does not implement or deploy it.

### Automatic desktop builds and updates

- [ ] Ship automatic custom-branch builds and private app updates for macOS, Windows, and Linux. See the [desktop build proposal](desktop-auto-builds.md) for findings, architecture, platform scope, open versioning decisions, acceptance criteria, and the 7 to 10 engineering-day estimate. Recorded September 16, 2026; implementation is pending.

### Current implementation and acceptance work

- [ ] Complete the remaining [quota reserve integration and acceptance](agent-presets.md#implementation-and-deployment-status).
- [ ] Deploy the tested account-window labeling fix and outstanding daemon fixes through a coordinated daemon update. Preserve each installation's configured default.
- [ ] Complete supervisor/Pi, missing-worker-skill, physical-device, dictation, accessibility, performance, and CI acceptance in the [team handoff checklist](host-handoff.md#acceptance).

### Open an independent agent session from a conversation — deferred

Deferred on September 10, 2026: record the proposal only; implementation and shipping are not scheduled.

Paseo already supports parallel agent-scoped `create_agent` calls, completion notifications, opening subagents, and manual detach. The advertised tool creates a subagent and requires an initial prompt. A legacy compatibility path accepts detached creation, but new work must not depend on that path. See [agent lifecycle](agent-lifecycle.md#relationships) and the [tool implementation](../packages/server/src/server/agent/tools/paseo-tools.ts). These findings describe the checkout; the running private instance was not verified.

- [ ] Add an explicit `open_agent_session` tool for requests such as “open a new thread to investigate X.” Reuse the creation pipeline to create a root session, retaining an origin reference for navigation without parent archive ownership. Keep ordinary `create_agent` behavior unchanged.
- [ ] Start with the requested task and fresh history; use the existing fork-context mechanism only when history copying is requested. Support a literally blank session by leaving it idle without issuing a provider turn.
- [ ] Default to the source session's actual provider/account and supported settings. Validate explicit profile overrides without silently switching accounts. Default to its workspace; use existing workspace/worktree creation for requested isolation.
- [ ] Persist a launch request ID and reconcile retries to the same session. Surface initial execution failures on that session. Carry originating-client identity so only that client opens a background tab, preserving focus and unsent input; other devices discover the session without forced navigation. Reconnect must not duplicate sessions or reopen dismissed tabs.
- [ ] Add a session-started result with an Open action. Gate new interface behavior behind Vorton and daemon capability support, preserving Paseo mode. Keep wire additions optional and use dotted names for new RPCs.
- [ ] Verify parallel execution, independent source archive/stop, normal workspace archive behavior, account selection, duplicate prevention, reconnect, and Vorton off/on behavior. Run required checks and publish a tested private web export when implementation is authorized; coordinate daemon deployment and obtain physical-device confirmation for touch behavior.

Planning estimate: **18–32 machine-hours; budget 24**. Breakdown: tool/configuration 2–4, creation/lifecycle/retries 4–7, protocol/device targeting 3–5, client presentation 3–5, focused tests 4–7, checks/private preview verification 2–4. Machine-hours mean cumulative active coding-agent time, including builds and debugging; human review, device confirmation, and approval waits are excluded. Existing parallel subagent creation needs no implementation; a smaller usability pass around that flow is estimated at 3–6 machine-hours.

### Cross-device message queues

Queued composer messages currently live only in the originating client's memory. They are not visible on another device and are lost on a full reload. Unsent drafts are persisted locally; submitted messages and accepted steering enter the daemon timeline. See [queue actions](../packages/app/src/composer/actions.ts) and [client queue draining](../packages/app/src/runtime/host-runtime.ts).

- [ ] Move explicit queues into durable per-agent daemon storage with stable message IDs, ordering, revisions, and attachment references accessible from other devices. Keep unsent drafts local initially.
- [ ] Add capability-gated queue RPCs and revisioned subscriptions for viewing, adding, editing, removing, and sending now. Reconnect from an authoritative snapshot; reject conflicting edits.
- [ ] Dispatch through one serialized daemon admission path shared with reserve enforcement. User messages take precedence over generated goal continuations. Manual stops, Redline, archive, and exhaustion must prevent unintended delivery.
- [ ] Reconcile ambiguous delivery before retrying. Do not claim exactly-once provider execution without provider support. Explicitly import existing local queues only after durable acknowledgement and prevent their old client drain from also sending them.
- [ ] Verify two-device visibility, attachments, closure of the originating client, reload, restart, lost acknowledgements, and edit/delete/send races. Add accessible Vorton controls and verify off/on behavior.

Synchronizing the existing client map alone is insufficient: multiple clients could drain it, and an idle-check race can turn an ordinary send into an interruption of newly started work.

### Long-term goals across models

Paseo already exposes Codex-native `/goal <objective>`, `pause`, `resume`, and `clear` through the [Codex adapter](../packages/server/src/server/agent/providers/codex-app-server-agent.ts). Bare `/goal` currently prints usage rather than status. OMP goal events appear as timeline notices. Neither provides a shared daemon-owned goal lifecycle or dashboard. Existing [Codex goal tests](../packages/server/src/server/daemon-e2e/codex-goal-mid-turn.real.e2e.test.ts) were inspected during research, not rerun against this installation.

- [ ] Add durable goals with objectives, acceptance criteria, checkpoints, evidence, linked runs, budgets, revisions, and explicit stop reasons. Expose scoped tools, RPCs, and cross-device state.
- [ ] Give each execution exactly one continuation owner. Daemon-managed goals use bounded provider turns; never run a native autonomous goal loop alongside the daemon loop or silently convert existing goals.
- [ ] Integrate continuation with queued messages and reserve admission. Persist intent before dispatch, reconcile restart ambiguity, honor permission waits and manual stops, and block repeated attempts without progress.
- [ ] Require completion evidence or user acceptance. Agent tools must not raise budgets, switch accounts, or override pauses. Show measured usage separately from unavailable data; exact token and cost limits depend on provider support.
- [ ] Qualify Codex Secondary and Pi first, then Claude Code, Copilot, and OpenCode. Transfer objectives and checkpoints through reviewed successors; provider-private session state does not transfer across models.
- [ ] Add a Vorton goal card and inspector with accessible progress, evidence, blockers, and pause/resume/stop controls. Test two-device changes, restart recovery, worker races, false completion, and native-loop conflicts.

Proposed sequence: provider boundary checks, durable lifecycle and admission, Vorton controls, then failure and deployment validation. Initial sizing is 10-15 engineer-days for a Codex/Pi MVP and 20-30 total for a hardened multi-provider rollout, assuming shared reserve and queue admission foundations exist. Allow roughly 5-8 additional days if those foundations are included. These are estimates, not elapsed-time commitments.

Both proposals require a tested daemon update and the [container web build, persistent publication, and private HTTPS verification workflow](instance-continuity.md#publish-a-web-only-change). Web publication alone cannot activate daemon behavior.
