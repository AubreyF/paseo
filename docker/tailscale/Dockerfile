# Supply an immutable image reference that already contains the required providers.
ARG PASEO_BASE
FROM ${PASEO_BASE}
USER root
ARG TAILSCALE_VERSION=1.102.4
ARG TAILSCALE_SHA256=9dd1e6a592a014bbaea0103167ffe299adeda4ba14e078ce9c2895364f6c4c3f
RUN test "$(dpkg --print-architecture)" = arm64 \
 && apt-get update \
 && apt-get install -y --no-install-recommends supervisor=4.2.5-1 gh=2.23.0+dfsg1-1 iproute2 iptables \
 && curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_arm64.tgz" -o /tmp/tailscale.tgz \
 && echo "${TAILSCALE_SHA256}  /tmp/tailscale.tgz" | sha256sum -c - \
 && tar -xzf /tmp/tailscale.tgz -C /tmp \
 && install -m 0755 "/tmp/tailscale_${TAILSCALE_VERSION}_arm64/tailscale" /usr/local/bin/tailscale \
 && install -m 0755 "/tmp/tailscale_${TAILSCALE_VERSION}_arm64/tailscaled" /usr/local/sbin/tailscaled \
 && rm -rf /tmp/tailscale* /var/lib/apt/lists/*
COPY --chown=root:root entrypoint start-paseo healthcheck /opt/personal-tailscale/
COPY --chown=root:root supervisord.conf /etc/personal-tailscale/supervisord.conf
RUN chmod 0755 /opt/personal-tailscale /opt/personal-tailscale/* \
 && chmod 0755 /etc/personal-tailscale \
 && chmod 0644 /etc/personal-tailscale/supervisord.conf
COPY --chown=root:root paseo-preview.mjs /usr/local/bin/paseo-preview
COPY --chown=root:root preview-broker-client.mjs /usr/local/bin/preview-broker-client.mjs
RUN chmod 0755 /usr/local/bin/paseo-preview
ENV PASEO_WEB_UI_DIST_DIR=/home/paseo/.paseo/web-ui
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/bash", "/opt/personal-tailscale/entrypoint"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD ["/usr/bin/python3", "/opt/personal-tailscale/healthcheck"]
