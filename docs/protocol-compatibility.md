# Protocol Compatibility

The app and the daemon are separate products that ship separately. A user updates the app from an app store or a desktop auto-update; they update the daemon when they feel like it. Every combination happens in the wild: new app against an old daemon, old app against a new daemon, and both sides months apart.

In development both sides are always the same version, which is why this is the constraint contributors miss most often.

Two contracts follow from it.

## The protocol contract: always compatible

A schema change must not break parsing in either direction. An old app still parses messages from a new daemon. A new daemon still parses messages from an old app.

- New fields are `.optional()` with a sensible default.
- Never flip optional to required, remove a field, or narrow a type. `string` to `enum` and nullable to non-null are both narrowing.
- A field you stop sending stays accepted. You stop writing it, you don't stop reading it.
- Wire schemas are pure structural declarations. No `.transform()`, `.catch()`, or `.preprocess()` on WebSocket message schemas — normalization happens in an explicit pass after validation. The reason is in [protocol-validation.md](protocol-validation.md): inbound validators are generated, and the generator only compiles pure schemas.
- Plain `z.union()` is forbidden when every branch shares a literal tag. Use `z.discriminatedUnion()`.
- `.default()` belongs on primitive leaves only, never on item schemas inside large arrays or big inbound containers.

Two questions to ask before you commit a schema change:

1. Does a six-month-old app still parse this message?
2. Does a six-month-old daemon still send something this app accepts?

If you can't answer both with yes, the change isn't done.

Schemas live in `packages/protocol/src/messages.ts`. New RPC names follow [rpc-namespacing.md](rpc-namespacing.md).

## The feature contract: per feature, gated once

Features don't have to work across versions. A new feature usually needs a new daemon capability, and old daemons don't have it.

The app checks for the capability and either runs the feature or tells the user to update the host.

- **No fallback paths.** Don't build a degraded version of the feature for old daemons. Don't fan out across legacy RPCs to simulate a capability that isn't there. The user updates or doesn't get the feature.
- **No defensive branches spread through the feature.** Detection happens in one place, and everything downstream reads a clean shape.
- Capability flags live in `features` on the `server_info` message (`packages/protocol/src/messages.ts`, the `server_info` schema).

Existing functionality keeps working across versions because of the protocol contract. Gating a new feature never substitutes for that.

## Every shim is tagged and dated

A shim that exists for old-app or old-daemon support carries a comment naming it, the version it arrived in, and when it can go:

```ts
// COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
```

`rg "COMPAT\("` is the full cleanup backlog, so:

- One tag per shim, at the site that has to be deleted.
- Give it a name, a version, and a removal condition or date. Six months out is the usual default.
- Never bury compatibility in an untagged `??` fallback or an optional-chain tunnel. Untagged back-compat never gets removed, because nobody can find it.

When a tag's condition is met, delete the shim and the tag in the same change.

## QA

Tests don't fully cover compatibility. If you touched `packages/protocol`, say in the pull request why an older app still parses your message and why an older daemon still satisfies your app. See [qa.md](qa.md).

## Schedule configuration revisions

Schedule configuration edits can use `expectedConfigurationRevision` when the host advertises `scheduleConfigurationRevision`. Pass the revision returned by inspection, or explicit `null` for a legacy record without one. The daemon compares it within the serialized update and rejects a stale edit before changing the record. Reload and reconcile edits after a conflict. Omitted revisions retain older clients' partial-update behavior.

Configuration revisions change when the name, prompt, cadence, target configuration, maximum runs or expiration changes. Run history, quota observations and pause/resume activity preserve them. Revisions protect configuration edits; they do not establish quota authority or reset account accounting.

The schedule update CLI inspects the record before editing and supplies its revision on capable hosts, including explicit `null` for a legacy record. It reports conflicts without retrying. Older hosts retain ordinary partial updates when no revision is present; a known revision is never discarded to force a write.

## Schedule quota policies

A client must require `server_info.features.scheduleQuotaPolicy === true` before creating a schedule with `target.config.quotaPolicy` or updating `newAgentConfig.quotaPolicy`, including explicit removal with `null`. An older daemon may discard an unknown policy field and launch ordinary work. The client rejects these writes before transmission rather than retrying without the policy. Schedule writes that omit the policy retain their existing compatibility behavior.

The capability means the daemon recognizes quota policies and fails closed when it cannot execute governed work. It does not certify available usage telemetry, account authority, a ready execution backend, or permission to remove an enforced account policy. Those remain server-side admission requirements. Protected writes use the existing nonqueued request path, so a disconnected client cannot replay them onto a different host after reconnecting.

## Governed run custody

A governed run records optional `governorBinding` metadata containing its verified account and reservation identifier. The trusted execution driver supplies this binding before the scheduler records the run. Resumption requires the exact retained binding; a legacy run without one needs reconciliation. The metadata links recovery records and does not grant execution authority.

Restart recovery, edit guards and deletion guards recognize unfinished governed runs independently of the schedule's editable quota policy. A frozen run remains unfinished. Deletion checks run inside the schedule mutation, and admission verifies the current record before asking the driver to prepare work. Older clients may omit this optional response field, but replacing the daemon with a policy-unaware version still requires separate installation safeguards.
