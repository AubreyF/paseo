# Paseo with Vorton

Run your coding agents in a container and control them from your browser or phone. This fork adds multiple provider accounts, usage reporting, named presets and bounded local workers. Vorton and standard Paseo share the same installation.

## Install

Install Docker with Compose on the host and Tailscale on your connecting devices. From this checkout:

```sh
./docker/multiplex/install.sh "$HOME/paseo-instance"
```

Complete the Tailscale login, open the printed HTTPS address, and use the password saved in the deployment's `.env`. Enable **Vorton** in the sidebar to configure accounts and presets. Host-native Tailscale is optional for unrelated host services such as VNC.

The installer builds this checkout locally. No registry account, host Node installation or separately installed host Tailscale is required. See [installation details](docker/multiplex/README.md).

## Work and contribute

Agents can access the container's home and mounted projects. Keep personal files, Docker's socket and other users' homes outside those mounts. See the [security boundaries](docs/container-tailscale.md).

- [Accounts and presets](docs/agent-presets.md)
- [Development inside the container](docs/development.md)
- [Updates and troubleshooting](docs/docker.md)
- [Optional private workspace previews](docker/tailscale/README.md)
- [Team handoff and testing](docs/host-handoff.md)
- [Planned work](docs/roadmap.md)

This is an experimental fork of [Paseo](https://github.com/getpaseo/paseo). Source capabilities and deployed acceptance are tracked separately. Keep credentials, deployment state and test receipts outside Git.
