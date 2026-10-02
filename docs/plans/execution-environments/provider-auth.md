# Provider authentication isolation and migration

Status: deferred project, separate from GitHub credentials.

Inventory each provider CLI's supported authentication, token refresh, configuration homes, session persistence, and licensing constraints. Choose a supported mechanism per provider; do not assume all CLIs can use a transparent credential broker.

Preserve account selection, concurrent sessions, refresh behavior, and resume compatibility. Keep secrets out of guest mounts where the provider supports delegated access. Document when a provider necessarily exposes credentials to its execution environment instead of claiming universal isolation.

Acceptance is provider-specific: sign-in, expiry, refresh, account switching, reconnect, revocation, and migration rollback. Existing sessions must not be invalidated by a bulk configuration move. Start with one provider; the native host release continues to use ordinary provider authentication.
