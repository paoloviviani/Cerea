#!/usr/bin/env bash
#
# compose-flags.sh — docker compose argument assembly.
#
# Everything that decides WHICH words surround `docker compose` without
# ever running docker: the --build materialisation, the env-var scrub list,
# the overlay file lists, the phase-1 set, the `exec -T` rewrite and the
# scrub filter for the parse check. Pure array/string work over the value
# store and the parsed .env (parse_env_file and VALUES come from
# lib/envfile.sh and lib/values.sh). What actually EXECUTES compose —
# try_compose, run_compose, overlay_flags, the waits — stays in install.sh.
# Unit-tested by installer/tests/test-compose-flags.sh.
#
# State:
#   BUILD / BUILD_FLAG   --build switch and its materialised form (BUILD_FLAG
#                        is empty normally, (--build) when forced)
#   SCRUB                array: the `env -u ...` prefix that keeps compose
#                        children from seeing a sourced variable win over
#                        --env-file (built by build_scrub)
#   SCRUB_KEEP           array: SCRUB minus one kept key (scrub_keep)
#   OVERLAY_FLAGS        array: the -f file list for a standalone set
#   BASE_FLAGS           array: the phase-1 -f file list (phase_one_flags)
#   COMPOSE_ARGS         array: compose_exec_t's rewritten argument list
#   COMPOSE_PROFILES_VALUE  derive_compose_profiles' output: the comma list
#                        this install shape activates ("" when none — a
#                        gateway-only shape omits the variable entirely)
#   UP_SERVICES          array: the services the compose.sh wrapper's `up`
#                        names explicitly — the standalone sets, where a
#                        name-less `up -d` would start the base file's
#                        always-defined (untagged) gateway nobody asked for;
#                        empty for gateway profiles, whose set is decided by
#                        the profiles alone
#
# Functions (inputs -> outputs):
#   set_build_flag <0|1>            -> BUILD_FLAG[] (--build when 1, empty when 0)
#   build_scrub <env-file>          -> SCRUB[] = env -u <every key in the file
#                                      and in VALUES> -u GATEWAY_PORT docker
#   scrub_keep <key>                -> SCRUB_KEEP[] = SCRUB minus the -u <key>
#                                      pair (the parse check keeps CHAT_REPO,
#                                      re-supplied as an explicit assignment)
#   derive_compose_profiles         -> COMPOSE_PROFILES_VALUE from PROFILE +
#                                      VALUES[IDP_BUNDLED]: chat for every
#                                      profile that ships it, plus the
#                                      bundled IdP's own profile tag
#   compose_wrapper_text <env-file> <embed-profiles> <overlay-args...>
#                                   -> the deploy/compose.sh script on stdout
#                                      (uses UP_SERVICES for the up/build
#                                      service args)
#   write_compose_wrapper <out> <env-file> <embed-profiles> <overlay-args...>
#                                   -> compose_wrapper_text written to <out>,
#                                      mode 755
#   standalone_overlay_flags <edge|proxy> [authelia] -> OVERLAY_FLAGS[], the
#                                      standalone set (base + chat + exposure,
#                                      plus the Authelia bundle when asked)
#   idp_overlay_file                -> the bundled IdP's compose file on stdout,
#                                      empty when no provider ships
#   append_idp_overlay              -> OVERLAY_FLAGS[] += the bundled IdP's file
#   phase_one_flags                 -> BASE_FLAGS[] = base + (exposure + IdP
#                                      overlay when bundled) + (redaction overlay
#                                      when the engine is not noop)
#   compose_exec_t <args...>        -> COMPOSE_ARGS[] with the first bare `exec`
#                                      rewritten to `exec -T` (a scripted run has
#                                      no terminal to allocate)

# `up` builds an image that is missing anyway (a service with a `build:` and no
# local image), so a fresh install still builds without being told to. `--build`
# forces a rebuild of images that already exist — the only thing worth asking
# for, and only sometimes. Off by default so a re-run reuses what is built, and
# so a future deployment pulling ready-made images from a registry is not made
# to rebuild them from source. Materialised into BUILD_FLAG in main().
BUILD=0
BUILD_FLAG=()
UP_SERVICES=()

