FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git procps \
    && rm -rf /var/lib/apt/lists/*

COPY packages/docker-workspace-runtime/src/workload.mjs /opt/paseo-workspace-runtime/workload.mjs
COPY packages/server/src/server/workspace-helper/executable.mjs /opt/paseo-workspace-helper/executable.mjs
COPY packages/server/src/server/workspace-helper/executable.mjs /usr/bin/paseo-workspace-helper
RUN chmod 755 /usr/bin/paseo-workspace-helper

WORKDIR /workspace
