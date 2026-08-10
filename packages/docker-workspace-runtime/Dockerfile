FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git procps \
    && rm -rf /var/lib/apt/lists/*

COPY src/workload.mjs /opt/paseo-workspace-runtime/workload.mjs

WORKDIR /workspace
