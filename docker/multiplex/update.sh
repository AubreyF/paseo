#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

image_repository="ghcr.io/aubreyf/paseo-multiplex"
image_tag="${1:-edge}"
image="${image_repository}:${image_tag}"

echo "Pulling ${image}"
docker pull "$image"

echo "Starting Paseo from ${image}"
PASEO_IMAGE="$image" docker compose up -d --remove-orphans paseo
container_id="$(PASEO_IMAGE="$image" docker compose ps -q paseo)"
if [ -z "$container_id" ]; then
  echo "Paseo container was not created" >&2
  exit 1
fi

for _ in $(seq 1 30); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
  if [ "$health" = "healthy" ]; then
    echo "Paseo is healthy at ${image}"
    exit 0
  fi
  if [ "$health" = "unhealthy" ] || [ "$health" = "exited" ] || [ "$health" = "dead" ]; then
    docker compose logs --tail=100 paseo
    exit 1
  fi
  sleep 2
done

docker compose logs --tail=100 paseo
echo "Paseo did not become healthy within 60 seconds" >&2
exit 1
