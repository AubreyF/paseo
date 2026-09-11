# Private workspace previews

Use `paseo-preview list --workspace WORKSPACE_ID` to inspect existing managed services. Start or adopt a preview with `paseo-preview start SCRIPT --workspace WORKSPACE_ID`. The helper returns a verified URL, pins Paseo's allocated port in the project's `paseo.json`, and records restoration intent in persistent home.

Use `paseo-preview stop SCRIPT --workspace WORKSPACE_ID` to stop and immediately disable restoration. `restart` preserves the configured port. `status` shows saved intent and restoration errors. Never restart Paseo to restart a preview.

Define service commands with the framework's actual binding and port options using `PASEO_PORT`. Bind a reachable interface and allow the exact hostname from `/etc/personal-tailscale/hostname`. Keep framework hostname checks enabled. Return only a successfully checked environment URL, not loopback or a guessed hostname.

A separate worktree needs its own unused port. Remove an inherited fixed port before its first launch and let Paseo allocate another. Never kill an existing listener to claim its port. Respect the administrator's configured access-policy range and reserved HTTPS frontend ports.

The host recovery service restores only registered previews with unchanged commands and ports after a new daemon session. It does not continuously restart crashed commands. Ordinary UI/CLI stops are observed once per minute, so use the helper's stop before immediate shutdown. Moved or archived workspaces require review.

HTTP over Tailscale is still an insecure browser origin. Request an administrator-managed HTTPS mapping for microphone, secure-context APIs or HTTPS callbacks. Configure WSS consistently. Host checks do not substitute for physical-device confirmation.

Do not read protected Tailscale state, access its socket, change network policy, request operator privileges or enable Funnel. Keep actual URLs, account state and installation records outside Git. Host maintenance requires an administrator to pause recovery first.
