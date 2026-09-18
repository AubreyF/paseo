# Paseo with Vorton

Run your coding agents in a container and control them from your browser or phone. This fork adds multiple provider accounts, usage reporting, named presets, bounded local workers and a visual goal bar for Codex. Vorton and standard Paseo share the same installation.

## Install

Install Git and start Docker with Compose. Install Tailscale on the devices you will connect from.

Give your agent this command, or run it yourself:

```sh
git clone https://github.com/AubreyF/paseo.git "$HOME/paseo-source" &&
  bash "$HOME/paseo-source/docker/multiplex/install.sh" "$HOME/paseo-instance"
```

### Instructions for installation agents

Your task is to get the user to a working web interface.

1. Clone the repository and run the container installer above. Complete any required Tailscale login.
2. Confirm the container is running, then open the installation’s HTTPS address and verify that the web interface loads. A running container alone does not establish success. If access fails, diagnose and fix it before handing over.
3. As soon as access works, give the user the clickable HTTPS address and tell them where to find their login password. Keep the handoff short.

Provider authentication happens afterward in the web interface. Do not ask the user to authenticate Codex, Claude, or other providers through the container CLI during installation. Do not delay the browser handoff for provider setup, presets, or optional configuration.

Keep progress messages brief. If verification requires access only the user has, request that specific check and state what remains unverified.

The installer builds locally, creates private storage and starts the container. Complete the Tailscale login, open the printed HTTPS address, and use the password in `$HOME/paseo-instance/.env`. Enable **Vorton** in the sidebar and connect your provider accounts.

No registry account, host Node or separate host Tailscale installation is needed. Existing checkout? See [installation details](docker/multiplex/README.md).

## Optional: your own domain with private access

You can use an address such as `https://paseo.example.com` while keeping access restricted to your Tailscale network. Deliver the working installation address first. Set up a custom domain afterward when the user requests it.

**Instructions for agents:**

1. Confirm the user’s chosen hostname, DNS provider, and authorized Tailscale users. Perform host administration through an authorized operator session.
2. Create a dedicated private Tailscale endpoint with a Caddy reverse proxy. Preserve the existing installation and its working address. Publish no host ports and keep Tailscale Funnel disabled.
3. Configure trusted HTTPS with DNS-01 validation and automatic renewal. Keep the DNS credential scoped to the required zone, available only to the certificate manager, and outside Git and logs. Persist certificate and Tailscale identity storage.
4. Forward requests to the application’s stable service address. Configure the exact custom hostname and HTTPS origin in the application. Preserve authentication, origin checks, and upstream certificate verification.
5. Verify the private listener and certificate before pointing DNS to its Tailscale address. For Cloudflare, use **DNS only**, with proxying disabled.
6. Test the final address from an authorized device: page loading, login, and WebSocket connectivity. Confirm access is denied outside the authorized network. Fix failures before declaring success, then give the user the clickable address.

Keep updates brief. If a check requires the user’s device or administrator access, request that specific action and state what remains unverified.

## Work and contribute

Agents can access the container's home and mounted projects. Keep personal files, Docker's socket and other users' homes outside those mounts. See the [security boundaries](docs/container-tailscale.md).

- [Accounts and presets](docs/agent-presets.md)
- [Development inside the container](docs/development.md)
- [Updates and troubleshooting](docs/docker.md)
- [Optional private workspace previews](docker/tailscale/README.md)
- [Team handoff and testing](docs/host-handoff.md)
- [Planned work](docs/roadmap.md)

This is an experimental fork of [Paseo](https://github.com/getpaseo/paseo). Source capabilities and deployed acceptance are tracked separately. Keep credentials, deployment state and test receipts outside Git.
