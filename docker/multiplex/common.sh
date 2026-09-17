#!/usr/bin/env bash
# Sourced by the installer and deployed lifecycle commands.
set -euo pipefail

paseo_compose() {
  docker compose --project-directory "$deployment" --env-file "$deployment/.env" -f "$deployment/compose.yaml" "$@"
}

paseo_image() {
  local requested="$1"
  if [[ ! "$requested" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$ ]]; then
    echo 'Supply a Docker image tag, digest, or local image ID.' >&2
    return 1
  fi
  if ! docker image inspect "$requested" >/dev/null 2>&1; then
    docker pull "$requested" >&2
  fi
  local contract
  contract="$(docker image inspect --format '{{index .Config.Labels "sh.paseo.container-contract"}}' "$requested")"
  if [[ "$contract" != tailscale-v1 ]]; then
    echo 'This image predates integrated Tailscale. Use a newly built multiplex image; see docs/docker.md.' >&2
    return 1
  fi
  docker image inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}' "$requested"
}

paseo_wait() {
  local container health attempt
  container="$(paseo_compose ps -q paseo)"
  if [[ -z "$container" ]]; then
    echo 'The Paseo container is not running. Inspect docker compose logs in this deployment.' >&2
    return 1
  fi
  for attempt in $(seq 1 60); do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    if [[ "$health" == healthy ]]; then
      paseo_compose exec -T --user root paseo python3 -I /opt/personal-tailscale/network.py --url
      return 0
    fi
    if [[ "$health" == exited || "$health" == dead ]]; then break; fi
    sleep 2
  done
  echo 'Paseo is not ready. Inspect docker compose logs; HTTPS may need tailnet approval. No automatic restart was attempted.' >&2
  return 1
}
