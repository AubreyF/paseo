# Container installation

Use the [multiplex installer](multiplex/README.md) for both Paseo and Vorton.

`base/Dockerfile` builds the single runtime image, including provider tools and Tailscale. `multiplex/compose.yaml` is the deployment configuration. `tailscale/` contains runtime support and optional host administration tools, not another installation recipe.

See [container operations](../docs/docker.md) for source builds, updates and backups.
