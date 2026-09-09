# Paseo multiplex container

This image packages Aubrey's Paseo fork as one self-hosted service. Source builds include the daemon, browser client, Codex CLI, Pi CLI, named launch presets, and provider-instance usage display. Account credentials and provider definitions are created after installation and remain in the deployment's persistent volume. Unpublished local changes are not available in the registry tags below.

Images are published for Linux on AMD64 and ARM64:

- `ghcr.io/aubreyf/paseo-multiplex:edge` follows the latest successful build from `main`.
- `ghcr.io/aubreyf/paseo-multiplex:sha-<commit>` identifies an immutable source revision.

## Install

Install Docker Engine with the Compose plugin on the host, then copy this directory to it.

```bash
cp .env.example .env
chmod 600 .env
mkdir -p data/home workspace
```

Replace `PASEO_PASSWORD` in `.env` with a random password. Point `PASEO_WORKSPACE_ROOT` at the directory tree that agents may access. Agents also have access to this instance's persistent home and container filesystem. Do not mount a shared personal home, another person's project tree, or the Docker socket.

Start the service:

```bash
./update.sh
```

The Compose file binds Paseo to host loopback. Keep that default and place Tailscale Serve, Caddy, or another authenticated HTTPS proxy in front of `http://127.0.0.1:6767`.

For Tailscale Serve:

```bash
tailscale serve https / http://127.0.0.1:6767
```

Set `PASEO_HOSTNAMES` in `.env` to the exact Tailscale DNS name if Paseo rejects the forwarded host header.

## Configure provider instances

The image contains no accounts. Create any number of provider instances in `data/home/.paseo/config.json`. Each instance extends `codex` and selects its own credential directory inside `/home/paseo`:

```json
{
  "agents": {
    "providers": {
      "<provider-id>": {
        "extends": "codex",
        "label": "<display-name>",
        "env": {
          "CODEX_HOME": "/home/paseo/<credential-directory>"
        }
      }
    }
  }
}
```

Authenticate each provider instance without placing credentials in the image:

```bash
docker compose exec --user paseo \
  -e CODEX_HOME=/home/paseo/<credential-directory> \
  paseo codex login --device-auth
```

Restart the container after changing provider definitions:

```bash
docker compose restart paseo
```

## Update and roll back

Update to the newest successful `main` build:

```bash
./update.sh
```

Deploy a known revision or roll back by passing its immutable tag:

```bash
./update.sh sha-<commit>
```

The persistent home and workspace mounts survive image changes. Back up `data/home` before moving the deployment or making destructive configuration changes.

## Build and transfer a local review image

From the repository root:

```bash
docker build -f docker/base/Dockerfile \
  --build-arg PASEO_EXTRA_NPM_PACKAGE=@openai/codex@0.153.4 \
  --build-arg PASEO_PI_PACKAGE=@earendil-works/pi-coding-agent@0.84.4 \
  -t paseo-presets:review .
docker save -o paseo-presets-review.tar paseo-presets:review
```

Transfer the archive and this deployment directory to a host of the same CPU architecture. Run `docker load -i paseo-presets-review.tar`, set `PASEO_IMAGE=paseo-presets:review` in `.env`, then run `docker compose up -d --pull never`. The update script is for registry images, not unpublished local tags. Keep the previous image tag and back up the home before updating.

## One instance per person

Copy this deployment directory once per person. Give each copy a distinct `PASEO_INSTANCE`, `PASEO_PORT`, absolute `PASEO_DATA_ROOT`, absolute `PASEO_WORKSPACE_ROOT`, and password. Start Compose separately in each directory. These names and mounts, not separate macOS login accounts, distinguish the instances. Memory, CPU and process limits are configurable per instance.

Each person authenticates their own providers inside their own container. Keys must remain in that home or its runtime environment, never in an image layer or shared configuration archive. Create a separate authenticated HTTPS tunnel endpoint for each port, with access restricted to its intended person. Do not give friends access to Docker or the host administrator account.

These containers separate filesystem mounts and processes. They are not hostile-tenant VMs: Docker's administrator can inspect every instance, and Docker Desktop shares a Linux VM. Agents inside one person's instance can access that person's keys. Network egress is not restricted by this recipe, so reachable host services still need authentication. Never expose an unauthenticated daemon or inference endpoint to a LAN or the internet.

## Native MTPLX and Pi workers

MTPLX runs natively on the Mac Studio. The Linux container connects to its OpenAI-compatible endpoint; it does not try to use Metal inside Docker. This is a shared inference service, not shared agent sessions or shared credential storage.

For a new installation, copy `config.example.json` to `data/home/.paseo/config.json` and `pi-models.example.json` to `data/home/.pi/agent/models.json`, creating their parent directories first. For an existing installation, merge the example fields instead of overwriting the files. Adjust paths if `PASEO_DATA_ROOT` is not `./data`.

