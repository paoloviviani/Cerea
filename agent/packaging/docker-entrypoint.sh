#!/bin/bash
# The container's entrypoint (agent/Dockerfile). Any command given to the
# container runs as it is (`docker run IMAGE bash`, `... galopin enroll ...`).
# With none, the default `start` does the most useful thing it can:
#
#   start ARGS...                       enroll with exactly ARGS (the flags of
#                                       `galopin enroll`, as the chat's Pair dialog
#                                       prints them), then run the agent
#   enrolled already (a mounted home)   run the agent
#   addresses in the environment        enroll, then run the agent
#   neither                             a shell, with the commands to type
#
# Environment (all optional):
#   GATEWAY_BASE_URL    the deployment's gateway origin, e.g. https://cerea.example.org
#   CEREA_BASE_URL      the chat's address; default $GATEWAY_BASE_URL/chat (the deploy kit)
#   OIDC_ISSUER         the sign-in issuer; default $GATEWAY_BASE_URL/authelia (the deploy kit)
#   GALOPIN_ENROLL_ARGS extra arguments for `galopin enroll`, split on spaces
#                       (no quoting), e.g. "--client-id my-id --group research"
#   GALOPIN_RUN_ARGS    extra arguments for `galopin run`, split the same way
set -eu

if [ "${1:-}" != start ]; then
    exec "$@"
fi
shift

state="${XDG_CONFIG_HOME:-$HOME/.config}/galopin"
gateway="${GATEWAY_BASE_URL:-}"
cerea="${CEREA_BASE_URL:-}"
issuer="${OIDC_ISSUER:-}"
if [ -n "$gateway" ]; then
    gateway="${gateway%/}"
    : "${cerea:=$gateway/chat}"
    : "${issuer:=$gateway/authelia}"
fi

# Split an argument string on whitespace, without globbing or quoting.
split() { set -f; # shellcheck disable=SC2086
    printf '%s\n' $1; set +f; }

run_agent() {
    args=()
    while IFS= read -r a; do [ -n "$a" ] && args+=("$a"); done < <(split "${GALOPIN_RUN_ARGS:-}")
    exec galopin run "${args[@]}"
}

# Arguments after `start` are enroll's own, taken as they are (no splitting, so a
# path with spaces or a glob survives), and they win over everything below. A
# home that is already enrolled makes enroll ask before it overwrites.
if [ "$#" -gt 0 ]; then
    galopin enroll "$@"
    run_agent
fi

if [ -f "$state/credentials.json" ]; then
    echo "galopin: already enrolled; starting the agent." >&2
    run_agent
fi

if [ -n "$gateway" ] && [ -n "$cerea" ] && [ -n "$issuer" ]; then
    args=(--issuer "$issuer" --gateway "$gateway" --cerea "$cerea")
    while IFS= read -r a; do [ -n "$a" ] && args+=("$a"); done < <(split "${GALOPIN_ENROLL_ARGS:-}")
    galopin enroll "${args[@]}"
    run_agent
fi

cat >&2 <<MSG
galopin container: opencode $(opencode --version 2>/dev/null || echo '?'), not enrolled yet.

Pair this container with your chat (the Agents panel prints the same command):

  galopin enroll --issuer <issuer> --gateway <gateway> --cerea <chat address>
  galopin run

Or start it again with GATEWAY_BASE_URL set (and CEREA_BASE_URL, OIDC_ISSUER
when they are not the deploy kit's defaults) to do both on its own.
Your project goes in /workspace.

MSG
exec bash