set_build_flag() { # set_build_flag <0|1> -> BUILD_FLAG[]
	if [ "$1" = "1" ]; then BUILD_FLAG=(--build); else BUILD_FLAG=(); fi
}

# Compose prefers same-named shell variables over --env-file, so a stray
# export would silently win over the file just written — a sourced deploy/.env
# in the operator's shell is the classic shape of that. Every key that
# appears in the file (plus GATEWAY_PORT, which compose reads even when the
# fragment never names it) is scrubbed from the children's environment, so
# the file is the only source that survives.
build_scrub() { # build_scrub <env-file>
	SCRUB=(env)
	local key
	parse_env_file "$1"
	for key in "${PARSED_ORDER[@]}"; do
		SCRUB+=(-u "$key")
	done
	for key in "${VALUES_ORDER[@]}"; do
		SCRUB+=(-u "$key")
	done
	SCRUB+=(-u GATEWAY_PORT docker)
}

# The same scrub minus one pair: the compose parse check re-supplies
# CHAT_REPO explicitly (the overlay derivation needed it), so its -u must
# go. The loop is a two-token state machine over `-u <key>` pairs;
# everything that is not a kept `-u <key>` pair survives, and the trailing
# non-option words (docker) are dropped here — the caller re-adds what it
# needs.
scrub_keep() { # scrub_keep <key> -> SCRUB_KEEP[]
	local keep="$1" sk skip_next=0
	SCRUB_KEEP=(env)
	for sk in "${SCRUB[@]}"; do
		if [ "$skip_next" = "1" ]; then
			if [ "$sk" != "$keep" ]; then SCRUB_KEEP+=(-u "$sk"); fi
			skip_next=0
			continue
		fi
		if [ "$sk" = "-u" ]; then skip_next=1; fi
	done
}

# The compose profiles this install shape activates, derived from the same
# globals that decided the .env values — the wiring P1 flagged as the
# transition hazard: Pystino's compose files now tag the chat add-on
# (`chat`) and each bundled IdP (`authelia`/`keycloak`), so a fresh install
# that activates nothing would compose without them. Every profile in the
# vocabulary ships the chat; a shape with no PROFILE (a gateway-only install,
# none today) derives empty and the caller omits the variable entirely.
# The result travels as a regular COMPOSE_PROFILES line in deploy/.env —
# compose reads it natively from --env-file (verified live: `docker compose
# config --services` resolves the tagged services with no other input) —
# which is what makes the installer's name-less phase-2 `up -d` bring up
# exactly the shape's set while phase 1 keeps naming its services
# explicitly (naming a service auto-activates its profile).
derive_compose_profiles() { # derive_compose_profiles -> COMPOSE_PROFILES_VALUE
	local parts=()
	case "${PROFILE:-}" in
		homelab | team | enterprise | satellite | generic) parts+=(chat) ;;
		# An unknown or absent profile is a gateway-only shape: no chat to
		# activate, so the line is omitted rather than written empty.
	esac
	case "${VALUES[IDP_BUNDLED]:-}" in
		authelia | keycloak) parts+=("${VALUES[IDP_BUNDLED]}") ;;
	esac
	local IFS=,
	COMPOSE_PROFILES_VALUE="${parts[*]}"
}