Replace the example model ID, context window, and output limit with values supported by your loaded model. Set `MTPLX_API_KEY` in this instance's `.env` to the inference service credential. The Pi template uses environment interpolation and contains no credential. Restart the container after configuration changes. Verify that `host.docker.internal:8000` is reachable from the container. Host loopback forwarding varies with the Docker runtime; do not solve a connection failure by exposing an unauthenticated endpoint on all interfaces.

In Settings, Host, Agents:

1. Create a local preset using Pi and the configured local model. Give it a short name and bounded implementation instructions.
2. Create a supervisor preset using a connected frontier account and model. Select the local preset as its worker and start with one concurrent worker for a serial inference server.
3. Enable Vorton Mode in General settings or select Vorton in the sidebar. The composer shows a preset selector and the provider's separate permissions selector. Choose Manage presets inside the preset menu to edit configurations.

Suggested supervisor instructions: "Delegate bounded implementation tasks with explicit file ownership. Review the resulting diff and independently run tests. Do not accept a worker's success claim as verification. Do not publish or change credentials without the user's instruction."

Pi has no native permission-mode selector. Its tools run with this person's container access. The supervisor's permissions selector is not a Pi sandbox. The worker limit covers managed Paseo children, not arbitrary subprocesses or other people's MTPLX requests. Instructions guide the model; container configuration defines the execution boundary.

## Quota and handoff behavior

Local review on September 8, 2026 verified two overlapping requests to the existing native MTPLX Qwen endpoint: cancelling one HTTP stream did not prevent the other from returning its expected response. This proves request-scoped cancellation in that tested runtime. It does not benchmark simultaneous token generation, guarantee fairness, or reserve capacity per person. Keep worker limits conservative and repeat the check on the intended host and model version.

Provider rows show reported remaining quota and reset times where available. Unknown usage is not zero usage, and local inference does not have a fabricated subscription percentage. Use the Usage page for all windows and balances. Multiple aliases may refer to one account; their percentages are not independent allowances.

A structured Codex quota-exhaustion error persistently pauses the task and its managed children. It does not switch accounts or automatically continue after a reset. Select another preset and confirm a new task to continue from a bounded copy of recorded text. The original remains intact. Attachments, tool outputs, and hidden model state are not transferred; review the original task and working tree before handing off. Keep Classic mode available for ordinary model and reasoning selection.

## Account reset credits

Supported provider accounts show a reset-count button next to usage in model and preset menus and on the host Usage page. Open it to inspect the account, available count, reported grant and expiry dates, and freshness. Reset credits are separate from purchased usage credit balances. Missing information is not zero.

Review the account, then confirm the reset. The daemon verifies the account again and persists a per-account operation key before requesting redemption. An uncertain result remains pending across restarts. Refresh and explicitly retry that operation to reconcile it; do not delete its record to force another attempt. Aliases for the same verified account share the pending operation. A reset never restarts tasks or workers.

The installed CLI must advertise an idempotent reset method before redemption is enabled. An older CLI may show usage without allowing reset management. Paseo does not buy credits or promise periodic grants. Backups include private account-operation records and must receive the same protection as credentials.

## Operate one person's instance

Run commands from that person's deployment directory, with its distinct `.env`. Check `docker compose config` locally before starting, but do not share its output because it includes the password. Confirm that home and workspace paths do not overlap another person's mounts.

- Stop or start only this instance with `docker compose stop paseo` and `docker compose start paseo`.
- Revoke access by stopping this instance, removing its user's tunnel access, changing its `.env` password, and recreating it with `docker compose up -d --force-recreate paseo`. Existing authenticated sockets close when the container stops. Preserve other instances' passwords and tunnel rules.
- Back up while this instance is stopped. Copy both its home and workspace roots to private storage, then restart it. Include `.env` separately in the protected backup. Do not copy a populated home to provision a different person.
- Restore by stopping this instance, retaining the current roots as a rollback copy, and restoring its own backup into the configured paths. Use the image version recorded with that backup, preserve ownership, and recreate this instance. Never restore one person's home into another's instance.
- Before updating, record `docker compose images`, back up the data, and pin the selected image tag. An image rollback alone does not undo incompatible data changes. Test the restored instance before removing the rollback copy.

Container stdout/stderr logs rotate at 10 MB with three files. This does not bound project files, daemon history or model caches. Monitor host free disk space and `docker system df`; retain backups outside the active data volume. Do not use broad Docker prune commands on a shared host without reviewing their targets.

On macOS, verify Docker Desktop and the native inference service actually start after a reboot. FileVault unlock, user login and Docker startup may require an operator. This recipe does not disable encryption, enable automatic login, prevent sleep or install a host startup service. Test cold boot on the intended Studio before treating it as unattended infrastructure.
