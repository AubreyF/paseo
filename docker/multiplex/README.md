# Paseo multiplex container

This image packages Aubrey's Paseo fork as one self-hosted service. It includes the daemon, browser client, Codex CLI, and provider-instance usage display. Account credentials and provider definitions are created after installation and remain in the deployment's persistent volume.

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

Replace `PASEO_PASSWORD` in `.env` with a random password. Point `PASEO_WORKSPACE_ROOT` at the directory tree that agents may access. The container cannot read files outside that mount.

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
