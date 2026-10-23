# Runs stdio MCP servers as network services: mcp-proxy (stdio to Streamable
# HTTP) with uv/uvx for Python servers. The upstream
# ghcr.io/sparfenyuk/mcp-proxy image carries no uv, and a server's package is
# fetched when the container starts, so the runtime has to be in the image.
# mcp-proxy (MIT) and uv (MIT/Apache-2.0) are OSI-licensed.
#
# For servers published on npm, add Node (npx) to the image:
#   RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
#    && rm -rf /var/lib/apt/lists/*
# before the `USER` line, and start them with `npx -y <package>`.
#
# Built by compose, from the override (see the README, "Server-side MCP
# servers"): `docker compose up -d --build mcp-search`.
FROM python:3.13-slim@sha256:57b29a7c050c4e679e4bea572e14b3965cf4b5839de2da49d55e49ffc4024f39
RUN pip install --no-cache-dir mcp-proxy==0.13.0 uv==0.13.5 \
 && useradd --create-home --uid 10001 mcp \
 && mkdir /cache && chown 10001 /cache
USER 10001
WORKDIR /home/mcp
LABEL org.opencontainers.image.title="cerea-mcp-proxy" \
      org.opencontainers.image.description="mcp-proxy with uvx, for server-side MCP servers in a Cerea deploy kit stack"
ENTRYPOINT ["mcp-proxy"]
