#!/usr/bin/env bash
set -eu
# Read the credential inside Caddy's container, outside Compose interpolation
# and process arguments. The application and Tailscale do not receive it.
CF_API_TOKEN="$(cat /run/secrets/cloudflare_dns_token)"
test -n "$CF_API_TOKEN"
export CF_API_TOKEN
exec caddy "$@"