# The deploy/compose.sh wrapper's text on stdout. It records the exact
# compose command line this install derived — env-file and overlay list —
# under five subcommands that map one-to-one onto docker compose, so the
# operator never retypes the -f list (this replaces the stale
# deploy/compose.txt comment convention, which also dropped its -f flags on
# the floor). embed-profiles is the comma list emitted as --profile flags,
# and it is empty whenever deploy/.env itself carries COMPOSE_PROFILES: the
# flags REPLACE that list rather than extending it (compose gives the
# command line precedence over the file — verified live), so supplying them
# unconditionally would silently override an operator's edit of the line.
# They are emitted only for .env files written before the line existed,
# where the wrapper is what supplies the activation the file lacks.
# UP_SERVICES names what `up`/`build` start explicitly: the standalone sets
# need it (a name-less `up -d` would start every untagged service the base
# file defines, including the gateway a standalone box must never run);
# gateway profiles leave it empty and let the profiles decide the set.
compose_wrapper_text() { # compose_wrapper_text <env-file> <embed-profiles> <overlay-args...>
	local envfile="$1" embed="$2"
	shift 2
	local -a args=("$@")
	local p i up_words=""
	printf '#!/usr/bin/env bash\n'
	printf '#\n'
	printf '# deploy/compose.sh — written by installer/install.sh at install time.\n'
	printf '#\n'
	printf "# The exact docker compose command line this deployment runs, recorded so\n"
	printf '# the overlay list never has to be retyped (this replaces the old\n'
	printf '# deploy/compose.txt comment, which also dropped its -f flags). Each\n'
	printf '# subcommand maps onto docker compose:\n'
	printf "#   up      bring this deployment's service set up, detached\n"
	printf '#   down    stop and remove its containers (named volumes keep their data —\n'
	printf '#           the databases outlive the containers)\n'
	printf '#   logs    follow the merged logs (extra names narrow: ./deploy/compose.sh logs chat)\n'
	printf '#   ps      list its containers (extra args pass through)\n'
	printf '#   build   up -d --build: rebuild the images built from source (the chat\n'
	printf "#           image) and bring the set back up on top of them\n"
	printf '#\n'
	printf '# The --profile flags below appear only when deploy/.env predates its\n'
	printf "# COMPOSE_PROFILES line: they activate this install's decided set (chat,\n"
	printf '# plus the bundled IdP when there is one). They REPLACE that env-file line\n'
	printf '# rather than extending it — edit them here (or delete them once the line\n'
	printf '# exists in deploy/.env) to change the set. The installer rewrites this\n'
	printf '# file on every full run.\n'
	printf 'set -euo pipefail\n'
	printf 'cd "$(dirname "${BASH_SOURCE[0]}")/.."   # the checkout root: the -f paths are relative to it\n'
	printf '\n'
	printf 'COMPOSE=(docker compose --env-file %s\n' "$envfile"
	if [ -n "$embed" ]; then
		local IFS=,
		for p in $embed; do
			printf '\t--profile %s\n' "$p"
		done
		IFS=$' \t\n'
	fi
	i=0
	while [ "$i" -lt "${#args[@]}" ]; do
		printf '\t%s %s\n' "${args[$i]}" "${args[$((i + 1))]}"
		i=$((i + 2))
	done
	printf ')\n'
	if [ "${#UP_SERVICES[@]}" -gt 0 ]; then
		for p in "${UP_SERVICES[@]}"; do up_words="$up_words$p "; done
	fi
	printf '\n'
	printf 'case "${1:-}" in\n'
	if [ -n "$up_words" ]; then
		printf '\tup)    shift; exec "${COMPOSE[@]}" up -d %s"$@" ;;\n' "$up_words"
		printf '\tbuild) shift; exec "${COMPOSE[@]}" up -d --build %s"$@" ;;\n' "$up_words"
	else
		printf '\tup)    shift; exec "${COMPOSE[@]}" up -d "$@" ;;\n'
		printf '\tbuild) shift; exec "${COMPOSE[@]}" up -d --build "$@" ;;\n'
	fi
	printf '\tdown)  shift; exec "${COMPOSE[@]}" down "$@" ;;\n'
	printf '\tlogs)  shift; exec "${COMPOSE[@]}" logs -f "$@" ;;\n'
	printf '\tps)    shift; exec "${COMPOSE[@]}" ps "$@" ;;\n'
	printf '\t*)     echo "usage: $0 {up|down|logs|ps|build}" >&2; exit 2 ;;\n'
	printf 'esac\n'
}

# Write the wrapper for real: generated text, executable bit — the operator
# runs it, not sources it.
write_compose_wrapper() { # write_compose_wrapper <out-path> <env-file> <embed-profiles> <overlay-args...>
	local out="$1"
	shift
	compose_wrapper_text "$@" >"$out"
	chmod 755 "$out"
}

