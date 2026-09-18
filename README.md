# Paseo with Vorton

Run your coding agents in a container and control them from your browser or phone. This fork adds multiple provider accounts, usage reporting, named presets, bounded local workers and a visual goal bar for Codex. Vorton and standard Paseo share the same installation.

## Install

Install Git and start Docker with Compose. Install Tailscale on the devices you will connect from.

Give your agent this command, or run it yourself:

```sh
git clone https://github.com/AubreyF/paseo.git "$HOME/paseo-source" &&
  bash "$HOME/paseo-source/docker/multiplex/install.sh" "$HOME/paseo-instance"
```

The installer builds locally, creates private storage and starts the container. Complete the Tailscale login, open the printed HTTPS address, and use the password in `$HOME/paseo-instance/.env`. Enable **Vorton** in the sidebar and connect your provider accounts.

No registry account, host Node or separate host Tailscale installation is needed. Existing checkout? See [installation details](docker/multiplex/README.md).

## Work and contribute

Agents can access the container's home and mounted projects. Keep personal files, Docker's socket and other users' homes outside those mounts. See the [security boundaries](docs/container-tailscale.md).

- [Accounts and presets](docs/agent-presets.md)
- [Development inside the container](docs/development.md)
- [Updates and troubleshooting](docs/docker.md)
- [Optional private workspace previews](docker/tailscale/README.md)
- [Team handoff and testing](docs/host-handoff.md)
- [Planned work](docs/roadmap.md)

This is an experimental fork of [Paseo](https://github.com/getpaseo/paseo). Source capabilities and deployed acceptance are tracked separately. Keep credentials, deployment state and test receipts outside Git.
