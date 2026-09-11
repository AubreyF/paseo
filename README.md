# "Vorton Mode" for Paseo

[Paseo](https://github.com/getpaseo/paseo) is the ultimate open source visual control plane for human-supervised software development.
Aubrey's experimental fork here adds frontier provider account multiplexing and utilization monitoring, frontier subscription reset management, named agent configurations, improved mobile/tablet ux, and bounded local workers. Normal Paseo remains functional in this fork. Activate **Vorton** in the sidebar to take your dev fleet to the next level.

## What you can do

- **Save launch presets.** Combine a provider account, model, reasoning setting, instructions, and optional worker configuration. Select a preset from the composer; open **Manage presets** at the bottom of its picker to edit it.
- **See account capacity alongside your choices.** Inspect reported rolling usage windows and reset timing before launching work. Unknown or stale readings are not available capacity. Separate names do not prove separate authenticated accounts.
- **Review reset credits explicitly.** Supported accounts expose reported credits and account details. Redemption requires account-specific confirmation and compatible provider support. A reset does not switch accounts or restart stopped tasks.
- **Supervise bounded local work.** A frontier supervisor can use a configured Pi worker preset with a maximum managed-worker count. Run MTPLX natively on the Mac and connect Pi to its actual authenticated model endpoint.
- **Continue through a reviewed successor.** Changing an existing task's preset creates a separate task after you review the handoff. Structured hard-quota exhaustion stops the task and its managed workers. Accounts never silently switch.

The preset picker shows selection checkmarks, usage beneath each name, and an adjacent inspector. Permissions remain a separate composer choice. Switching back to **Paseo** hides the extra controls without deleting your configuration or stopping tasks.

The browser and daemon must both support these additions. Updating only the browser cannot upgrade a connected daemon. The source sidebar shows a compatibility message when Vorton is enabled against an unsupported connected host; deployed images must include that change to display it.

See [launch presets and managed workers](docs/agent-presets.md) for behavior and limits.

## Set up your host

Follow the [multiplex deployment guide](docker/multiplex/README.md). Use a verified successful image build from this fork and pin its revision. A pushed commit does not guarantee that its image exists.

Give each person a separate container, persistent home, project directory, password, and loopback port. Authenticate each provider account independently in its configured credential directory. Verify the actual identity, model catalog, and utilization before using it. Keep credentials and account state outside Git and image layers.

On a Mac, run Tailscale and MTPLX natively. Containers supply the Linux agent environment. Native macOS tools and projects that require Xcode or other Mac integrations may need a separate native daemon. Preserve existing services when introducing an experimental instance.

## Private access from your phone and other computers

Use **Tailscale Serve** to put the container's bundled web interface behind private HTTPS. Install Tailscale on the host and each client device, then connect them to your intended private network. Keep the application password enabled.

Follow the [remote access setup and verification steps](docker/multiplex/README.md#private-https-with-tailscale). On an iPhone or iPad, connect Tailscale and open the resulting HTTPS address in Safari. Use that address on your other development machines too. The remote browser connects to the hosted daemon, so its project paths refer to the host's container.

Serve the bundled web interface rather than the development preview on port 8081. Updating source files does not update a running image. For an existing installation, publish a tested web export using the persistent web workflow below. Server changes still require a reviewed server build and coordinated deployment.

Remote availability depends on the Mac staying awake, Docker running, and Tailscale staying connected. Verify startup and recovery before treating the machine as unattended infrastructure.

## Experimental status

Implemented behavior and destination validation are separate. The handoff includes preset launches, managed-worker limits, usage presentation, reset capability checks, and durable hard-quota stops. Each deployment still needs account authentication and end-to-end validation.

**Cruise Reserve and Redline are not implemented.** Their defaults and interruption semantics are approved in the [quota reserve contract](docs/agent-presets.md#quota-reserve-implementation-contract). Do not rely on automatic reserve pausing or resumption yet.

Before relying on a new host, verify a real supervisor-to-Pi task, independent account identities and usage, container boundaries, remote browser layouts, and microphone dictation. Endpoint reachability alone does not prove inference works. A visible microphone button does not prove speech recognition is configured.

## To-do

Research findings below are from source inspection on September 10, 2026. Unchecked items are pending work, not deployed capabilities. Queue and cross-model goal designs are proposals; recording them here does not activate either feature.

### Current implementation and acceptance work

- [ ] Implement the approved [quota reserve contract](docs/agent-presets.md#quota-reserve-implementation-contract), including durable admission, worker handling, recovery, profile defaults, and task overrides.
- [ ] Deploy the tested account-window labeling fix and outstanding daemon fixes through a coordinated daemon update. Preserve each installation's configured default.
- [ ] Complete supervisor/Pi, missing-worker-skill, physical-device, dictation, accessibility, performance, and CI acceptance work tracked in [instance continuity](docs/instance-continuity.md).

### Open an independent agent session from a conversation — deferred

Deferred on September 10, 2026: record the proposal only; implementation and shipping are not scheduled.

Paseo already supports parallel agent-scoped `create_agent` calls, completion notifications, opening subagents, and manual detach. The advertised tool creates a subagent and requires an initial prompt. A legacy compatibility path accepts detached creation, but new work must not depend on that path. See [agent lifecycle](docs/agent-lifecycle.md#relationships) and the [tool implementation](packages/server/src/server/agent/tools/paseo-tools.ts). These findings describe the checkout; the running private instance was not verified.

- [ ] Add an explicit `open_agent_session` tool for requests such as “open a new thread to investigate X.” Reuse the creation pipeline to create a root session, retaining an origin reference for navigation without parent archive ownership. Keep ordinary `create_agent` behavior unchanged.
- [ ] Start with the requested task and fresh history; use the existing fork-context mechanism only when history copying is requested. Support a literally blank session by leaving it idle without issuing a provider turn.
- [ ] Default to the source session's actual provider/account and supported settings. Validate explicit profile overrides without silently switching accounts. Default to its workspace; use existing workspace/worktree creation for requested isolation.
- [ ] Persist a launch request ID and reconcile retries to the same session. Surface initial execution failures on that session. Carry originating-client identity so only that client opens a background tab, preserving focus and unsent input; other devices discover the session without forced navigation. Reconnect must not duplicate sessions or reopen dismissed tabs.
- [ ] Add a session-started result with an Open action. Gate new interface behavior behind Vorton and daemon capability support, preserving Paseo mode. Keep wire additions optional and use dotted names for new RPCs.
- [ ] Verify parallel execution, independent source archive/stop, normal workspace archive behavior, account selection, duplicate prevention, reconnect, and Vorton off/on behavior. Run required checks and publish a tested private web export when implementation is authorized; coordinate daemon deployment and obtain physical-device confirmation for touch behavior.

Planning estimate: **18–32 machine-hours; budget 24**. Breakdown: tool/configuration 2–4, creation/lifecycle/retries 4–7, protocol/device targeting 3–5, client presentation 3–5, focused tests 4–7, checks/private preview verification 2–4. Machine-hours mean cumulative active coding-agent time, including builds and debugging; human review, device confirmation, and approval waits are excluded. Existing parallel subagent creation needs no implementation; a smaller usability pass around that flow is estimated at 3–6 machine-hours.

### Cross-device message queues

Queued composer messages currently live only in the originating client's memory. They are not visible on another device and are lost on a full reload. Unsent drafts are persisted locally; submitted messages and accepted steering enter the daemon timeline. See [queue actions](packages/app/src/composer/actions.ts) and [client queue draining](packages/app/src/runtime/host-runtime.ts).

- [ ] Move explicit queues into durable per-agent daemon storage with stable message IDs, ordering, revisions, and attachment references accessible from other devices. Keep unsent drafts local initially.
- [ ] Add capability-gated queue RPCs and revisioned subscriptions for viewing, adding, editing, removing, and sending now. Reconnect from an authoritative snapshot; reject conflicting edits.
- [ ] Dispatch through one serialized daemon admission path shared with reserve enforcement. User messages take precedence over generated goal continuations. Manual stops, Redline, archive, and exhaustion must prevent unintended delivery.
- [ ] Reconcile ambiguous delivery before retrying. Do not claim exactly-once provider execution without provider support. Explicitly import existing local queues only after durable acknowledgement and prevent their old client drain from also sending them.
- [ ] Verify two-device visibility, attachments, closure of the originating client, reload, restart, lost acknowledgements, and edit/delete/send races. Add accessible Vorton controls and verify off/on behavior.

Synchronizing the existing client map alone is insufficient: multiple clients could drain it, and an idle-check race can turn an ordinary send into an interruption of newly started work.

### Long-term goals across models

Paseo already exposes Codex-native `/goal <objective>`, `pause`, `resume`, and `clear` through the [Codex adapter](packages/server/src/server/agent/providers/codex-app-server-agent.ts). Bare `/goal` currently prints usage rather than status. OMP goal events appear as timeline notices. Neither provides a shared daemon-owned goal lifecycle or dashboard. Existing [Codex goal tests](packages/server/src/server/daemon-e2e/codex-goal-mid-turn.real.e2e.test.ts) were inspected during research, not rerun against this installation.

- [ ] Add durable goals with objectives, acceptance criteria, checkpoints, evidence, linked runs, budgets, revisions, and explicit stop reasons. Expose scoped tools, RPCs, and cross-device state.
- [ ] Give each execution exactly one continuation owner. Daemon-managed goals use bounded provider turns; never run a native autonomous goal loop alongside the daemon loop or silently convert existing goals.
- [ ] Integrate continuation with queued messages and reserve admission. Persist intent before dispatch, reconcile restart ambiguity, honor permission waits and manual stops, and block repeated attempts without progress.
- [ ] Require completion evidence or user acceptance. Agent tools must not raise budgets, switch accounts, or override pauses. Show measured usage separately from unavailable data; exact token and cost limits depend on provider support.
- [ ] Qualify Codex Secondary and Pi first, then Claude Code, Copilot, and OpenCode. Transfer objectives and checkpoints through reviewed successors; provider-private session state does not transfer across models.
- [ ] Add a Vorton goal card and inspector with accessible progress, evidence, blockers, and pause/resume/stop controls. Test two-device changes, restart recovery, worker races, false completion, and native-loop conflicts.

Proposed sequence: provider boundary checks, durable lifecycle and admission, Vorton controls, then failure and deployment validation. Initial sizing is 10-15 engineer-days for a Codex/Pi MVP and 20-30 total for a hardened multi-provider rollout, assuming shared reserve and queue admission foundations exist. Allow roughly 5-8 additional days if those foundations are included. These are estimates, not elapsed-time commitments.

Both proposals require a tested daemon update and the [container web build, persistent publication, and private HTTPS verification workflow](docs/instance-continuity.md#live-web-publishing). Web publication alone cannot activate daemon behavior.

## Develop this fork

Use the [development guide](docs/development.md) for the local preview and builds, and the [host handoff](docs/host-handoff.md) for migration constraints and outstanding acceptance checks. Review worker diffs independently and run targeted tests before accepting changes.

This remains an enhancement of Paseo rather than a separate orchestration platform. Upstream attribution and the existing [license](LICENSE) are retained.

For development from a chat inside this installation, use the [instance continuity prompt and live web publishing workflow](docs/instance-continuity.md). Interface work must be published to the private instance, not only the local preview.

## Touch use in Vorton

Vorton makes workspace actions visible without hover, enlarges touch targets and text, and avoids desktop hover popups on iPad and iPhone. Switching back to Paseo restores the standard interface and your saved appearance. See [the touch audit](docs/vorton-touch-audit.md) for validation details and [the continuity guide](docs/instance-continuity.md) to develop and publish changes from inside this instance.
