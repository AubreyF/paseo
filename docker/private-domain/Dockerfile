FROM caddy@sha256:403d237d0bb16d2e62b1f93ca9ebb4953ecbb78aee5986765713a39f9263a5b4 AS builder
RUN xcaddy build v2.11.4 --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy@sha256:13ba145cba2f3e28fa801994876e4c086d1b95d5aa2a520a734765ffb6b12017
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# The loopback listener needs no bind-port capability. Remove the stock file
# capability so the binary can run with every container capability dropped.
RUN apk add --no-cache bash && setcap -r /usr/bin/caddy
COPY start-caddy.sh /usr/local/bin/start-caddy
ENTRYPOINT ["/usr/local/bin/start-caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
