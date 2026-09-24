#!/usr/bin/env bash
# edge_proxy_running / maybe_restart_edge_proxy: Caddyfile.netbird is
# bind-mounted into the proxy and rewritten in place via `mv` (a new inode),
# so `up -d` alone never notices and a proxy that was already running keeps
# serving the stale file — the failure mode that left `--phase2 --components
# code-panel=on` against a live stack answering /ws with a 404 until someone
# restarted the proxy by hand. These pin: a restart only fires when the
# route was actually written AND the proxy was already running (an install
# that never touched Caddyfile.netbird, or a stack not up yet, must not
# restart anything), and a dry run never calls docker at all.
#
# No real daemon or containers: a fake `docker` on PATH logs every
# invocation and answers `compose ... ps ...` from FAKE_PROXY_RUNNING, which
# is enough to drive both functions exactly the way install.sh calls them.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
. tests/lib.sh
. lib/term.sh
. lib/compose-flags.sh

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/cerea-edge-proxy-tests.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT

mkdir -p "$TMPD/bin"
cat >"$TMPD/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
for a in "$@"; do
	if [ "$a" = "ps" ]; then
		[ "${FAKE_PROXY_RUNNING:-0}" = "1" ] && echo proxy
		exit 0
	fi
done
exit 0
EOF
chmod +x "$TMPD/bin/docker"

envfile="$TMPD/deploy.env"
: >"$envfile"
DOCKER_LOG="$TMPD/docker.log"

edge_proxy_running_src="$(sed -n '/^edge_proxy_running() {/,/^}/p' ./install.sh)"
maybe_restart_edge_proxy_src="$(sed -n '/^maybe_restart_edge_proxy() {/,/^}/p' ./install.sh)"
try_compose_src="$(sed -n '/^try_compose() {/,/^}/p' ./install.sh)"
run_compose_src="$(sed -n '/^run_compose() {/,/^}/p' ./install.sh)"
dry_print_cmd_src="$(sed -n '/^dry_print_cmd() {/,/^}/p' ./install.sh)"

run_maybe_restart() { # run_maybe_restart <dry_run> <written> <was_running> -> stdout (function's own output)
	local dry_run="$1" written="$2" was_running="$3"
	: >"$DOCKER_LOG"
	PATH="$TMPD/bin:$PATH" DOCKER_LOG="$DOCKER_LOG" ENVFILE="$envfile" \
		PYSTINO_ROOT="$TMPD" EXPOSURE=edge DRY_RUN="$dry_run" bash -c '
			source ./lib/term.sh
			source ./lib/compose-flags.sh
			SCRUB=(env docker)
			'"$try_compose_src"'
			'"$run_compose_src"'
			'"$maybe_restart_edge_proxy_src"'
			'"$dry_print_cmd_src"'
			EDGE_ROUTE_WRITTEN='"$written"'
			maybe_restart_edge_proxy "$ENVFILE" '"$was_running"'
		' 2>&1
}

# ---- 1: written + already running -> restarts the proxy via run_compose
out="$(run_maybe_restart 0 1 1)"
assert_contains "written+running restarts the proxy" "restart proxy" "$(cat "$DOCKER_LOG")"
assert_contains "the restart uses the base + exposure overlay, matching how the proxy service is defined" "docker-compose.edge.yml" "$(cat "$DOCKER_LOG")"
assert_contains "the restart is announced" "Restarting the proxy" "$out"

# ---- 2: written but not running (a stack not up yet — `up -d` handles it) -> no docker call
run_maybe_restart 0 1 0 >/dev/null
assert_eq "written+not-running makes no docker call" "" "$(cat "$DOCKER_LOG")"

# ---- 3: not written (Caddyfile.netbird untouched this run) -> no docker call even if running
run_maybe_restart 0 0 1 >/dev/null
assert_eq "not-written makes no docker call even when the proxy is running" "" "$(cat "$DOCKER_LOG")"

# ---- 4: dry run never touches docker, written or not — a dry run promises
# it needs no live daemon
out="$(run_maybe_restart 1 1 1)"
assert_eq "a dry run makes no docker call at all" "" "$(cat "$DOCKER_LOG")"
assert_contains "a dry run notes what it would do instead" "would restart the proxy" "$out"

# ---- 5: edge_proxy_running reports the fake daemon's own answer
run_edge_proxy_running() { # run_edge_proxy_running <fake_proxy_running> -> "true"/"false"
	local fake="$1"
	: >"$DOCKER_LOG"
	PATH="$TMPD/bin:$PATH" DOCKER_LOG="$DOCKER_LOG" ENVFILE="$envfile" FAKE_PROXY_RUNNING="$fake" \
		PYSTINO_ROOT="$TMPD" EXPOSURE=edge bash -c '
			source ./lib/term.sh
			SCRUB=(env docker)
			'"$edge_proxy_running_src"'
			if edge_proxy_running "$ENVFILE"; then echo true; else echo false; fi
		'
}
assert_eq "edge_proxy_running reports true when the fake daemon lists proxy" "true" "$(run_edge_proxy_running 1)"
assert_eq "edge_proxy_running reports false when the fake daemon does not" "false" "$(run_edge_proxy_running 0)"

summary "test-edge-proxy-restart.sh"
