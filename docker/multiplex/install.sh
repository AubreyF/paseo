#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$source_dir/common.sh"
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'Usage: install.sh NEW_DEPLOYMENT_DIRECTORY [IMAGE]' >&2
  exit 1
fi
if [[ -e "$1" || -L "$1" ]]; then
  echo 'Choose a new directory. Existing installations are never overwritten.' >&2
  exit 1
fi
parent="$(cd "$(dirname "$1")" && pwd)"
deployment="$parent/$(basename "$1")"
repo_root="$(cd "$source_dir/../.." && pwd)"
case "$deployment/" in "$repo_root/"*) echo 'Keep deployment state outside the source checkout.' >&2; exit 1 ;; esac
command -v docker >/dev/null
docker compose version >/dev/null
docker info >/dev/null
if [[ $# == 2 ]]; then
  image="$(paseo_image "$2")"
else
  build_receipt="$(mktemp)"
  trap 'rm -f "$build_receipt"' EXIT
  docker build --iidfile "$build_receipt" -f "$repo_root/docker/base/Dockerfile" "$repo_root"
  image="$(paseo_image "$(cat "$build_receipt")")"
fi
# Generate inside the image so installation needs no host Node or Python.
seed="$(docker run --rm --network none --entrypoint node "$image" -e 'process.stdout.write(require("node:crypto").randomBytes(38).toString("hex"))')"
[[ "$seed" =~ ^[a-f0-9]{76}$ ]]
password="${seed:0:64}"
instance="paseo-${seed:64:12}"
umask 077
mkdir "$deployment"
mkdir -p "$deployment/data/home" "$deployment/workspace"
cp "$source_dir/compose.yaml" "$source_dir/common.sh" "$source_dir/connect.sh" "$source_dir/update.sh" "$deployment/"
chmod 700 "$deployment/"*.sh
cat > "$deployment/.env" <<ENV
PASEO_IMAGE=$image
PASEO_INSTANCE=$instance
PASEO_PASSWORD=$password
PASEO_DATA_ROOT=./data
PASEO_WORKSPACE_ROOT=./workspace
ENV
printf '%s\n' 1 > "$deployment/.container-installation"
paseo_compose config --quiet
paseo_compose up -d --pull never paseo
printf 'Installation created at %s\nKeep the password in .env private. Complete the Tailscale login below.\n' "$deployment"
"$deployment/connect.sh"
