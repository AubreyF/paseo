#!/usr/bin/env bash
set -euo pipefail
image="${1:?Supply the candidate image}"
docker run --rm --network none -e PASEO_PASSWORD=ci-disposable-password --entrypoint /bin/bash "$image" -euc '
  tailscale version
  codex --version
  pi --version
  gh --version
  test -s /etc/paseo-server-entry
  test -x /usr/local/bin/paseo-preview
  /usr/bin/setpriv --reuid=paseo --regid=paseo --init-groups \
    --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
    /bin/bash -euc '\''
      test "$(id -u)" = 1000
      node /opt/personal-tailscale/initialize-web.mjs
      node -e "const fs=require(\"fs\"); const assert=require(\"assert\"); const s=fs.readFileSync(\"/proc/self/status\",\"utf8\"); assert.match(s,/CapEff:\\s+0+/); assert.match(s,/CapBnd:\\s+0+/); assert.match(s,/NoNewPrivs:\\s+1/); const release=JSON.parse(fs.readFileSync(process.env.PASEO_WEB_UI_DIST_DIR+\"/release.json\")); assert.equal(release.source,\"bundled\"); assert(release.scripts.length);"
      /usr/local/bin/paseo-docker-entrypoint > /tmp/daemon-smoke.log 2>&1 &
      daemon_pid=$!
      trap "kill $daemon_pid 2>/dev/null || true" EXIT
      ready=false
      for attempt in $(seq 1 60); do
        if curl --fail --silent http://127.0.0.1:6767/ > /tmp/served-index.html; then
          ready=true
          break
        fi
        sleep 1
      done
      if [[ "$ready" != true ]]; then
        cat /tmp/daemon-smoke.log
        exit 1
      fi
      node -e "const fs=require(\"fs\"); const assert=require(\"assert\"); const html=fs.readFileSync(\"/tmp/served-index.html\",\"utf8\"); for (const script of JSON.parse(fs.readFileSync(process.env.PASEO_WEB_UI_DIST_DIR+\"/release.json\")).scripts) assert(html.includes(script));"
    '\''
'
