# syntax=docker/dockerfile:1
#
# galopin + opencode in a disposable development container.
#
# The same galopin and the same pinned opencode a computer runs, wrapped with
# the tools a coding agent reaches for (python, node, a C toolchain, git, gh),
# so a person can pair a throwaway environment with the chat's Agents panel
# without installing anything on their own machine. Nothing here talks to a
# deployment at build time; the container is enrolled when it runs.
#
# Build context is THIS directory (agent/):
#
#   docker build -t galopin agent/              # from the repository root
#   docker build -t galopin .                   # from agent/
#
# Published as ghcr.io/<owner>/galopin:X.Y.Z with the Cerea release (images.yml).
# How to run it: docs/agent-machines.md ("Run galopin in a container").

# --- galopin: the static Go binary, built from this tree -------------------
FROM --platform=$BUILDPLATFORM golang:1.24.13 AS galopin
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
COPY third_party/ ./third_party/
RUN go mod download
COPY . .
# The same flags as packaging/build-dist.sh: static (no libc dependency), stripped.
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags='-s -w' -o /out/galopin .

# --- uv: the python package manager, copied from its own image -------------
FROM ghcr.io/astral-sh/uv:0.13.7 AS uv

# --- the container ----------------------------------------------------------
# CVE-2026-111497 ("Node2Shell", Brotli decoder): Node must be at least
# 24.22.1. Pinned to an exact patch, as in the chat's own Dockerfile;
# src/lib/server/dockerfileNodePins.spec.ts enforces it for every Dockerfile.
FROM node:24.22.2-slim

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive

# The toolbox: git and ssh, a C/C++ toolchain with make (build-essential),
# python with venv and pip, and the small tools agents lean on (rg, jq).
# tini is PID 1: galopin supervises opencode, which runs shell commands, and
# something has to reap the children they leave behind.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl git jq less openssh-client \
        procps python3 python3-pip python3-venv ripgrep tini unzip \
    && rm -rf /var/lib/apt/lists/*

# gh, from GitHub's own apt repository (Debian's package is old).
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/
RUN npm install -g pnpm@10 && npm cache clean --force

# opencode: the release galopin is built and tested against, checked against
# the checksums recorded in this repository, like the installer does.
COPY packaging/opencode-version packaging/opencode-sha256 /tmp/opencode/
RUN set -eu; \
    case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "no opencode build for $TARGETARCH" >&2; exit 1 ;; esac; \
    version=$(cat /tmp/opencode/opencode-version); \
    archive="opencode-linux-$arch.tar.gz"; \
    want=$(awk -v f="$archive" '$2 == f { print $1 }' /tmp/opencode/opencode-sha256); \
    [ -n "$want" ] || { echo "no checksum recorded for $archive" >&2; exit 1; }; \
    curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v$version/$archive" -o "/tmp/$archive"; \
    echo "$want  /tmp/$archive" | sha256sum -c -; \
    tar -xzf "/tmp/$archive" -C /usr/local/bin opencode; \
    rm -rf "/tmp/$archive" /tmp/opencode; \
    opencode --version

COPY --from=galopin /out/galopin /usr/local/bin/galopin
COPY packaging/docker-entrypoint.sh /usr/local/bin/galopin-entrypoint

# A user that fits a bind-mounted project on a typical host (uid 1000), and
# the workspace the Agents panel is pointed at.
RUN userdel -r node \
    && useradd -m -u 1000 -s /bin/bash galopin \
    && mkdir /workspace && chown galopin:galopin /workspace \
    # A bind-mounted project is owned by the host's user: git must not refuse it.
    && git config --system --add safe.directory '*'

USER galopin
ENV HOME=/home/galopin \
    NPM_CONFIG_PREFIX=/home/galopin/.npm-global \
    PATH=/home/galopin/.local/bin:/home/galopin/.npm-global/bin:$PATH \
    # The container is disposable: `pip install` should just work (user site).
    PIP_BREAK_SYSTEM_PACKAGES=1
WORKDIR /workspace

# Everything galopin keeps (the enrollment, opencode's data, gh and git
# settings) is under /home/galopin. There is deliberately no VOLUME: a
# disposable container leaves nothing behind, and a person who wants the
# enrollment to survive a restart mounts a named volume there (see the docs).

ENTRYPOINT ["tini", "--", "galopin-entrypoint"]
CMD ["start"]
