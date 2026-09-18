# Private workspace previews

The installed HTTPS broker is the approved exception for routine preview lifecycle requests. Agents may use the commands below for authorized local development work without per-service host approval. The host policy decides eligible workspaces and ports. This does not authorize unrelated work or external publishing.

```sh
paseo-preview list --workspace WORKSPACE_ID
paseo-preview start preview --workspace WORKSPACE_ID
paseo-preview start preview --workspace WORKSPACE_ID --https-port PORT
paseo-preview status preview --workspace WORKSPACE_ID
paseo-preview status
paseo-preview restart preview --workspace WORKSPACE_ID
paseo-preview stop preview --workspace WORKSPACE_ID
```

Start requests private HTTPS by default. Only a `ready` result contains a verified usable URL. `pending` means startup or verification is incomplete. `failed` includes a diagnostic. A timeout is not permission to kill listeners or restart Paseo. Repeat start adopts the same reservation. Use a new status request to inspect an uncertain result. Stop removes the owned mapping before stopping the managed service and prevents queued older starts from reviving it. Restart retains the HTTPS port. Never use another service's reserved frontend as a backend port.

The helper sends bounded JSON through the installed filesystem inbox. Do not write ad hoc requests or change broker installation markers. Host policy, executable code and mapping ownership are outside agent-writable mounts. Agents must not execute host administration scripts, use Docker, access the protected Tailscale socket or state, request operator privileges, change grants, enable Funnel, or alter unrelated mappings.

Define a `service` script in `paseo.json` using the framework's real port options and `PASEO_PORT`. Before a stopped service's first launch, the helper wraps its existing command with `paseo-preview env`. That wrapper supplies `PASEO_PREVIEW_ORIGIN` from the host's reserved origin file when the daemon launches the command. Caller environment variables do not propagate through the daemon. Apps must consume that exact origin for host checks, callback URLs, write-origin checks and WSS/HMR configuration where required. Already-running services are adopted without changing their startup environment; use an authorized preview restart when an origin change must take effect.

Bind loopback for Tailscale Serve. Preserve any explicitly approved private listener scope; do not switch an app to a wildcard binding merely to pass readiness. Trust forwarded headers only on the trusted loopback path. Direct clients must not gain trust by supplying forwarded headers. Keep host checks and snapshot/hash verification enabled.

HTTPS does not add application authentication, change tailnet access, or grant clipboard/microphone permission. Test the rendered application, not only HTTP health. Keep URLs, credentials, clipboard content and installation receipts out of public source or logs.

The broker runs while the Mac is awake and the user session is available. It revalidates owned mappings but does not revive stopped, crashed, moved or reconfigured services. After a daemon restart, use explicit start for a broker-managed preview. Legacy preview restoration remains separate for services not adopted by the broker. Host startup cannot bypass FileVault or login. Agents cannot administer host recovery.
