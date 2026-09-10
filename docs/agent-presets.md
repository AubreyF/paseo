# Launch presets and managed workers

Launch presets extend the existing `daemon.agentProfiles` collection. There is no second preset database or orchestration service. The bundled web client and native clients share the editor and composer components.

For the experimental fork's host migration, pending work and destination acceptance checks, read [the host handoff](host-handoff.md).

## Configuration and compatibility

A profile can include `instructions`, `workerProfileId`, and `maxWorkers` in addition to its existing provider, model, reasoning and feature values. Worker profiles require an explicit model and cannot reference another worker. Names and model IDs remain user configuration.

New hosts advertise `agentProfileLaunch`. A launch request carries `profileId`; the server resolves the current profile and freezes its instructions and worker configuration into the stored session. Later profile edits affect new tasks, not resumed tasks. The separate composer permission selection takes precedence over legacy profile mode fields. Classic mode remains available.

New editors send `expectedAgentProfiles` for stale-write detection. The server preserves omitted instruction and worker fields from older editors. Empty strings explicitly clear instructions and worker references. An older host does not expose these launch-only controls.

## Supervision

The supervisor uses existing Paseo agent tools. Its frozen worker reference determines the child profile and maximum concurrent managed workers. Child creation and execution enforce the limit. Managed children cannot detach through `create_agent`; recursive worker presets are rejected. Team presets require agent-tool injection to be enabled explicitly.

This is lifecycle coordination, not a new security sandbox. Pi has no native selectable permission modes. In a per-person container, Pi can access that person's mounted projects and keys. Other processes and native provider subagents are outside the managed-child concurrency limit. See [the optional deployment recipe](../docker/multiplex/README.md).

## Quota stops and explicit successors

The Codex adapter maps structured `usageLimitExceeded` errors to a provider-neutral `quota_exhausted` event. Transport errors do not imply exhausted quota. The manager persists `quotaPausedAt`, blocks subsequent turns and worker creation, cancels active managed teammates, and suppresses completion-triggered wakeups. A confirmed account reset clears earlier quota-exhaustion locks for that provider so you can send the next message in the same thread. It does not send a prompt or clear a reserve stop. Interrupted edits are not rolled back.

Selecting a preset for an existing task opens an editable handoff review and creates a separate successor only after confirmation. It initially copies at most 30 recent text messages and 50,000 characters without making an inference request to the old account. Active managed workers block the handoff. It preserves the selected permission mode and rejects incompatible modes. Attachments, tool outputs, and provider-private state are not copied automatically. The original task remains available for review. Model or reasoning changes made through Classic controls mark the original preset label as modified.

Quota suggestions use fresh reported capacity on a different provider instance. Unknown, stale, and exhausted quotas do not qualify. This is advisory, not account pooling or automatic failover. One account may have multiple aliases; users should avoid treating those as separate allowances.

## Local endpoint status

Local Pi models with an explicit private or loopback HTTP endpoint can report TCP reachability in preset rows. The daemon probes at most sixteen distinct endpoints per catalog refresh and shares each probe across models on that endpoint. The check sends no inference or authentication request. Reachability does not prove that a model is loaded, authentication works, or inference capacity is available. Observations older than two minutes are displayed as stale. Cloud Pi configurations do not inherit a local or free label.

Opening the preset picker refreshes local endpoint status, at most once per minute. There is no manual refresh button in the composer. Local rows also show running child agents for that configured provider in this Paseo instance. The daemon samples its live agent manager when responding to usage requests, independently of cached subscription balances. The picker polls this read every fifteen seconds while open and marks activity older than thirty seconds stale. Counts include children with an admitted active run before a provider reports running. They exclude supervisors, idle or initializing children without a run, native provider subagents, and other instances. They are provider-wide counts, not model-specific slots or MTPLX queue capacity.

## Account reset credits

With Vorton Mode enabled on supported hosts, preset rows and provider Usage cards show the number of reset credits reported for that account. Unknown availability is not zero. Credit details include the account identity, grant date, expiry when reported, and last refresh time. The reported total remains authoritative when the provider supplies only a partial list of credits.

