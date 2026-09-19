#!/usr/bin/env bash
#
# Run the installer without needing node on the host.
#
#   ./installer/install.sh [--pystino <path>] [--phase2]
#
# Same installer, same arguments — this only decides what runs it. With node
# on the PATH it execs it directly; without, it runs it inside a node
# container, so a box that has docker and nothing else can still install.
#
# Why not rewrite the installer in bash: what it actually does is generate
# secrets, hold a JSON client registry, round-trip an env file whose signing
# key is a multi-line PEM, and drive a TUI. Bash can do the first with openssl
# and is genuinely bad at the rest — a rewrite would trade a runtime nobody
# needs at run time for a class of quoting bug nobody can see. The node stays;
# the *requirement* on the host is what goes.
#
# The container fallback mounts three things and each one is deliberate:
#
#   the docker socket   the installer's whole job is running docker compose.
#                       This is root-equivalent on the host — the same power
#                       the operator already has to be holding to install
#                       anything here, but worth saying out loud.
#   the docker CLI      plus the compose plugin, from the host. The alternative
#                       is installing docker inside a node image on every run.
#   the checkouts, at their own absolute paths. Not a convenience: compose
#                       build contexts are resolved by the *daemon* on the
#                       host, so a path that differs inside the container
#                       names a directory the daemon cannot see.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
entry="$here/installer/install.mjs"

[ -f "$entry" ] || { echo "not a Cerea checkout: $entry is missing" >&2; exit 1; }

if command -v node >/dev/null 2>&1; then
	exec node "$entry" "$@"
fi

command -v docker >/dev/null 2>&1 || {
	cat >&2 <<-EOF
		Neither node nor docker is on the PATH.

		This installer runs on either: node directly, or docker (it runs the
		installer in a node container for you). Install one of them — docker is
		needed anyway for what the installer brings up.
	EOF
	exit 1
}

compose_plugin="$(docker info --format '{{range .ClientInfo.Plugins}}{{if eq .Name "compose"}}{{.Path}}{{end}}{{end}}' 2>/dev/null || true)"
docker_bin="$(command -v docker)"

# The parent of both checkouts, mounted at its own path so the daemon and the
# container agree on what every path means. Pystino is a sibling by
# convention; --pystino elsewhere still works as long as it is under this
# parent, and the installer says so plainly if it cannot find it.
workspace="$(dirname "$here")"

echo "node is not installed; running the installer in a container instead."
echo "  workspace: $workspace (mounted at the same path)"
echo

# -t only when there is a terminal to attach: `docker run -it` fails outright
# without one, and the installer is also run from scripts and CI.
tty_flags=(-i)
[ -t 1 ] && tty_flags+=(-t)

mounts=(
	-v "$workspace:$workspace"
	-v /var/run/docker.sock:/var/run/docker.sock
	-v "$docker_bin:/usr/local/bin/docker:ro"
)
[ -n "$compose_plugin" ] && mounts+=(-v "$compose_plugin:/usr/local/lib/docker/cli-plugins/docker-compose:ro")

exec docker run --rm "${tty_flags[@]}" \
	"${mounts[@]}" \
	-w "$here" \
	-e HOME=/tmp \
	node:24-bookworm-slim \
	node "$entry" "$@"
