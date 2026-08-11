# Paseo command workspace runtime contract v1

Implement this contract to add a trusted workspace runtime without importing Paseo server code. Use the schemas and types from `@getpaseo/workspace-runtime-contract`; the tested byte examples are in [`examples/v1.json`](examples/v1.json).

## Commands

Your configured command receives one operation:

```text
describe
create --workspace-id <id>
inspect --workspace-id <id>
exec --workspace-id <id>
signal --workspace-id <id> --exec-id <id> --signal <signal>
pause --workspace-id <id>
resume --workspace-id <id>
destroy --workspace-id <id>
reconcile
```

`describe` writes `CommandRuntimeDescribeResponse` JSON to stdout. Lifecycle commands read one `CommandRuntimeLifecycleRequest` JSON value from stdin and write one `CommandRuntimeLifecycleResponse` JSON value to stdout. `create` and `resume` return `state`; `inspect` returns `inspection`; `pause`, `destroy`, and `reconcile` return `ok`. Diagnostics go to stderr. A non-zero wrapper exit means the operation failed.

Paseo sends options from trusted daemon configuration. Secrets never belong in argv or temporary request files. The runtime must reject any `protocolVersion` other than `1` with a clear stderr diagnostic and non-zero exit. Every public v1 object schema is strict at every nested object boundary, so unknown keys—including private authority—fail instead of being stripped. Extensibility belongs only in the explicit `options`, workload `env`, and lifecycle-environment maps. Any public field change requires a new protocol version.

## Exec file descriptors

The workload owns fd 0, 1, and 2. Preserve their normal stdin, stdout, stderr, EOF, exit-code, and signal behavior.

Paseo writes a single newline-terminated `spawn` envelope to fd 3. For pipes, it then closes fd 3. For PTY, fd 3 stays open and carries newline-delimited `resize` and `signal` controls. Validate a resize before changing PTY state; reject an invalid frame without launching, resizing, or signaling anything. Acknowledge every accepted resize on fd 4 with the same id before consuming following workload input.

fd 4 carries newline-delimited process events for both modes. Its lifecycle is exactly `started` -> `eof` -> `exit`. Send `started` after the execution identity can be signaled; Paseo holds early signals until then. A PTY may send `resized` acknowledgements only after `started` and before `eof`; pipes may never send them. Duplicate, out-of-order, wrong-mode, or post-`exit` events are fatal. Close fd 4 after the single authoritative `exit`. An `error` event fails the process. A frame may arrive in partial chunks, but every frame must end in a newline. Malformed frames, a partial frame at EOF, and wrapper exit without the complete lifecycle are fatal. Paseo rejects a protocol failure only after bounded cleanup of that exact execution. PTY output remains raw workload bytes on fd 1. Closing fd 3 is the PTY control EOF; it is not another JSON control frame.

The authoritative fd 4 `exit` preserves the workload code or terminating signal; the wrapper mirrors it when possible. Forward `SIGINT`, `SIGTERM`, and `SIGHUP` received by the wrapper to the workload process group. The separate `signal` command is the bounded cleanup path for `SIGKILL` and wrapper failure. It is idempotent, identifies only the live workload owned by `workspace-id` plus the opaque `exec-id`, and returns only after that workload is gone. Before authoritative `started`, a missing identity is not ready and must fail; after authoritative completion it is already clean. Never reuse an execution identity.

## Lifecycle and ownership

`workspaceId` is the reconciliation and ownership key. `create`, `pause`, `resume`, and `destroy` are idempotent. `inspect` is authoritative after either process restarts. `spawn` fails unless inspection is `ready`. `pause` preserves workspace state; `destroy` removes only resources owned by that workspace. `reconcile` may remove orphaned owned resources and must reject ownership mismatches.

Paseo addresses only `workspaceId`. The runtime keeps physical placement private and validates the optional workspace-relative `cwd` once, including traversal and symlink escapes; omission means workspace root. It executes `argv` directly, never as an implicit shell string, with exactly the provided workload environment. Do not inherit the wrapper or daemon environment. Lifecycle state contains no root, revision, execution domain, container name, or supervisor state. Public placement is descriptive compatibility data only: `cwd` is never execution authority, and `hostVisiblePath` is only an optional host-integration capability.

The configured runtime environment must provide the compatible `paseo-workspace-helper` executable, or the daemon configuration must set `helperCommand`. Paseo launches it as an ordinary workload with purpose `workspace-helper`, already rooted at the private workspace placement. The helper receives only relative `--path` values and uses its process cwd (`.`) as confinement authority; it has no `--root` option. Runtime authors do not implement file, watch, Git, provider, script, or agent APIs: the helper handles structured files and watching, while Paseo runs Git, providers, and scripts through `exec`.

## Compatibility

Version 1 targets macOS/Linux hosts and POSIX runtime environments. Unknown v1 fields are rejected; future fields require a new protocol version. A semantic change to framing, fd ownership, lifecycle, or cleanup also increments the protocol version. Paseo fails closed on a version mismatch; it never falls back to host execution.
