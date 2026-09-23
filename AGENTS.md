# Agent guide

Vorton extends Paseo with multi-account agent workflows. This npm monorepo runs agents in your environment and exposes web, mobile and desktop clients. `CLAUDE.md` links here; edit `AGENTS.md`.

## Before editing

1. Check the working tree and preserve unrelated changes.
2. Read the relevant rules below and the owning docs. “The docs” means `docs/`, not the web. Use the [docs index](docs/README.md) for other subjects; do not load the whole catalog.
3. Verify behavior in code and tests before changing it or documenting it as shipped.

| Task                           | Read first                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| App or interface work          | [App instructions](packages/app/AGENTS.md)                                                                                       |
| Protocol or WebSocket changes  | [Compatibility](docs/protocol-compatibility.md), [RPC names](docs/rpc-namespacing.md), [validation](docs/protocol-validation.md) |
| Implementation or tests        | [Coding standards](docs/coding-standards.md), [testing](docs/testing.md)                                                         |
| README or other documentation  | [Writing rules](docs/writing.md)                                                                                                 |
| Installation or deployment     | [Container installer](docker/multiplex/README.md), [instance continuity](docs/instance-continuity.md)                            |
| Commit, publication or release | [Versioning](docs/release.md#vorton-commit-versions), [publication hygiene](docs/publication-hygiene.md)                         |

## Boundaries

- Never restart the main daemon on port `6767` without explicit permission. It owns running agents. A timeout is not a reason to restart it.
- Use the container installer for new installations. Run agents and provider tools inside it; do not install a host daemon, require host Tailscale or mount Docker's socket. Host Docker administration belongs to the operator.
- Keep credentials, deployment details, account inventories, backups and acceptance receipts outside Git.
- Preserve wire compatibility: new fields are optional, existing fields are not removed or narrowed, and wire schemas stay pure. Gate new features on their advertised capability; tag compatibility shims as required by the compatibility doc.

## Check your work

- Run `npm run typecheck` and `npm run lint` after changes. Use npm scripts for linting and formatting; run `npm run format` before committing. For selected files, use `npm run format:files -- <paths>`.
- Run only focused tests: `npx vitest run <file> --bail=1`. Never run the full suite locally or a workspace test suite without an explicit request. Use CI for broad coverage; redirect explicitly requested broad runs to a file.
- Reuse passing test evidence from another agent for unchanged code. Do not add provider-auth checks or auth-dependent skips to tests.
- Before diagnosing cross-package type errors, rebuild declarations with `npm run build:client` or `npm run build:server` as appropriate. Do not patch types to hide stale declarations. See [development](docs/development.md).
- Every commit increments the Vorton version through the installed hook. Stage intended manifest changes first; never bypass hooks or use upstream release commands for routine commits.

## Finish the task

- In this repository, a request to "push" means integrate the requested changes into `main` and push `main` to `origin`, unless the user explicitly names another destination. Do not publish a feature branch instead. Preserve unrelated work and use a normal fast-forward push; never force-push `main`.

- Update the README in the same change when shipped user-facing behavior changes. Follow the [writing rules](docs/writing.md); preserve the author's animation and other demos.
- Report what changed, validation results and remaining limitations. Link the README update or explain why the change does not affect it.
- Follow the user's requested delivery stage. A request for a preview stops before committing or publishing.

## Find the code

Under `packages/`: `server` owns the daemon and agent lifecycle; `app` owns the Expo clients; `protocol` and `client` own shared transport contracts; `cli` owns commands; `relay` owns encrypted remote transport; `desktop` owns Electron; `website` owns marketing.

For setup, commands, development state and build troubleshooting, use [development](docs/development.md). Daemon logs are at `$PASEO_HOME/daemon.log`.
