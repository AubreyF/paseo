---
title: Docker
description: Build and install this fork in a container.
nav: Docker
order: 6
category: Getting started
---

# Docker

This fork builds Paseo, its web UI, provider tools and Tailscale into one container. From a checkout, run:

```sh
./docker/multiplex/install.sh "$HOME/paseo-instance"
```

Complete enrollment, open the printed HTTPS address and use the password in the private deployment's `.env`. Enable Vorton from the sidebar. The host needs Docker with Compose; connecting devices need Tailscale.

The repository's `docker/multiplex/README.md` owns installation instructions. `docs/docker.md` covers updates, backups and troubleshooting. No prebuilt image or registry account is required.
