FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.144.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git procps zsh \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /root/.codex

ENV CODEX_HOME=/root/.codex

COPY packages/docker-workspace-runtime/src/workload.mjs /opt/paseo-workspace-runtime/workload.mjs
COPY packages/server/src/server/workspace-helper/executable.mjs /opt/paseo-workspace-helper/executable.mjs
COPY packages/server/src/server/workspace-helper/executable.mjs /usr/bin/paseo-workspace-helper
COPY packages/server/src/server/test-utils/fixtures/workspace-runtime-acp-agent.mjs /usr/local/bin/paseo-fixture-agent.mjs
RUN chmod 755 /usr/bin/paseo-workspace-helper /usr/local/bin/paseo-fixture-agent.mjs

WORKDIR /workspace
