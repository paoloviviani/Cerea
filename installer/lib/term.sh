#!/usr/bin/env bash
#
# term.sh — the installer's terminal kit.
#
# The one piece of presentation every lib shares: the ANSI palette (empty
# when stdout is not a TTY, so a piped transcript stays clean) and the
# message verbs. `fail` is the libs' only control-flow primitive: it prints
# to stderr and exits 1 — which, inside a test's command substitution, ends
# exactly that subshell with the message intact.
#
# No state, no prompts, no files.
#
# Functions (inputs -> outputs):
#   title <text>     banner line: "\n== text =="
#   note <text>      dim line
#   warn <text>      "! text" in yellow
#   fail <text>      "error: text" to stderr, exit 1 — never returns

if [ -t 1 ]; then
	R=$'\e[0m'
	BOLD=$'\e[1m'
	DIM=$'\e[2m'
	RED=$'\e[31m'
	GREEN=$'\e[32m'
	YELLOW=$'\e[33m'
	CYAN=$'\e[36m'
else
	R=""
	BOLD=""
	DIM=""
	RED=""
	GREEN=""
	YELLOW=""
	CYAN=""
fi

title() { printf '\n%s== %s ==%s\n' "$BOLD" "$1" "$R"; }
note() { printf '%s%s%s\n' "$DIM" "$1" "$R"; }
warn() { printf '%s! %s%s\n' "$YELLOW" "$1" "$R"; }

fail() {
	printf '%serror: %s%s\n' "$RED" "$1" "$R" >&2
	exit 1
}
