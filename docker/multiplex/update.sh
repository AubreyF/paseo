#!/usr/bin/env bash
set -euo pipefail
deployment="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$deployment/common.sh"
if [[ $# != 1 || ! -f "$deployment/.container-installation" ]]; then
  echo 'Usage: update.sh IMAGE (from an installed deployment). For legacy instances, see docs/docker.md.' >&2
  exit 1
fi
image="$(paseo_image "$1")"
# Preserve the previous image and all credentials for an explicit rollback.
cp -p "$deployment/.env" "$deployment/.env.previous"
umask 077
awk -v image="$image" '/^PASEO_IMAGE=/ { print "PASEO_IMAGE=" image; next } { print }' "$deployment/.env" > "$deployment/.env.next"
mv "$deployment/.env.next" "$deployment/.env"
echo 'Replacing this instance. Active tasks will be interrupted; persistent state is retained.'
paseo_compose up -d --no-deps --pull never paseo
paseo_wait
