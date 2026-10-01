#!/usr/bin/env bash
set -euo pipefail
deployment="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$deployment/common.sh"
umask 077
pending="$deployment/shared-folders.pending.json"
active="$deployment/shared-folders.compose.json"
if [[ $# == 1 && "$1" == --apply ]]; then
  [[ -f "$pending" ]] || { echo 'No pending shared-folder change.' >&2; exit 1; }
  docker compose --project-directory "$deployment" --env-file "$deployment/.env" -f "$deployment/compose.yaml" -f "$pending" config --quiet
  if [[ -f "$active" ]]; then cp -p "$active" "$active.previous"; fi
  cp "$pending" "$active"
  echo 'Applying shared folders. This recreates the container and interrupts active tasks.'
  paseo_compose up -d --no-deps --pull never paseo
  rm "$pending"
  paseo_wait
  exit
fi
if [[ $# != 1 || ! -d "$1" ]]; then
  echo 'Usage: ./share-folder.sh EXISTING_HOST_DIRECTORY (stage), then ./share-folder.sh --apply (interrupts active tasks).' >&2
  exit 1
fi
shared_source="$(cd -P -- "$1" && pwd)"
image="$(paseo_compose config --images | head -n 1)"
[[ -n "$image" ]] || { echo 'Cannot resolve the installation image.' >&2; exit 1; }
container="$(paseo_compose ps -q paseo)"
mounts='[]'
if [[ -n "$container" ]]; then mounts="$(docker inspect --format '{{json .Mounts}}' "$container")"; fi
previous="$active"
if [[ -f "$pending" ]]; then previous="$pending"; fi
next="$(mktemp "$deployment/.shared-folders.XXXXXX")"
trap 'rm -f "$next"' EXIT
if [[ -f "$previous" ]]; then cat "$previous"; else printf '{}'; fi |
  docker run --rm -i --network none --entrypoint node "$image" --input-type=module -e "$(cat "$deployment/shared-folders.mjs")" "$HOME" "$shared_source" "$mounts" > "$next"
docker compose --project-directory "$deployment" --env-file "$deployment/.env" -f "$deployment/compose.yaml" -f "$next" config --quiet
mv "$next" "$pending"
printf 'Staged folder: %s\nReview shared-folders.pending.json. When active tasks can be interrupted, run ./share-folder.sh --apply.\n' "$shared_source"