Opening the badge only reads account details. Review reset prepares an account-bound operation; Confirm reset explicitly submits it. The daemon verifies the configured account again before submission. Read access alone cannot prepare or redeem a reset, and agent tools do not expose redemption.

Reset management uses separate account-scoped RPCs so older hosts and clients can continue using existing usage messages. The daemon checks the configured CLI's actual reset and idempotency support before enabling redemption. It does not guess support from a version number or use an unrelated desktop account.

Aliases for the same account share a persistent operation record under the Paseo home. An interrupted confirmation retains its operation key across daemon restarts. Explicit retry reconciles that same operation, including when the available count has already fallen to zero. It does not allocate a new key to resolve uncertainty. Back up these records together with the person's Paseo home.

Results distinguish applied, already redeemed, no credit, and nothing to reset. A failed balance refresh does not turn a confirmed result into an unknown redemption. Redemption neither buys credits nor switches accounts or resumes work. A successful reset unlocks earlier quota-stopped threads on the selected provider. Newer quota stops remain locked, and duplicate confirmation uses the original operation cutoff. Grant schedules and availability remain provider-controlled.

## Review boundaries

Vorton Mode defaults off and is saved per device. General settings and the sidebar's Paseo/Vorton selector control the same preference. Enabling it exposes named launch presets, usage rails, reset controls, and supervisor configuration. Disabling it restores standard composer controls without deleting accounts or presets or stopping running tasks. Manage presets lives inside the preset picker.

The approved reserve policy is described below. Its daemon enforcement and controls are not implemented yet. The current quota-exhaustion stop does not enforce it.

The Docker recipe is optional. Upstream core does not require Docker, MTPLX, a particular account naming scheme, or an inference gateway. Keep deployment changes reviewable separately from profile UI, launch resolution, and quota lifecycle changes. Local builds must be reviewed before any upstream publication.

## Default configuration

Manage presets in host settings includes Default configuration. The selected profile stores `isDefault: true` in the host's profile list. The settings control writes false on other profiles so only one is selected. Require a selection disables the default. Removing the default does not silently choose another account. Both profile editors retain this marker when editing a profile.

New Vorton drafts visibly apply an available default. Otherwise submission and audio start are blocked until a profile is selected. The new-workspace creation handler also rejects a missing Vorton profile. Existing chats are not changed. Standard Paseo behavior is unchanged.

## Quota reserve implementation contract

Approved September 10, 2026. Cruise Reserve defaults to 15 percent remaining; Redline defaults to 10 percent. Profiles provide defaults, tasks freeze the effective policy at launch, and an explicit task override can disable reserve enforcement. Actual provider quota exhaustion remains enforced with reserve Off. Do not attach the new policy to existing tasks automatically.

Below Cruise Reserve, let already-running turns finish and block new turns and managed workers. At or below Redline, request immediate cancellation of active turns and managed workers. Cancellation and usage-reporting latency can consume allowance beyond Redline; it cannot guarantee a retained balance.

Evaluate every applicable rolling window separately. Only fresh observations with all required windows above Cruise Reserve can automatically continue work paused by that policy. Equality retains an existing pause. Missing or stale usage blocks admission and automatic recovery but does not fabricate a Redline crossing. A Redline stop requires explicit continuation after recovery. Actual quota exhaustion requires a confirmed account reset or a reviewed successor. Completed, manually stopped, archived, and exhausted tasks never wake automatically.

Keep policy state separate from `quotaPausedAt`. Persist stop reason and continuation eligibility before effects, serialize admission against policy transitions, and reconcile interrupted work on daemon startup before permitting continuation. Enforce the policy with every browser closed. Share observations by verified account and quota scope; task thresholds remain independent. Purchased credits and unrelated code-review limits do not establish coding-task capacity.

The third borderless composer control follows permissions and shows both thresholds. Gate presentation and new launch policy attachment on Vorton and a daemon capability. Turning Vorton off does not change policies already attached to tasks. New protocol fields stay optional; unsupported hosts require an update rather than browser-only enforcement.

Acceptance includes threshold equality, multiple windows, stale data, manual stops, worker completion races, restart recovery, and duplicate wake prevention. Deploy through the [instance continuity workflow](instance-continuity.md); source and web publication alone cannot activate daemon enforcement.
