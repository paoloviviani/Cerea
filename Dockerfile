# syntax=docker/dockerfile:1
ARG INCLUDE_DB=false

# CVE-2026-111497 ("Node2Shell", out-of-bounds write in the Brotli decoder):
# Node must be at least 24.22.1 (22.23.4 on the 22 line). Pinned to an exact
# patch so a floating tag can never fall back to a vulnerable build;
# src/lib/server/dockerfileNodePins.spec.ts enforces it.
FROM node:24.22.1-slim AS base

# install dotenv-cli
RUN npm install -g dotenv-cli

# switch to a user that works for spaces
RUN userdel -r node
RUN useradd -m -u 1000 user
USER user

ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR /app

# add a .env.local if the user doesn't bind a volume to it
RUN touch /app/.env.local

USER root
RUN apt-get update
RUN apt-get install -y libgomp1 libcurl4 curl dnsutils nano

# ensure npm cache dir exists before adjusting ownership
RUN mkdir -p /home/user/.npm && chown -R 1000:1000 /home/user/.npm

USER user


COPY --chown=1000 .env /app/.env
COPY --chown=1000 entrypoint.sh /app/entrypoint.sh
COPY --chown=1000 package.json /app/package.json
COPY --chown=1000 package-lock.json /app/package-lock.json

RUN chmod +x /app/entrypoint.sh

FROM node:24.22.1 AS builder

WORKDIR /app

COPY --link --chown=1000 package-lock.json package.json ./

ARG APP_BASE=
ARG PUBLIC_APP_COLOR=
ENV BODY_SIZE_LIMIT=15728640

RUN --mount=type=cache,target=/app/.npm \
    npm set cache /app/.npm && \
    npm ci

COPY --link --chown=1000 . .

# The builder needs more than 3 GB now: the images build on the v0.26.0 tag
# aborted at 3072 with "Ineffective mark-compacts near heap limit" (exit 134),
# so the default leaves headroom at 6144. Builder stage only: the running
# server keeps Node's default.
ARG BUILD_HEAP_MB=6144
RUN git config --global --add safe.directory /app && \
    NODE_OPTIONS=--max-old-space-size=${BUILD_HEAP_MB} npm run build && \
    node scripts/check-bundle.mjs

# Runtime dependencies only. The builder needs the whole tree (vite, svelte-check,
# the test tooling); the running server needs only `dependencies`, which is what
# adapter-node leaves as external imports (devDependencies are bundled into
# build/). Same base and lockfile as the builder, so native packages (sharp,
# resvg) resolve to the same binaries. `prepare` runs husky, a dev tool, so it
# is dropped here; no other install script needs a dev dependency.
FROM node:24.22.1 AS prod-deps

WORKDIR /app

COPY --link --chown=1000 package-lock.json package.json ./

RUN --mount=type=cache,target=/app/.npm \
    npm set cache /app/.npm && \
    npm pkg delete scripts.prepare && \
    npm ci --omit=dev

# galopin, the machine agent (agent/): the four binaries the deployment
# serves at {base}/galopin/*, built with the same flags as
# agent/packaging/build-dist.sh (static, CGO off, trimpath, stripped).
FROM golang:1.24 AS galopin
WORKDIR /src/agent
COPY --link agent/go.mod agent/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY --link agent/ ./
ARG PUBLIC_COMMIT_SHA=
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    set -eu; mkdir -p /out; \
    for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64; do \
        os=${target%/*}; arch=${target#*/}; \
        CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags='-s -w' -o /out/galopin-$os-$arch .; \
    done; \
    echo "built from Cerea ${PUBLIC_COMMIT_SHA:-unknown}" > /out/REVISION; \
    cd /out && sha256sum galopin-* > SHA256SUMS

# mongo image
FROM mongo:7 AS mongo

# image to be used if INCLUDE_DB is false
FROM base AS local_db_false

# image to be used if INCLUDE_DB is true
FROM base AS local_db_true

# copy mongo from the other stage
COPY --from=mongo /usr/bin/mongo* /usr/bin/

ENV MONGODB_URL=mongodb://localhost:27017
USER root
RUN mkdir -p /data/db
RUN chown -R 1000:1000 /data/db
USER user
# final image
FROM local_db_${INCLUDE_DB} AS final

# build arg to determine if the database should be included
ARG INCLUDE_DB=false
ENV INCLUDE_DB=${INCLUDE_DB}

# svelte requires APP_BASE at build time so it must be passed as a build arg
ARG APP_BASE=
ARG PUBLIC_APP_COLOR=
ARG PUBLIC_COMMIT_SHA=
ENV PUBLIC_COMMIT_SHA=${PUBLIC_COMMIT_SHA}
ENV BODY_SIZE_LIMIT=15728640

#import the build & dependencies
COPY --from=builder --chown=1000 /app/build /app/build
COPY --from=prod-deps --chown=1000 /app/node_modules /app/node_modules
COPY --from=builder --chown=1000 /app/server.js /app/server.js
# The GridFS -> S3 migration tool (docs/storage.md): a plain Node script that
# needs only the runtime dependencies above and the settings parser it shares
# with the app (type-stripped by Node at run time).
COPY --from=builder --chown=1000 /app/scripts/blobs-migrate.mjs /app/scripts/blobs-migrate.mjs
COPY --from=builder --chown=1000 /app/src/lib/server/blobs/config.ts /app/src/lib/server/blobs/config.ts
COPY --from=galopin --chown=1000 /out /app/galopin-dist

CMD ["/bin/bash", "-c", "/app/entrypoint.sh"]
