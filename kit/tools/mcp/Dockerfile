# Runs stdio MCP servers as network services: mcp-proxy (stdio to Streamable
# HTTP) with uv/uvx for Python servers. The upstream
# ghcr.io/sparfenyuk/mcp-proxy image carries no uv, and a server's package is
# fetched when the container starts, so the runtime has to be in the image.
# mcp-proxy (MIT) and uv (MIT/Apache-2.0) are OSI-licensed.
#
# Node.js and npm (MIT) are in the image too, for servers published on npm:
# start them with `npx -y <package>@<version>`. They are copied from the
# official node image rather than installed with apt, because Debian's nodejs
# is older than the Node 22 that some servers (osm-mcp) require. npm's cache
# must be set to /cache/npm in the service (NPM_CONFIG_CACHE): the root is
# read-only.
#
# Built by compose, from the override (see the README, "Server-side MCP
# servers"): `docker compose up -d --build mcp-search`.
# Node 22.23.4 is the first 22.x with the CVE-2026-111497 (Brotli) fix.
FROM node:22.23.4-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS node
FROM python:3.13-slim@sha256:57b29a7c050c4e679e4bea572e14b3965cf4b5839de2da49d55e49ffc4024f39
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN pip install --no-cache-dir mcp-proxy==0.13.0 uv==0.13.5 \
 && useradd --create-home --uid 10001 mcp \
 && mkdir /cache && chown 10001 /cache
USER 10001
WORKDIR /home/mcp
LABEL org.opencontainers.image.title="cerea-mcp-proxy" \
      org.opencontainers.image.description="mcp-proxy with uvx and npx, for server-side MCP servers in a Cerea deploy kit stack"
ENTRYPOINT ["mcp-proxy"]
