#!/usr/bin/env bash
set -euo pipefail
deployment="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$deployment/common.sh"
if [[ ! -f "$deployment/.container-installation" ]]; then
  echo 'Run install.sh to create a private deployment first.' >&2
  exit 1
fi
ready=false
for attempt in $(seq 1 30); do
  if paseo_compose exec -T --user root paseo test -S /run/tailscale/tailscaled.sock; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'Tailscale did not start. Inspect docker compose logs before retrying connect.sh.' >&2
  exit 1
fi
paseo_compose exec -T --user root paseo sh -c 'exec tailscale --socket=/run/tailscale/tailscaled.sock up --hostname="$PASEO_INSTANCE" --accept-dns=false --timeout=5m'
paseo_wait
