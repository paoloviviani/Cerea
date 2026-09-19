#!/usr/bin/env bash
#
# Tear down what installer/install.mjs brought up.
#
#   ./installer/teardown.sh [--pystino <path>] [--backup] [--images] [--all] [--yes]
#
# The installer is in this repository, so an operator here has never had reason
# to learn that the compose files — and the script that removes them — live in
# the other one. This is that door.
#
# Shell, not node: the installer needs a node runtime because it is a TUI that
# has to run against a fresh clone before `npm install`, and a teardown needs
# neither. Everything here is docker plus a handover, so requiring a language
# runtime to delete containers would be a dependency bought for nothing.
#
# It reimplements none of the work. Pystino's deploy/teardown.sh is the single
# implementation and this hands straight over, flags and all — two copies of
# "remove these containers and these volumes" would drift, and the half that
# drifted would be found on the day it needed to be right.
#
# Finding the Pystino checkout: ask Docker first. Every container compose
# created carries `com.docker.compose.project.config_files`, the absolute paths
# it was brought up with, so a running deployment says where it came from.
# --pystino overrides, a sibling checkout is the fallback, and if all three
# fail the error names the flag rather than doing something approximate.
#
set -euo pipefail

project="llm-platform"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli_root=""
passthrough=()

while [ $# -gt 0 ]; do
	case "$1" in
	--pystino)
		[ $# -ge 2 ] || { echo "--pystino needs a path" >&2; exit 2; }
		cli_root="$2"
		shift 2
		;;
	--help | -h)
		sed -n '3,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		passthrough+=("$1")
		shift
		;;
	esac
done

is_pystino_root() { [ -f "$1/deploy/compose/docker-compose.yml" ]; }

root_from_running_deployment() {
	local id config
	id="$(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null | head -1)"
	[ -n "$id" ] || return 1
	config="$(docker inspect "$id" \
		--format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null \
		| cut -d, -f1)"
	[ -n "$config" ] || return 1
	# .../<root>/deploy/compose/docker-compose.yml -> <root>
	local candidate
	candidate="$(cd "$(dirname "$config")/../.." 2>/dev/null && pwd)" || return 1
	is_pystino_root "$candidate" || return 1
	echo "$candidate"
}

resolve_root() {
	if [ -n "$cli_root" ]; then
		local resolved
		resolved="$(cd "$cli_root" 2>/dev/null && pwd)" \
			|| { echo "no such directory: $cli_root" >&2; exit 1; }
		is_pystino_root "$resolved" || { echo "not a Pystino checkout: $resolved" >&2; exit 1; }
		echo "$resolved"
		return
	fi
	local found
	if found="$(root_from_running_deployment)"; then
		echo "$found"
		return
	fi
	local guess
	for guess in "$here/../Pystino" "$here/../pystino"; do
		if is_pystino_root "$guess"; then (cd "$guess" && pwd); return; fi
	done
	cat >&2 <<-EOF
		Could not find the Pystino checkout.

		Nothing of this deployment is running, so Docker cannot say where it came
		from, and no sibling checkout was found. Pass it:

		  ./installer/teardown.sh --pystino /path/to/Pystino
	EOF
	exit 1
}

root="$(resolve_root)"
script="$root/deploy/teardown.sh"

if [ ! -f "$script" ]; then
	cat >&2 <<-EOF
		This Pystino checkout has no deploy/teardown.sh:
		  $root

		It predates the script. Either update that checkout, or remove the
		deployment by hand:

		  docker ps -aq --filter label=com.docker.compose.project=$project | xargs -r docker rm -fv
		  docker volume ls -q --filter name=^${project}_ | xargs -r docker volume rm
	EOF
	exit 1
fi

echo "Cerea + Pystino teardown"
echo "Pystino checkout: $root"
echo "running $script"
echo
exec bash "$script" ${passthrough[@]+"${passthrough[@]}"}