# The whole standalone overlay set: base + chat + exposure, the same files
# the gateway profiles use — the gateway, valkey, migrate and redaction
# services are excluded by starting services by name, not by a different
# file list. Satellite-local adds the Authelia overlay (the only bundle a
# standalone profile ships: no gateway means no console client, and Keycloak
# was scoped to team/enterprise).
standalone_overlay_flags() { # standalone_overlay_flags <exposure> [idp]
	local exposure="$1" idp="${2:-}"
	case "$exposure" in
		edge | proxy) ;;
		*) fail "exposure must be 'edge' or 'proxy' (got '$exposure')" ;;
	esac
	OVERLAY_FLAGS=(-f deploy/compose/docker-compose.yml
		-f deploy/compose/docker-compose.chat.yml
		-f "deploy/compose/docker-compose.${exposure}.yml")
	if [ -n "$idp" ]; then
		case "$idp" in
			authelia) OVERLAY_FLAGS+=(-f deploy/compose/docker-compose.idp-authelia.yml) ;;
			*) fail "standalone profiles ship only the Authelia bundle (got '$idp')" ;;
		esac
	fi
}

# The bundled-IdP overlay for this install, if any: the file the IdP streams
# added (read-only; the installer only selects it). Empty when no provider
# ships with this deployment.
idp_overlay_file() {
	case "${VALUES[IDP_BUNDLED]:-}" in
		authelia) echo "deploy/compose/docker-compose.idp-authelia.yml" ;;
		keycloak) echo "deploy/compose/docker-compose.idp-keycloak.yml" ;;
		*) echo "" ;;
	esac
}

# Append the bundled overlay to OVERLAY_FLAGS when one is selected. Called
# after every derivation (phase-two sets and the dry-run parse check), so no
# derivation has to know about the bundles.
append_idp_overlay() {
	local f
	f="$(idp_overlay_file)"
	if [ -n "$f" ]; then OVERLAY_FLAGS+=(-f "$f"); fi
}

# The phase-1 compose set, shared by phase_one and main's parse check (the
# bundled gateway profiles bring up a smaller set first, and a dry run
# proves that set parses too). The IdP ships in phase 1: the gateway reads
# OIDC discovery once at startup, so the issuer must already answer before
# the restart the CA dance ends with. The exposure overlay joins the set so
# the proxy service — which the IdP overlay extends with its route — has its
# image (without it the set does not parse). The gateway refuses engine=http
# without an endpoint, and only the redaction overlay names one — a fresh
# pattern/NER install dies in phase 1 without it (found live: the crash
# reads "redaction.endpoint is required"). Services still start by name
# below, so the overlay joins the set for its variables, never its
# containers.
phase_one_flags() { # -> BASE_FLAGS[]
	local idp_file
	idp_file="$(idp_overlay_file)"
	if [ -n "$idp_file" ]; then
		BASE_FLAGS=(-f deploy/compose/docker-compose.yml
			-f "deploy/compose/docker-compose.${EXPOSURE}.yml"
			-f "$idp_file")
	else
		BASE_FLAGS=(-f deploy/compose/docker-compose.yml)
	fi
	if [ "${REDACTION_STATE:-off}" != "off" ]; then
		BASE_FLAGS+=(-f deploy/compose/docker-compose.redaction.yml)
	fi
}

# The exec rewrite for try_compose, moved verbatim from it: the first bare
# `exec` gains -T. A scripted run (answers piped in) has no terminal to
# allocate, and without -T the container sees EOF at the first prompt — the
# phase-1 `gateway passwd` step then dies mid-password. With -T the prompt
# reads stdin, echoing it with the same warning ask_hidden already gives for
# non-TTY secrets.
compose_exec_t() { # compose_exec_t <args...> -> COMPOSE_ARGS[]
	local -a compose_args=()
	local seen_exec=0 arg
	for arg in "$@"; do
		if [ "$seen_exec" = "0" ] && [ "$arg" = "exec" ]; then
			compose_args+=(exec -T)
			seen_exec=1
		else
			compose_args+=("$arg")
		fi
	done
	COMPOSE_ARGS=("${compose_args[@]}")
}
