#!/usr/bin/env bash
#
# The Cerea + Pystino installer: the main entry point for a new deployment.
#
# Zero runtime dependencies beyond bash, coreutils, openssl, git and docker —
# no node on the host, no container wrapping the installer. Run it against a
# fresh clone:
#
#   ./installer/install.sh [--pystino <path>] [--phase2] [--dry-run] [--build]
#                          [--profile <p>] [--exposure <e>] [--idp <i>]
#                          [--components <spec>] [--admin-email <email>]
#                          [--chat-repo <path>] [--set KEY=VALUE ...]
#                          [--non-interactive]
#
# What it does, in order: validates (or clones) the Pystino checkout, proposes
# the five deployment profiles, lets the operator toggle components within the
# chosen gateway profile, generates every secret locally, writes Pystino's
# deploy/.env from the matching profile fragment, then brings the stack up.
# Gateway profiles (homelab, team, enterprise) come up in two phases (postgres
# + gateway first, because the admin password and the chat database cannot
# exist before it runs; everything else second). Standalone profiles
# (satellite, generic) hold no gateway: phase 1 is the databases only, and no
# password or catalogue step ever runs — users live on the central deployment
# or the third party, not here. `--phase2` resumes against an existing
# deploy/.env. `--dry-run` resolves everything, writes the .env to a temp
# path, prints the exact docker compose command lines it would run, and
# exits — the only way to test this without tearing down a deployment.
#
# Non-interactive surface (lib/flags.sh): every decision the prompts ask for
# is addressable as a flag — --profile, --exposure, --idp, --components,
# --admin-email, --set KEY=VALUE. Any decision given by flag switches the run
# to non-interactive; a decision nothing supplies becomes a loud error
# listing exactly what is missing, so CI fails instead of hanging on stdin.
# Flagged values are consumed at the very prompt sites they answer, so they
# meet the same post-processing and the same validate_values as typed ones.
# The two passwords that never land in deploy/.env (Authelia's first admin,
# Keycloak's first user) travel only through the environment:
# IDP_ADMIN_PASSWORD / IDP_FIRST_PASSWORD.
#
# Installer metadata (lib/envfile.sh): every install writes a delimited
# `# >>> installer metadata >>>` block at the end of deploy/.env —
# INSTALLER_VERSION, INSTALLER_PROFILE, INSTALLER_EXPOSURE, INSTALLER_IDP,
# INSTALLER_AUTH_MODE, INSTALLER_COMPONENTS — recording the shape as it was
# decided. --phase2 (and a flagged fresh run, for contradiction checks) reads
# that block verbatim instead of reverse-engineering the shape from the
# values; the infer_* heuristics in lib/values.sh remain only as the legacy
# fallback for .env files written before the block existed. A flag that
# contradicts the block fails loudly with both values shown — never a
# silent pick.
#
# Compose profiles (Pystino's compose files tag the chat add-on `chat` and
# each bundled IdP `authelia`/`keycloak`): the installer derives
# COMPOSE_PROFILES from the install shape (lib/compose-flags.sh) and writes
# it as a regular deploy/.env line, which compose consumes natively from
# --env-file — so a fresh install's name-less phase-2 `up -d` brings up
# exactly the shape's set. Phase 1 keeps naming its services explicitly
# (naming a service auto-activates its profile), and the dry run verifies
# the activated set with `docker compose config --services`. deploy/compose.sh,
# written at the end of a real run (printed on a dry run), records the exact
# command line — env-file, overlay list, and --profile flags only where
# deploy/.env predates the line (the flags replace, never extend, the
# file's list).
#
# The bundled-IdP admin: phase 1 seeds the gateway's local admin as the
# operator's own identity — the bundled IdP's first-human email with --admin,
# never admin@local on these shapes — and writes GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL=true
# so the first IdP login with that exact email adopts the row: one account
# is both the SSO identity and the break-glass local login. Phase 2
# re-checks the row and re-seeds it when the database lost it (a recreated
# volume wipes the users table while SSO would provision a fresh non-admin
# row on the next sign-in — the lockout an operator hit live). Shapes with
# no operator email keep the admin@local creation.
#
# Nothing mints the chat a key. Cerea boots anonymously against Pystino — its
# model catalogue fetch reads the gateway's public `GET /v1/models` (ADR
# 0081), and every real inference call after that carries the signed-in
# person's own access token (`USE_USER_TOKEN=true`, ADR 0040). An earlier
# installer minted a spend-capable `gwk_` key at the end of phase 1 for the
# sole purpose of that boot fetch; that step is gone, not merely optional.
#
# Three rules this file never breaks, each learned the hard way upstream:
#
# - It never sources deploy/.env into its own shell. Compose prefers the
#   shell environment over --env-file, so a sourced variable silently wins
#   over the file. Values live in shell variables that are never exported,
#   and compose children additionally run with every managed variable
#   scrubbed from their environment (see build_scrub) — which is also what
#   keeps a stray `OPENAI_API_KEY` in the operator's own shell from reaching
#   the stack. The file travels only via --env-file.
# - It never guesses a repository location. CHAT_REPO defaults to the checkout
#   this script runs from and is always shown for confirmation; the Pystino
#   path is asked for, validated, or cloned on request.
# - It never regenerates a secret silently. On resume, existing values are
#   kept — rotating GATEWAY_SECRET_KEY would destroy every stored provider
#   credential, and rotating the placeholder key would re-label every
#   transcript entity.
#
# The IdP signing key is a file, not an env value (Pystino commit 6b7b6d1):
# the installer generates a P-256 PEM at <pystino>/deploy/idp-signing-key.pem
# (chmod 600) and writes two single-line variables — IDP_SIGNING_KEY_HOST_PATH
# (the host path, which the base compose file mounts read-only into the
# gateway) and GATEWAY_IDP__SIGNING_KEY_FILE (the path inside the container).
# It never writes GATEWAY_IDP__SIGNING_KEY: an inline key and a key file
# together are refused at gateway startup, and every value in deploy/.env
# stays single-line, which is what makes the file round-trippable in bash at
# all.

set -euo pipefail

CEREA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERNAL_FORK="https://github.com/paoloviviani/Pystino.git"

# Switch and decision state (DRY_RUN, PHASE2_ONLY, CLI_PYSTINO, BUILD,
# NON_INTERACTIVE, FLAG_*, PENDING, ...) is owned by lib/flags.sh.
# BUILD / BUILD_FLAG live in lib/compose-flags.sh. Enterprise sign-in shape:
# house (gateway's own issuer, no external provider), external (one provider
# for gateway console and chat), custom (each side configured separately, or
# left for later). Set during collect, read from the metadata block on
# --phase2 (the infer fallback for block-less .env files).
AUTH_MODE=""

# ------------------------------------------------------------------ #
# sourced libraries: the pure, testable core                          #
# ------------------------------------------------------------------ #
# term.sh          terminal kit: colors, title/note/warn, fail
# values.sh        profiles, value store, validation, pure collection logic,
#                  the component vocabulary, the metadata shape reader
# envfile.sh       deploy/.env parsing and templating, the metadata block
# compose-flags.sh docker compose argument assembly
# flags.sh         the command-line decision surface (flags, pending
#                  --set answers, missing-decision bookkeeping)
# Each carries its own surface header and is unit-tested under installer/tests/.

. "$CEREA_ROOT/installer/lib/term.sh"
. "$CEREA_ROOT/installer/lib/values.sh"
. "$CEREA_ROOT/installer/lib/envfile.sh"
. "$CEREA_ROOT/installer/lib/compose-flags.sh"
. "$CEREA_ROOT/installer/lib/flags.sh"

trap 'printf "\nAborted. Nothing was changed beyond what the transcript above says.\n" >&2' INT

input_ended() {
	fail "input ended unexpectedly. Re-run interactively; nothing was written unless the transcript above says so."
}

# One line of input, from a TTY or a pipe. On a TTY this is plain read; off
# one, the answer is echoed back for transcript fidelity (a piped answer is
# otherwise invisible in the transcript). EOF with nothing buffered is fatal,
# never a silent exit 0 mid-flow — mirrors the node installer's rule.
ask() { # ask <prompt> [default] -> REPLY_VAL
	if [ "$NON_INTERACTIVE" = "1" ]; then
		# The backstop: every decision site is converted to take its answer
		# from a flag, --set, a safe default, or the missing-decision list.
		# Reaching a bare ask in non-interactive mode is a bug in that
		# coverage — fail with the prompt named rather than hang on stdin.
		fail "non-interactive run reached an unanswered prompt: \"$1\". Supply it with a flag or --set, or re-run interactively."
	fi
	local prompt="$1" def="${2-}" raw="" suffix=""
	[ -n "$def" ] && suffix=" [$def]"
	printf '%s%s: ' "$prompt" "$suffix"
	IFS= read -r raw || { [ -n "$raw" ] || input_ended; }
	if [ ! -t 0 ]; then printf '%s\n' "$raw"; fi
	trim "$raw"
	if [ -z "$REPLY_VAL" ]; then REPLY_VAL="$def"; fi
}

ask_required() { # ask_required <prompt> [default] -> REPLY_VAL
	local prompt="$1" def="${2-}"
	while :; do
		ask "$prompt" "$def"
		if [ -n "$REPLY_VAL" ]; then return; fi
		printf '%sA value is required here.%s\n' "$YELLOW" "$R"
	done
}

# A prompt that does not echo, for secrets the operator pastes. On a TTY this
# uses `read -s`; off one (a piped answer) it falls back to a visible prompt
# with a warning, the same accommodation the node installer made.
ask_hidden() { # ask_hidden <prompt> -> REPLY_VAL
	local raw=""
	if [ -t 0 ]; then
		printf '%s: ' "$1"
		IFS= read -rs raw || { [ -n "$raw" ] || input_ended; }
		printf '\n'
	else
		warn "stdin is not a TTY — the value will echo."
		printf '%s: ' "$1"
		IFS= read -r raw || { [ -n "$raw" ] || input_ended; }
		printf '%s\n' "$raw"
	fi
	trim "$raw"
}

confirm() { # confirm <question> [default-yes=1] -> CONFIRM_VAL
	local question="$1" def="${2:-1}" hint answer
	if [ "$NON_INTERACTIVE" = "1" ]; then
		# A confirmation's default is the answer Enter would give; a
		# non-interactive run takes it without reading stdin. Decisions that
		# must not silently default are keyed on their VALUES key (see the
		# pending-keyed confirms in collect_values), not routed through here.
		CONFIRM_VAL="$def"
		return
	fi
	if [ "$def" = "1" ]; then hint="Y/n"; else hint="y/N"; fi
	while :; do
		ask "$question ($hint)"
		answer="${REPLY_VAL,,}"
		if [ -z "$answer" ]; then CONFIRM_VAL="$def"; return; fi
		case "$answer" in
			y | yes) CONFIRM_VAL=1; return ;;
			n | no) CONFIRM_VAL=0; return ;;
			*) printf '%sAnswer y or n.%s\n' "$YELLOW" "$R" ;;
		esac
	done
}

# ------------------------------------------------------------------ #
# the flag/pending answer layer                                       #
# ------------------------------------------------------------------ #
# Decision sites ask through these helpers instead of bare ask/ask_hidden.
# A value supplied by --set (PENDING in lib/flags.sh) is consumed at the
# very site it answers — so the site's own post-processing (slash trims,
# /v1 suffixes, URL checks) and the final validate_values see exactly what
# a typed answer would have met. A non-interactive run takes the prompt's
# own default where the prompt has one (what Enter would do) and records
# the decision as missing where it does not; the accumulated list is failed
# on once, loudly. Interactive runs behave byte-identically to before.

ASK_MISS=0 # set by the helpers when they recorded a missing decision

take_answer() { # take_answer <key> <prompt> [default] -> REPLY_VAL (no set_value)
	ASK_MISS=0
	local key="$1" prompt="$2" def="${3-}"
	if pending_has "$key"; then
		pending_take "$key"
		note "$prompt: $REPLY_VAL (--set)"
		return
	fi
	if [ "$NON_INTERACTIVE" = "1" ]; then
		if [ -n "$def" ]; then
			REPLY_VAL="$def"
			note "$prompt: $REPLY_VAL (default)"
		else
			record_missing "$key" "$prompt (supply with --set $key=VALUE)"
			REPLY_VAL=""
			ASK_MISS=1
		fi
		return
	fi
	ask "$prompt" "$def"
}

take_answer_opt() { # like take_answer, but an absent answer means "empty" —
	# for prompts whose empty answer is a legitimate choice the interactive
	# default already carries (skip-this, public client). Never records a
	# missing decision.
	ASK_MISS=0
	local key="$1" prompt="$2"
	if pending_has "$key"; then
		pending_take "$key"
		note "$prompt: $REPLY_VAL (--set)"
		return
	fi
	if [ "$NON_INTERACTIVE" = "1" ]; then
		REPLY_VAL=""
		note "$prompt: (empty — the prompt's skip answer)"
		return
	fi
	ask "$prompt"
}

take_answer_required() { # like take_answer; interactive answers must be non-empty
	ASK_MISS=0
	local key="$1" prompt="$2"
	if pending_has "$key"; then
		pending_take "$key"
		note "$prompt: $REPLY_VAL (--set)"
		return
	fi
	if [ "$NON_INTERACTIVE" = "1" ]; then
		record_missing "$key" "$prompt (supply with --set $key=VALUE)"
		REPLY_VAL=""
		ASK_MISS=1
		return
	fi
	while :; do
		ask "$prompt"
		if [ -n "$REPLY_VAL" ]; then return; fi
		printf '%sA value is required here.%s\n' "$YELLOW" "$R"
	done
}

ask_value() { # ask_value <key> <prompt> [default] -> VALUES[key]
	take_answer "$1" "$2" "${3-}"
	set_value "$1" "$REPLY_VAL"
}

ask_value_opt() { # ask_value_opt <key> <prompt> -> VALUES[key] (empty allowed)
	take_answer_opt "$1" "$2"
	set_value "$1" "$REPLY_VAL"
}

ask_value_required() { # ask_value_required <key> <prompt> -> VALUES[key]
	take_answer_required "$1" "$2"
	set_value "$1" "$REPLY_VAL"
}

ask_secret_value() { # ask_secret_value <key> <prompt> -> VALUES[key]; the value
	# is never echoed (a --set secret is visible in ps anyway — the note only
	# says where it came from).
	ASK_MISS=0
	local key="$1" prompt="$2"
	if pending_has "$key"; then
		pending_take "$key"
		note "$prompt: (--set, value hidden)"
		set_value "$key" "$REPLY_VAL"
		return
	fi
	if [ "$NON_INTERACTIVE" = "1" ]; then
		record_missing "$key" "$prompt (supply with --set $key=VALUE)"
		REPLY_VAL=""
		ASK_MISS=1
		return
	fi
	ask_hidden "$prompt"
	set_value "$key" "$REPLY_VAL"
}

ask_secret_opt() { # ask_secret_opt <key> <prompt> — like ask_secret_value but
	# an absent answer means an explicitly empty value (public client).
	ASK_MISS=0
	local key="$1" prompt="$2"
	if pending_has "$key"; then
		pending_take "$key"
		note "$prompt: (--set, value hidden)"
		set_value "$key" "$REPLY_VAL"
		return
	fi
	if [ "$NON_INTERACTIVE" = "1" ]; then
		REPLY_VAL=""
		set_value "$key" "$REPLY_VAL"
		return
	fi
	ask_hidden "$prompt"
	set_value "$key" "$REPLY_VAL"
}

# usage() lives in lib/flags.sh next to parse_install_flags — the flag
# surface and its documentation must not drift apart.

# ------------------------------------------------------------------ #
# secrets                                                             #
# ------------------------------------------------------------------ #

# The IdP signing key lives at <pystino>/deploy/idp-signing-key.pem — the
# path deploy/.env.example documents for the same variable, in the checkout
# whose compose file mounts it. A PEM is several lines, so it must never be
# an env value: GATEWAY_IDP__SIGNING_KEY_FILE names it inside the container
# and IDP_SIGNING_KEY_HOST_PATH on the host (see the header).
gen_signing_key() { # gen_signing_key <host-path>
	openssl ecparam -genkey -name prime256v1 -out "$1" || fail "openssl could not generate the IdP signing key."
	chmod 600 "$1"
}

# ------------------------------------------------------------------ #
# checkout resolution                                                 #
# ------------------------------------------------------------------ #

validate_pystino_root() { # validate_pystino_root <dir> -> MISSING_LIST
	local dir="$1" rel
	MISSING_LIST=""
	for rel in deploy/compose/docker-compose.yml deploy/profiles/overlays.sh deploy/profiles/homelab.env; do
		[ -e "$dir/$rel" ] || MISSING_LIST="${MISSING_LIST:+$MISSING_LIST, }$rel"
	done
}

check_docker() {
	docker compose version >/dev/null 2>&1 ||
		fail "docker compose is not available. Install Docker (with the compose plugin) and re-run."
}

resolve_pystino_root() { # -> PYSTINO_ROOT
	if [ -n "$CLI_PYSTINO" ]; then
		local try="${CLI_PYSTINO/#\~/$HOME}"
		if [ ! -e "$try" ]; then
			if [ "$NON_INTERACTIVE" = "1" ]; then
				fail "No such directory: $try. Non-interactive runs never clone — clone it (or point --pystino at an existing checkout) and re-run."
			fi
			confirm "No such directory: $try. Clone the internal fork there?" 1
			if [ "$CONFIRM_VAL" = "0" ]; then fail "no such directory: $try"; fi
			ask "Repository URL" "$INTERNAL_FORK"
			echo "Cloning $REPLY_VAL ..."
			git clone "$REPLY_VAL" "$try" ||
				fail "Clone failed. Check the URL and your access."
		fi
		PYSTINO_ROOT="$(cd "$try" 2>/dev/null && pwd)" ||
			fail "no such directory: $try"
		validate_pystino_root "$PYSTINO_ROOT"
		if [ -n "$MISSING_LIST" ]; then
			fail "not a Pystino checkout: $PYSTINO_ROOT (missing $MISSING_LIST)"
		fi
		return
	fi
	title "Pystino checkout"
	note "The compose files and deploy/.env live in Pystino; this installer writes into that checkout."
	# Best guess first: a Pystino beside this checkout covers the standard
	# workspace layout, so the common case is one Enter.
	local guess=""
	for guess in "$CEREA_ROOT/../Pystino" "$HOME/workspace/Pystino"; do
		guess="$(cd "$guess" 2>/dev/null && pwd)" || guess=""
		if [ -n "$guess" ]; then
			validate_pystino_root "$guess"
			if [ -z "$MISSING_LIST" ]; then break; else guess=""; fi
		fi
	done
	if [ "$NON_INTERACTIVE" = "1" ]; then
		# No --pystino and no prompts: the first valid best guess is the
		# answer Enter would produce on the default menu; without one there
		# is no decision to default to.
		if [ -n "$guess" ]; then
			PYSTINO_ROOT="$guess"
			note "Pystino checkout: $PYSTINO_ROOT (best guess)"
			return
		fi
		fail "no Pystino checkout found beside $CEREA_ROOT or under $HOME/workspace — pass --pystino <path>."
	fi
	while :; do
		printf '\n  %s1)%s Use an existing checkout\n' "$CYAN" "$R"
		printf '  %s2)%s Clone it now\n' "$CYAN" "$R"
		ask "Point at an existing Pystino checkout, or clone it? [1-2]" "1"
		case "$REPLY_VAL" in
		2)
			local dest="" url="" resolved
			# The clone needs a destination even when no existing checkout
			# produced a guess: an empty default makes Enter submit nothing,
			# and the bracket hint prints as '[]' — a prompt that assumes
			# the operator knows something the installer never said. Fall
			# back to a name beside this checkout, the one place a clone is
			# guaranteed writable (the Cerea checkout's parent already is).
			local clone_default="$guess"
			[ -n "$clone_default" ] || clone_default="$CEREA_ROOT/../Pystino"
			ask "Directory to clone into" "$clone_default"
			dest="$REPLY_VAL"
			dest="${dest/#\~/$HOME}"
			if [ -e "$dest" ]; then
				resolved="$(cd "$dest" 2>/dev/null && pwd)" || resolved=""
				if [ -n "$resolved" ]; then
					validate_pystino_root "$resolved"
					if [ -z "$MISSING_LIST" ]; then
						case "$resolved" in
							*" "*)
								fail "The Pystino path contains a space, which the overlay derivation cannot quote. Move the checkout and re-run."
								;;
						esac
						PYSTINO_ROOT="$resolved"
						note "Already a Pystino checkout — using it in place."
						return
					fi
					warn "That directory is missing $MISSING_LIST — not a usable checkout."
					continue
				fi
				warn "Exists but not a directory: $dest"
				continue
			fi
			ask "Repository URL" "$INTERNAL_FORK"
			url="$REPLY_VAL"
			echo "Cloning $url ..."
			if ! git clone "$url" "$dest"; then
				warn "Clone failed. Check the URL and your access, then try again."
				continue
			fi
			resolved="$(cd "$dest" && pwd)"
			validate_pystino_root "$resolved"
			if [ -n "$MISSING_LIST" ]; then
				warn "The clone is missing $MISSING_LIST — wrong repository?"
				continue
			fi
			case "$resolved" in
				*" "*)
					fail "The Pystino path contains a space, which the overlay derivation cannot quote. Move the checkout and re-run."
					;;
			esac
			PYSTINO_ROOT="$resolved"
			return
			;;
		1)
			local answer resolved
			ask "Path to the Pystino checkout" "$guess"
			answer="$REPLY_VAL"
			answer="${answer/#\~/$HOME}"
			resolved="$(cd "$answer" 2>/dev/null && pwd)" || resolved=""
			if [ -z "$resolved" ]; then
				warn "No such directory: $answer. Pick another, or choose clone above."
				continue
			fi
			validate_pystino_root "$resolved"
			if [ -n "$MISSING_LIST" ]; then
				warn "That directory is missing $MISSING_LIST. Pick another, or clone the fork."
				continue
			fi
			case "$resolved" in
				*" "*)
					fail "The Pystino path contains a space, which the overlay derivation cannot quote. Move the checkout and re-run."
					;;
			esac
			PYSTINO_ROOT="$resolved"
			return
			;;
		*)
			printf '%sEnter 1 or 2.%s\n' "$YELLOW" "$R"
			;;
		esac
	done
}

resolve_chat_repo() { # -> CHAT_REPO_VAL
	local answer resolved
	if [ -n "$FLAG_CHAT_REPO" ]; then
		answer="${FLAG_CHAT_REPO/#\~/$HOME}"
		resolved="$(cd "$answer" 2>/dev/null && pwd)" || resolved=""
		if [ -z "$resolved" ] || [ ! -f "$resolved/Dockerfile" ]; then
			fail "--chat-repo $FLAG_CHAT_REPO is not a Cerea checkout (no Dockerfile there)."
		fi
		case "$resolved" in
			*" "*) fail "The --chat-repo path contains a space, which the compose derivation cannot quote. Move the checkout and re-run." ;;
		esac
		CHAT_REPO_VAL="$resolved"
		note "Chat checkout (--chat-repo): $CHAT_REPO_VAL"
		return
	fi
	if [ "$NON_INTERACTIVE" = "1" ]; then
		# The prompt's default is this checkout; taking it unasked is what
		# Enter would do, and the validation below is the loop's own.
		resolved="$(cd "$CEREA_ROOT" 2>/dev/null && pwd)" || resolved=""
		if [ -z "$resolved" ] || [ ! -f "$resolved/Dockerfile" ]; then
			fail "the Cerea checkout $CEREA_ROOT has no Dockerfile — pass --chat-repo <path>."
		fi
		case "$resolved" in
			*" "*) fail "The Cerea path contains a space, which the compose derivation cannot quote. Move the checkout and re-run." ;;
		esac
		CHAT_REPO_VAL="$resolved"
		note "Chat checkout: $CHAT_REPO_VAL (default)"
		return
	fi
	title "Chat checkout"
	note "The chat image builds from a local Cerea checkout — this one, unless you say otherwise."
	while :; do
		ask "Path to the Cerea checkout" "$CEREA_ROOT"
		local answer="$REPLY_VAL" resolved
		answer="${answer/#\~/$HOME}"
		resolved="$(cd "$answer" 2>/dev/null && pwd)" || resolved=""
		if [ -z "$resolved" ] || [ ! -f "$resolved/Dockerfile" ]; then
			warn "No Dockerfile there — that is not a Cerea checkout. Try again."
			continue
		fi
		case "$resolved" in
			*" "*)
				fail "The Cerea path contains a space, which the compose derivation cannot quote. Move the checkout and re-run."
				;;
		esac
		CHAT_REPO_VAL="$resolved"
		return
	done
}

# ------------------------------------------------------------------ #
# the interactive flow                                                #
# ------------------------------------------------------------------ #

choose_profile() { # -> PROFILE
	if [ -n "$FLAG_PROFILE" ]; then
		PROFILE="$FLAG_PROFILE" # validated at parse time
		note "Profile (--profile): $PROFILE"
		return
	fi
	title "Deployment profile"
	while :; do
		printf '\n%s\n' "Three full stacks (gateway + chat), two chat-only deployments against a backend elsewhere. Exposure (edge or proxy) is chosen separately afterwards."
		local i=1 key
		for key in "${PROFILE_KEYS[@]}"; do
			printf '  %s%d)%s %s%s — %s%s\n' "$CYAN" "$i" "$R" "$CYAN" "$key" "$R" "${P_BLURB[$key]}"
			note "     Footprint: ${P_FOOTPRINT[$key]}"
			i=$((i + 1))
		done
		ask "Choose [1-5]" "1"
		if [[ "$REPLY_VAL" =~ ^[1-5]$ ]]; then
			PROFILE="${PROFILE_KEYS[REPLY_VAL - 1]}"
			return
		fi
		printf '%sEnter a number between 1 and 5.%s\n' "$YELLOW" "$R"
	done
}

toggle_components() { # toggle_components <profile>  -> ST_* globals
	local profile="$1"
	case "$profile" in
		homelab)
			ST_REDACTION="off" ST_FETCH="direct" ST_METERING=0 ST_CODETOOL=1 ST_USAGE=0 ST_KNOWLEDGE=1 ST_MEMORY=1
			;;
		team)
			ST_REDACTION="pattern" ST_FETCH="direct" ST_METERING=1 ST_CODETOOL=1 ST_USAGE=1 ST_KNOWLEDGE=1 ST_MEMORY=1
			;;
		enterprise)
			ST_REDACTION="ner" ST_FETCH="playwright" ST_METERING=1 ST_CODETOOL=1 ST_USAGE=1 ST_KNOWLEDGE=1 ST_MEMORY=1
			;;
	esac
	if [ -n "$COMPONENTS_SPEC" ]; then
		components_to_shape "$COMPONENTS_SPEC"
		note "Components (--components): $COMPONENTS_SPEC"
		return
	fi
	if [ "$NON_INTERACTIVE" = "1" ]; then
		note "Components: $profile defaults (no --components given)"
		return
	fi
	title "Components — $profile defaults, toggle by number"
	local redaction_label done_=0
	while :; do
		case "$ST_REDACTION" in
			off) redaction_label="off" ;;
			pattern) redaction_label="pattern-only" ;;
			ner) redaction_label="NER" ;;
		esac
		local metering_label="off" usage_label="hidden"
		[ "$ST_METERING" = "1" ] && metering_label="on"
		[ "$ST_USAGE" = "1" ] && usage_label="shown"
		local code_label="off" knowledge_label="off" memory_label="off" fetch_label="$ST_FETCH"
		[ "$ST_CODETOOL" = "1" ] && code_label="on"
		[ "$ST_KNOWLEDGE" = "1" ] && knowledge_label="on"
		[ "$ST_MEMORY" = "1" ] && memory_label="on"
		printf '\nCurrent selection:\n'
		printf '  %s1)%s Redaction: %s\n' "$CYAN" "$R" "$redaction_label"
		note "     off: nothing (+0) · pattern: +~300 MB RSS, +~1.9 GB image (pattern-only redaction + local extractor) · NER: +~750 MB RSS (NER redaction) — needs a rebuild to change later (SPACY_MODELS is a build argument)"
		printf '  %s2)%s URL fetching: %s\n' "$CYAN" "$R" "$fetch_label"
		note "     direct: plain HTTPS, JS pages arrive empty · playwright: rendered pages, +~175 MB RSS + 3.45 GB image (unauthenticated remote code execution by design — never published)"
		printf '  %s3)%s Metering (ledger + quotas): %s\n' "$CYAN" "$R" "$metering_label"
		note "     off is the ADR 0065 passthrough shape: no usage_records rows, ever. Quotas cannot stay on without it — the combination is refused at startup, so they toggle as one"
		printf '  %s4)%s Usage & billing tab: %s\n' "$CYAN" "$R" "$usage_label"
		note "     defaults to shown (there is a ledger to read) when metering is on, hidden (no ledger, nothing to read) otherwise — independently toggleable"
		printf '  %s5)%s Code tool (browser Pyodide sandbox): %s\n' "$CYAN" "$R" "$code_label"
		note "     free: runs in the signed-in person's own browser, never on this box"
		printf '  %s6)%s Knowledge pipeline: %s\n' "$CYAN" "$R" "$knowledge_label"
		note "     free: its Postgres is a second database on the gateway's instance, not a container — off hides the surface instead of erroring"
		printf '  %s7)%s User memory: %s\n' "$CYAN" "$R" "$memory_label"
		note "     free: a handful of short facts per person in Mongo — and each person still has to opt in, so leaving it on stores nothing by itself"
		printf '  %s8)%s Done — continue with this selection\n' "$CYAN" "$R"
		ask "Toggle [1-8]" "8"
		if [ "$REPLY_VAL" = "8" ]; then return; fi
		if ! [[ "$REPLY_VAL" =~ ^[1-7]$ ]]; then
			printf '%sEnter a number between 1 and 8.%s\n' "$YELLOW" "$R"
			continue
		fi
		case "$REPLY_VAL" in
			1)
				case "$ST_REDACTION" in
					off) ST_REDACTION="pattern" ;;
					pattern) ST_REDACTION="ner" ;;
					ner) ST_REDACTION="off" ;;
				esac
				;;
			2)
				if [ "$ST_FETCH" = "direct" ]; then ST_FETCH="playwright"; else ST_FETCH="direct"; fi
				;;
			3)
				if [ "$ST_METERING" = "1" ]; then ST_METERING=0; else ST_METERING=1; fi
				if [ "$ST_METERING" = "0" ] && [ "$ST_USAGE" = "1" ]; then
					note "Metering off with the Usage tab shown is pointless (nothing to read) — hiding the tab too. Re-enable it above if you disagree."
					ST_USAGE=0
				fi
				;;
			4) if [ "$ST_USAGE" = "1" ]; then ST_USAGE=0; else ST_USAGE=1; fi ;;
			5) if [ "$ST_CODETOOL" = "1" ]; then ST_CODETOOL=0; else ST_CODETOOL=1; fi ;;
			6) if [ "$ST_KNOWLEDGE" = "1" ]; then ST_KNOWLEDGE=0; else ST_KNOWLEDGE=1; fi ;;
			7) if [ "$ST_MEMORY" = "1" ]; then ST_MEMORY=0; else ST_MEMORY=1; fi ;;
		esac
	done
}

choose_exposure() { # -> EXPOSURE
	if [ -n "$FLAG_EXPOSURE" ]; then
		EXPOSURE="$FLAG_EXPOSURE" # validated at parse time
		note "Exposure (--exposure): $EXPOSURE"
		return
	fi
	title "Exposure"
	note "The chat publishes no port: loopback alone leaves it unreachable, so it is not offered."
	while :; do
		printf '\n%s\n' "How does a browser reach this deployment?"
		printf '  %s1)%s edge — NetBird (or equivalent) edge terminates TLS upstream\n' "$CYAN" "$R"
		note "     plain HTTP on loopback here; the edge's reverse proxy forwards to this box"
		printf '  %s2)%s proxy — Caddy terminates TLS on this box\n' "$CYAN" "$R"
		note "     self-signed on an IP, or automatic Let's Encrypt on a name (needs ports 80+443 from the internet)"
		ask "Choose [1-2]" "1"
		case "$REPLY_VAL" in
			1) EXPOSURE="edge"; return ;;
			2) EXPOSURE="proxy"; return ;;
			*) printf '%sEnter a number between 1 and 2.%s\n' "$YELLOW" "$R" ;;
		esac
	done
}

# The audience prompt, shared by the external and custom paths: leaving it
# empty is valid (API keys stay the /v1 credential) but breaks the chat's
# per-user calls, so an empty answer costs a confirm, defaulting to no.
# The value itself is defined provider-side — this only repeats the string:
# the per-provider shapes are printed with the question because nobody
# remembers where their IdP hides the audience.
ask_access_token_audience() {
	note "What your provider puts in the access token's aud claim for the chat's client:"
	note "  Keycloak: the client ID, or your audience-mapper value · Entra ID: the Application ID URI (api://…) · Auth0: the API identifier"
	note "  GitLab and providers with no audience concept: leave empty (/v1 stays on API keys) · anything else: decode one token (jwt.io) and read aud"
	if pending_has GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE; then
		# An explicitly empty --set value is a deliberate "no audience"
		# (a key-driven deployment); the interactive confirm's no-default
		# cannot run here, so the empty value is accepted with the warning.
		pending_take GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE
		note "Access-token audience for /v1: ${REPLY_VAL:-(empty)} (--set)"
		set_value GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE "$REPLY_VAL"
		if [ -z "$REPLY_VAL" ]; then
			warn "No audience means API keys only on /v1: the chat's per-user calls (USE_USER_TOKEN) will fail. This is only correct for a key-driven deployment."
		fi
		return
	fi
	if [ "$NON_INTERACTIVE" = "1" ]; then
		record_missing "GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE" "the access-token audience for /v1 (supply with --set GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE=VALUE; an explicitly empty value means key-driven /v1)"
		set_value GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE ""
		return
	fi
	ask "Access-token audience for /v1"
	set_value GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE "$REPLY_VAL"
	if [ -z "$REPLY_VAL" ]; then
		warn "No audience means API keys only on /v1: the chat's per-user calls (USE_USER_TOKEN) will fail. This is only correct for a key-driven deployment."
		confirm "Proceed without an audience?" 0
		if [ "$CONFIRM_VAL" = "0" ]; then
			ask_required "Access-token audience for /v1"
			set_value GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE "$REPLY_VAL"
		fi
	fi
}

# Bundled providers (Authelia/Keycloak), shared by team, enterprise and the
# satellite-local shape: the audience is fixed by the overlays (`pystino-api`
# on both clients, implicitly granted), so it is written, never prompted;
# the issuer is the public origin plus the provider's prefix. The house IdP
# stays off on these shapes — the `[]` fallback in collect covers the client
# registry. The first-human password is asked, never minted (shell variables
# IDP_ADMIN_* / IDP_FIRST_PASSWORD, never VALUES, so it never lands in
# deploy/.env); everything generatable is minted here.
ask_bundled_credentials() { # ask_bundled_credentials <authelia|keycloak>
	local kind="$1" pw=""
	if [ "$kind" = "authelia" ]; then
		note "The first human in the local directory (signs in daily — memorable beats random here)."
		if [ "$NON_INTERACTIVE" = "1" ]; then
			IDP_ADMIN_USER="admin"
			note "Local admin login name: admin (default)"
		else
			ask "Local admin login name" "admin"
			IDP_ADMIN_USER="$REPLY_VAL"
		fi
		if [ -n "$FLAG_ADMIN_EMAIL" ]; then
			IDP_ADMIN_EMAIL="$FLAG_ADMIN_EMAIL"
			FLAG_ADMIN_EMAIL_USED=1
			note "Local admin email (must look real — the chat refuses .local): $IDP_ADMIN_EMAIL (--admin-email)"
		elif [ "$NON_INTERACTIVE" = "1" ]; then
			IDP_ADMIN_EMAIL=""
			record_missing "IDP_ADMIN_EMAIL" "the bundled Authelia's first human's email (supply with --admin-email EMAIL)"
		else
			ask_required "Local admin email (must look real — the chat refuses .local)"
			IDP_ADMIN_EMAIL="$REPLY_VAL"
		fi
		if [ "$NON_INTERACTIVE" = "1" ]; then
			IDP_ADMIN_NAME="$IDP_ADMIN_USER"
			note "Display name: $IDP_ADMIN_NAME (default)"
		else
			ask "Display name" "$IDP_ADMIN_USER"
			IDP_ADMIN_NAME="$REPLY_VAL"
		fi
		if [ "$NON_INTERACTIVE" = "1" ]; then
			# The first-human password never lands in deploy/.env, so --set
			# cannot carry it — the environment is the only non-interactive
			# channel (snapshot taken at flag-parse time).
			pw="$ENV_IDP_ADMIN_PASSWORD"
			if [ -n "$pw" ]; then
				note "Local admin password (typed daily): (from the environment, hidden)"
			else
				record_missing "IDP_ADMIN_PASSWORD" "the bundled Authelia's first human's password (export IDP_ADMIN_PASSWORD)"
			fi
		else
			ask_hidden "Local admin password (typed daily)"
			pw="$REPLY_VAL"
		fi
	else
		note "The first human is owner@example.org (fixed by the realm template); only its password is chosen here — memorable, typed daily."
		if [ "$NON_INTERACTIVE" = "1" ]; then
			pw="$ENV_IDP_FIRST_PASSWORD"
			if [ -n "$pw" ]; then
				note "First-user password: (from the environment, hidden)"
			else
				record_missing "IDP_FIRST_PASSWORD" "the bundled Keycloak's first user's password (export IDP_FIRST_PASSWORD)"
			fi
		else
			ask_hidden "First-user password"
			pw="$REPLY_VAL"
		fi
	fi
	while [ -z "$pw" ] && [ "$NON_INTERACTIVE" != "1" ]; do
		printf '%sNobody can sign in without it.%s\n' "$YELLOW" "$R"
		ask_hidden "Password"
		pw="$REPLY_VAL"
	done
	case "$pw" in
		*$'\n'* | *$'\r'*)
			fail "the password must be a single line."
			;;
	esac
	if [ "$kind" = "authelia" ]; then
		IDP_ADMIN_PASSWORD="$pw"
	else
		IDP_FIRST_PASSWORD="$pw"
	fi
}

# Fresh installs generate everything generatable; the asked-for values come
# after, so the operator meets each one while the consequence is on screen.
collect_values() { # collect_values <profile>
	local profile="$1" standalone=0
	is_standalone_profile "$profile" && standalone=1
	IDP_BUNDLED=""
	IDP_ADMIN_USER=""; IDP_ADMIN_EMAIL=""; IDP_ADMIN_NAME=""; IDP_ADMIN_PASSWORD=""; IDP_FIRST_PASSWORD=""

	if [ "$profile" = "team" ]; then
		title "Sign-in"
		note "House IdP by default (same as homelab); or deploy a bundled provider alongside the gateway — a real OIDC server with password login, no external directory needed. The audience (pystino-api) is automatic on both."
		printf '  %s1)%s House IdP — no external provider\n' "$CYAN" "$R"
		printf '  %s2)%s Bundled Authelia — lean (tens of MB), password login today, TOTP/WebAuthn path later\n' "$CYAN" "$R"
		printf '  %s3)%s Bundled Keycloak — full directory (~730 MB RSS, ~80 s first boot)\n' "$CYAN" "$R"
		if [ -n "$FLAG_IDP" ]; then
			case "$FLAG_IDP" in
				house) REPLY_VAL="1" ;;
				authelia) REPLY_VAL="2" ;;
				keycloak) REPLY_VAL="3" ;;
				*) fail "--idp $FLAG_IDP is not a team sign-in shape (house|authelia|keycloak)." ;;
			esac
			note "Sign-in (--idp): $FLAG_IDP"
		elif [ "$NON_INTERACTIVE" = "1" ]; then
			REPLY_VAL="1"
			note "Sign-in: house (default)"
		else
			ask "Choose [1-3]" "1"
		fi
		case "$REPLY_VAL" in
			2)
				IDP_BUNDLED="authelia"
				ask_bundled_credentials authelia
				;;
			3)
				IDP_BUNDLED="keycloak"
				ask_bundled_credentials keycloak
				;;
		esac
	fi

	title "Secrets — generated locally, never fetched"
	local generated_notes="" durability

	token_url_safe 32
	set_value POSTGRES_PASSWORD "$TOKEN_VAL"
	generated_notes="POSTGRES_PASSWORD"
	if [ "$standalone" = "1" ]; then
		# Parse-only gateway secrets (no gateway runs on this profile): the
		# base compose file refuses to interpolate without them, and even
		# `docker compose logs` reads the whole file. Generated rather than
		# dummy so that a gateway started by mistake against this .env is not
		# running on guessable credentials.
		token_url_safe 48
		set_value GATEWAY_SECRET_KEY "$TOKEN_VAL"
		token_url_safe 48
		set_value GATEWAY_SESSION_SECRET "$TOKEN_VAL"
		generated_notes="$generated_notes, GATEWAY_SECRET_KEY (parse-only), GATEWAY_SESSION_SECRET (parse-only)"
	else
		token_url_safe 48
		set_value GATEWAY_SECRET_KEY "$TOKEN_VAL"
		generated_notes="$generated_notes, GATEWAY_SECRET_KEY"
		durability="Encrypts provider credentials at rest. Back it up WITH the database — losing every value means re-entering each provider credential by hand, and rotating it orphans everything stored under the old one."
		printf '\n%sDurability warning — GATEWAY_SECRET_KEY:%s\n%s\n' "$YELLOW" "$R" "$durability"
		token_url_safe 48
		set_value GATEWAY_SESSION_SECRET "$TOKEN_VAL"
		generated_notes="$generated_notes, GATEWAY_SESSION_SECRET"
		if [ "$REDACTION_STATE" != "off" ]; then
			token_url_safe 32
			set_value REDACTION_PLACEHOLDER_KEY "$TOKEN_VAL"
			durability="Must stay stable for as long as the transcripts it labelled are kept: rotating it re-labels every entity, so old placeholders stop matching."
			printf '\n%sDurability warning — REDACTION_PLACEHOLDER_KEY:%s\n%s\n' "$YELLOW" "$R" "$durability"
			generated_notes="$generated_notes, REDACTION_PLACEHOLDER_KEY"
		fi
		if [ "$profile" != "enterprise" ] && [ -z "$IDP_BUNDLED" ]; then
			# The signing key: a PEM at <pystino>/deploy/idp-signing-key.pem,
			# written once the operator confirms the write (a dry run keeps a
			# throwaway sample beside its temp .env). Two single-line names,
			# never an inline PEM. Bundled shapes skip this: the house IdP
			# stays off, so there is nothing to sign with.
			token_url_safe 48
			set_value GATEWAY_IDP__INTERNAL_TOKEN "$TOKEN_VAL"
			generated_notes="$generated_notes, GATEWAY_IDP__INTERNAL_TOKEN"
		fi
		generated_notes="$generated_notes, CHAT_IDP_CLIENT_SECRET, CHAT_SECRET_KEY"
	fi
	token_url_safe 48
	set_value CHAT_IDP_CLIENT_SECRET "$TOKEN_VAL"
	token_url_safe 48
	set_value CHAT_SECRET_KEY "$TOKEN_VAL"
	if [ -n "$generated_notes" ]; then
		note ""
		note "Generated: $generated_notes. Asked-for values below; nothing leaves this box."
	else
		note ""
		note "Resuming: all existing secrets kept, none regenerated."
	fi

	# Operator-supplied values.
	title "Deployment values"
	if [ "$standalone" = "1" ]; then
		# The chat's Postgres identity on this box: the only database role
		# this installer creates here. It matches the satellite/generic
		# fragments (POSTGRES_USER=chat); the gateway profiles never set
		# these keys and keep the fragment's gateway identity instead.
		set_value POSTGRES_USER "chat"
		set_value POSTGRES_DB "chat"
		if [ "$profile" = "satellite" ]; then
			title "Central Pystino"
			if pending_has OPENAI_BASE_URL; then
				# --set carries the FINAL value of the key it names (the
				# contract every other site follows); the prompt answer, by
				# contrast, is an origin that gains the /v1 suffix below.
				pending_take OPENAI_BASE_URL
				note "Central Pystino public origin: (--set) $REPLY_VAL"
				if ! is_absolute_url "$REPLY_VAL"; then
					fail "--set OPENAI_BASE_URL must be an absolute http(s) URL."
				fi
				set_value OPENAI_BASE_URL "$REPLY_VAL"
				central="$REPLY_VAL"
				case "$central" in */v1) central="${central%/v1}" ;; esac
			else
				take_answer_required OPENAI_BASE_URL "Central Pystino public origin (e.g. https://central.example)"
				local central="$REPLY_VAL"
				while [ "${central%/}" != "$central" ]; do central="${central%/}"; done
				if [ "$ASK_MISS" = "0" ] && ! is_absolute_url "$central"; then
					fail "The central origin must be an absolute http(s) URL."
				fi
				set_value OPENAI_BASE_URL "$central/v1"
			fi
			set_value FETCH_BACKEND "direct"
			title "Sign-in"
			note "Central (today's shape: the chat signs in against the central provider and every call carries the signer's own token) or a bundled Authelia on this box (sign-in stays local; inference bills one stored central key, because central's /v1 never accepts local tokens)."
			printf '  %s1)%s Central provider — per-user billing\n' "$CYAN" "$R"
			printf '  %s2)%s Bundled Authelia on this box — shared-key billing\n' "$CYAN" "$R"
			if [ -n "$FLAG_IDP" ]; then
				case "$FLAG_IDP" in
					central) REPLY_VAL="1" ;;
					authelia) REPLY_VAL="2" ;;
					*) fail "--idp $FLAG_IDP is not a satellite sign-in shape (central|authelia)." ;;
				esac
				note "Sign-in (--idp): $FLAG_IDP"
			elif [ "$NON_INTERACTIVE" = "1" ]; then
				REPLY_VAL="1"
				note "Sign-in: central (default)"
			else
				ask "Choose [1-2]" "1"
			fi
			if [ "$REPLY_VAL" = "2" ]; then
				IDP_BUNDLED="authelia"
				# Shared-key mode, enforced not defaulted: central's /v1
				# will never accept a local-Authelia token (wrong iss), so
				# this box bills one stored central key and never sends a
				# user token out. The Usage tab goes dark with it: it reads
				# central's ledger with the signer's own token, which no
				# longer exists here.
				ask_secret_value OPENAI_API_KEY "Central API key (pays for every call — mint one on central, paste it here)"
				while [ -z "$REPLY_VAL" ] && [ "$NON_INTERACTIVE" != "1" ]; do
					printf '%sShared-key mode has no other credential.%s\n' "$YELLOW" "$R"
					ask_hidden "Central API key"
				done
				set_value OPENAI_API_KEY "$REPLY_VAL"
				set_value USE_USER_TOKEN "false"
				set_value CHAT_USAGE_ENABLED "false"
				# A spare console secret: the generator requires one, and no
				# console runs on this profile. Stored, documented, unused.
				token_url_safe 48
				set_value IDP_CONSOLE_CLIENT_SECRET "$TOKEN_VAL"
				note "Spare console secret minted (IDP_CONSOLE_CLIENT_SECRET) — no console runs here; the local Authelia simply requires the client to exist."
				ask_bundled_credentials authelia
				note "Provider URL and chat client land on the public origin once it is known (below) — redirect is <origin>/chat/login/callback exactly."
			else
			# Nothing is minted and nothing is stored: the catalogue fetch
			# reads central's public GET /v1/models (ADR 0081), and every
			# real call carries the signed-in person's own token.
			unset 'VALUES[OPENAI_API_KEY]'
			set_value USE_USER_TOKEN "true"
			set_value CHAT_USAGE_ENABLED "true"
			title "Central identity provider"
			note "The chat is its own client at the central provider — register <this deployment's origin>/chat/login/callback there. All three are mandatory: without them nobody can sign in."
			ask_value CHAT_OIDC_PROVIDER_URL "OIDC issuer (defaults to the central origin)" "$central"
			ask_value_required CHAT_OIDC_CLIENT_ID "Chat client id at the provider" "cerea"
			ask_secret_value CHAT_OIDC_CLIENT_SECRET "Chat client secret"
			while [ -z "$REPLY_VAL" ] && [ "$NON_INTERACTIVE" != "1" ]; do
				printf '%sThe chat cannot sign anyone in without its client secret.%s\n' "$YELLOW" "$R"
				ask_hidden "Chat client secret"
			done
			set_value CHAT_OIDC_CLIENT_SECRET "$REPLY_VAL"
			ask_value CHAT_OIDC_SCOPES "Chat OIDC scopes" "openid profile email"
			fi
		else
			title "Third-party backend"
			ask_value_required OPENAI_BASE_URL "Backend base URL (OpenAI-compatible, e.g. https://api.example.com/v1)"
			if [ "$ASK_MISS" = "0" ] && ! is_absolute_url "$REPLY_VAL"; then
				fail "The backend base URL must be an absolute http(s) URL."
			fi
			ask_secret_value OPENAI_API_KEY "Shared API key (pays for every call — cannot be generated)"
			while [ -z "$REPLY_VAL" ] && [ "$NON_INTERACTIVE" != "1" ]; do
				printf '%sThis deployment pays with the shared key — there is no other credential.%s\n' "$YELLOW" "$R"
				ask_hidden "Shared API key"
			done
			set_value OPENAI_API_KEY "$REPLY_VAL"
			# SAFETY, enforced not defaulted: user-token mode would send the
			# signed-in person's IdP access token out as a Bearer to the
			# third party — a credential leak, since that token also unlocks
			# their identity account. No toggle exists for this profile, and
			# a file setting it true is refused in validate_values.
			set_value USE_USER_TOKEN "false"
			set_value CHAT_USAGE_ENABLED "false"
			set_value FETCH_BACKEND "direct"
			# Reading documents, on a profile that has no gateway to read
			# them (ADR 0083). `/v1/ocr` does not exist here, so without an
			# endpoint named an attached PDF arrives with no text at all.
			# Offered rather than assumed: it is a second vendor and a second
			# bill, and a deployment nobody attaches documents to needs none.
			title "Document reading (optional)"
			note "No gateway means no /v1/ocr: without a reader, attached PDFs arrive with no text and knowledge ingestion cannot read them. Mistral and Cortecs both serve the shape the chat sends (POST {base}/ocr). Leave empty to skip — direct mode reads PDFs only."
			ask_value_opt CHAT_OCR_BASE_URL "OCR base URL (empty to skip, e.g. https://api.mistral.ai/v1)"
			if [ -z "$REPLY_VAL" ]; then
				# Written empty rather than omitted: the compose overlay names
				# all three, and a name it cannot resolve fails parsing.
				set_value CHAT_OCR_BASE_URL ""
				set_value CHAT_OCR_MODEL ""
				set_value CHAT_OCR_API_KEY ""
				note "No OCR endpoint on this profile: PDFs and Office files cannot be read — attachments go in blind, ingestion is text-only."
			else
				if ! is_absolute_url "$REPLY_VAL"; then
					fail "The OCR base URL must be an absolute http(s) URL."
				fi
				# Required once a URL is named: there is no catalogue to
				# discover a reader from, and the chat refuses to start with
				# one set without the other. Better to fail here than at
				# boot.
				ask_value_required CHAT_OCR_MODEL "OCR model name" "mistral-ocr-latest"
				ask_secret_opt CHAT_OCR_API_KEY "OCR API key (empty if unauthenticated)"
				note "This path reads PDFs only — Office formats (.docx/.xlsx/.pptx/.odt/.epub) still need a gateway reader."
			fi
			title "Identity provider"
			note "Sign-in still needs a provider — an anonymous deployment answers nobody. All three are mandatory."
			ask_value_required CHAT_OIDC_PROVIDER_URL "OIDC issuer"
			ask_value_required CHAT_OIDC_CLIENT_ID "Chat client id at the provider" "cerea"
			ask_secret_value CHAT_OIDC_CLIENT_SECRET "Chat client secret"
			while [ -z "$REPLY_VAL" ] && [ "$NON_INTERACTIVE" != "1" ]; do
				printf '%sThe chat cannot sign anyone in without its client secret.%s\n' "$YELLOW" "$R"
				ask_hidden "Chat client secret"
			done
			set_value CHAT_OIDC_CLIENT_SECRET "$REPLY_VAL"
			ask_value CHAT_OIDC_SCOPES "Chat OIDC scopes" "openid profile email"
		fi
	else
	# Providers are console-only on every gateway profile: no upstream
	# endpoint or key is asked or written here, and the compose defaults
	# (empty key, default base URL) carry that shape.
	note "Providers are added in the console after install — nothing answers until then."
	fi

	if [ "$EXPOSURE" = "edge" ]; then
		ask_value_required PUBLIC_HOST "Public hostname browsers use (the edge terminates TLS for it)"
		ask_value HTTPS_PORT "Edge forward port on this box" "8443"
		if pending_has TLS_DIRECTIVE; then
			# An operator override rides verbatim, even on the edge shape.
			pending_take TLS_DIRECTIVE
			note "TLS directive: ${REPLY_VAL:-(empty)} (--set)"
			set_value TLS_DIRECTIVE "$REPLY_VAL"
		else
			set_value TLS_DIRECTIVE "tls internal"
		fi
	else
		ask_value_required PUBLIC_HOST "Public host — IP for self-signed, FQDN for Let's Encrypt"
		local looks_ip=0
		is_ipv4 "${VALUES[PUBLIC_HOST]}" && looks_ip=1
		default_https_port "${VALUES[PUBLIC_HOST]}"
		ask_value HTTPS_PORT "HTTPS port" "$HTTPS_PORT_DEFAULT"
		if pending_has TLS_DIRECTIVE; then
			# The --set answer replaces the confirm: "" is Let's Encrypt,
			# "tls internal" is self-signed.
			pending_take TLS_DIRECTIVE
			note "Obtain a Let's Encrypt certificate automatically? (${REPLY_VAL:-(empty — automatic)} ← --set TLS_DIRECTIVE)"
			set_value TLS_DIRECTIVE "$REPLY_VAL"
		elif [ "$looks_ip" = "1" ]; then
			set_value TLS_DIRECTIVE "tls internal"
			note "IP address: Caddy issues from its own CA (browsers warn once). Let's Encrypt cannot issue for an IP."
		elif [ "$NON_INTERACTIVE" = "1" ]; then
			# The confirm's default (yes — automatic Let's Encrypt).
			set_value TLS_DIRECTIVE ""
			note "TLS: automatic Let's Encrypt (default)"
		else
			confirm "Obtain a Let's Encrypt certificate automatically? (needs ports 80+443 reachable)" 1
			if [ "$CONFIRM_VAL" = "1" ]; then
				set_value TLS_DIRECTIVE ""
			else
				set_value TLS_DIRECTIVE "tls internal"
			fi
		fi
		ask_value ACME_EMAIL "ACME email (certificate expiry notices)"
	fi
	local default_origin
	default_public_origin "${PARSED[PUBLIC_ORIGIN]:-}" "${VALUES[PUBLIC_HOST]}" "${VALUES[HTTPS_PORT]}"
	default_origin="$ORIGIN_DEFAULT"
	ask_value PUBLIC_ORIGIN "Public origin (every advertised URL is built from this)" "$default_origin"
	if [ "$ASK_MISS" = "0" ] && ! is_absolute_url "$REPLY_VAL"; then
		fail "PUBLIC_ORIGIN must be an absolute http(s) URL."
	fi

	if [ "$profile" = "enterprise" ]; then
		title "Sign-in architecture"
		note "Gateway console and chat are two separate OIDC clients, and /v1 accepts the chat's user tokens only when both sides agree on one issuer plus an audience (docs/oidc-generic-provider.md). A split signs in fine on both sides but breaks per-user /v1 calls; local passwords always stay on as the bootstrap door. Bundled providers deploy the directory on this box — the audience (pystino-api) is automatic, never prompted."
		printf '  %s1)%s Single external IdP for gateway and chat\n' "$CYAN" "$R"
		printf '  %s2)%s House IdP for both — no external provider\n' "$CYAN" "$R"
		printf '  %s3)%s Custom — each side separately, now or later\n' "$CYAN" "$R"
		printf '  %s4)%s Bundled Authelia — lean (tens of MB), password login today\n' "$CYAN" "$R"
		printf '  %s5)%s Bundled Keycloak — full directory (~730 MB RSS, ~80 s first boot)\n' "$CYAN" "$R"
		if [ -n "$FLAG_IDP" ]; then
			case "$FLAG_IDP" in
				external) REPLY_VAL="1" ;;
				house) REPLY_VAL="2" ;;
				custom) REPLY_VAL="3" ;;
				authelia) REPLY_VAL="4" ;;
				keycloak) REPLY_VAL="5" ;;
				central) fail "--idp central only applies to the satellite profile." ;;
			esac
			note "Sign-in (--idp): $FLAG_IDP"
		elif [ "$NON_INTERACTIVE" = "1" ]; then
			REPLY_VAL="1"
			note "Sign-in: external (default)"
		else
			ask "Choose [1-5]" "1"
		fi
		case "$REPLY_VAL" in
			2) AUTH_MODE="house" ;;
			3) AUTH_MODE="custom" ;;
			4) AUTH_MODE="bundled-authelia" ;;
			5) AUTH_MODE="bundled-keycloak" ;;
			*) AUTH_MODE="external" ;;
		esac
		if [ "$AUTH_MODE" = "bundled-authelia" ] || [ "$AUTH_MODE" = "bundled-keycloak" ]; then
			IDP_BUNDLED="${AUTH_MODE#bundled-}"
			note "Bundled $IDP_BUNDLED with enterprise components: same per-user billing as the external shape, plus NER, browser fetch and the ledger — minus the external directory."
			ask_bundled_credentials "$IDP_BUNDLED"
			note "Issuer, clients and audience derive from the public origin already given — no prompting for any of them."
		elif [ "$AUTH_MODE" = "house" ]; then
			note "House IdP with enterprise components: same sign-in as team, plus NER, browser fetch and the ledger."
			set_value GATEWAY_OIDC__ENABLED "false"
			set_house_idp_values
			token_url_safe 48
			set_value GATEWAY_IDP__INTERNAL_TOKEN "$TOKEN_VAL"
			# Chat OIDC stays unset: the overlay falls back to the house IdP.
		elif [ "$AUTH_MODE" = "custom" ]; then
			note "Each side optional; whatever stays empty is console/docs work later."
			# The two confirms are keyed on the VALUES keys they decide, so a
			# non-interactive run can steer them with --set
			# GATEWAY_OIDC__ENABLED / GATEWAY_IDP__ENABLED true|false.
			if pending_has GATEWAY_OIDC__ENABLED; then
				pending_take GATEWAY_OIDC__ENABLED
				case "$REPLY_VAL" in
					true) CONFIRM_VAL=1; note "External OIDC for the gateway console now? (--set: yes)" ;;
					false) CONFIRM_VAL=0; note "External OIDC for the gateway console now? (--set: no)" ;;
					*) fail "--set GATEWAY_OIDC__ENABLED must be true or false for the custom sign-in shape (got '$REPLY_VAL')." ;;
				esac
			elif [ "$NON_INTERACTIVE" = "1" ]; then
				CONFIRM_VAL=1
				note "External OIDC for the gateway console now? (default: yes)"
			else
				confirm "External OIDC for the gateway console now?" 1
			fi
			if [ "$CONFIRM_VAL" = "1" ]; then
				set_value GATEWAY_OIDC__ENABLED "true"
				ask_value_required GATEWAY_OIDC__ISSUER "OIDC issuer"
				ask_value_required GATEWAY_OIDC__CLIENT_ID "Client id (gateway console)"
				ask_secret_opt GATEWAY_OIDC__CLIENT_SECRET "Client secret (gateway console, empty for a public client)"
				ask_value GATEWAY_OIDC__GROUPS_CLAIM "Groups claim" "groups"
				ask_access_token_audience
			else
				set_value GATEWAY_OIDC__ENABLED "false"
			fi
			if pending_has GATEWAY_IDP__ENABLED; then
				pending_take GATEWAY_IDP__ENABLED
				case "$REPLY_VAL" in
					true) CONFIRM_VAL=1; note "House IdP on (covers the chat while its own provider is unset)? (--set: yes)" ;;
					false) CONFIRM_VAL=0; note "House IdP on (covers the chat while its own provider is unset)? (--set: no)" ;;
					*) fail "--set GATEWAY_IDP__ENABLED must be true or false for the custom sign-in shape (got '$REPLY_VAL')." ;;
				esac
			elif [ "$NON_INTERACTIVE" = "1" ]; then
				CONFIRM_VAL=1
				note "House IdP on (covers the chat while its own provider is unset)? (default: yes)"
			else
				confirm "House IdP on (covers the chat while its own provider is unset)?" 1
			fi
			if [ "$CONFIRM_VAL" = "1" ]; then
				set_house_idp_values
				token_url_safe 48
				set_value GATEWAY_IDP__INTERNAL_TOKEN "$TOKEN_VAL"
			else
				set_value GATEWAY_IDP__ENABLED "false"
			fi
			ask_value_opt CHAT_OIDC_PROVIDER_URL "Chat OIDC provider URL (empty leaves the chat on the house IdP when it is on)"
			if [ -n "$REPLY_VAL" ]; then
				ask_value CHAT_OIDC_CLIENT_ID "Chat client id at the provider" "cerea"
				ask_secret_opt CHAT_OIDC_CLIENT_SECRET "Chat client secret (empty for a public client)"
				ask_value CHAT_OIDC_SCOPES "Chat OIDC scopes" "openid profile email"
			elif [ "${VALUES[GATEWAY_IDP__ENABLED]:-}" != "true" ]; then
				warn "No provider anywhere: the chat cannot sign anyone in until CHAT_OIDC_* is set. Local passwords still open the console."
			fi
			if [ -n "${VALUES[CHAT_OIDC_PROVIDER_URL]:-}" ] && [ "${VALUES[CHAT_OIDC_PROVIDER_URL]}" != "${VALUES[GATEWAY_OIDC__ISSUER]:-}" ] && [ "${VALUES[GATEWAY_OIDC__ENABLED]:-}" = "true" ]; then
				warn "Split issuers: the chat's tokens come from a provider the gateway's /v1 does not trust, so per-user /v1 calls will fail until the issuers agree. API keys keep working."
			fi
		else
			title "External identity provider"
		note "docs/oidc-generic-provider.md has the per-provider checklist. The audience is what accepts the provider's tokens on /v1 — the chat calls the gateway as the user, so leaving it empty breaks signed-in inference."
		set_value GATEWAY_OIDC__ENABLED "true"
		ask_value_required GATEWAY_OIDC__ISSUER "OIDC issuer"
		ask_value_required GATEWAY_OIDC__CLIENT_ID "Client id (gateway console)"
		ask_secret_value GATEWAY_OIDC__CLIENT_SECRET "Client secret (gateway console)"
		ask_value GATEWAY_OIDC__GROUPS_CLAIM "Groups claim" "groups"
		ask_access_token_audience
		set_value GATEWAY_IDP__ENABLED "false"
		ask_value CHAT_OIDC_PROVIDER_URL "Chat OIDC provider URL" "${VALUES[GATEWAY_OIDC__ISSUER]}"
		ask_value_required CHAT_OIDC_CLIENT_ID "Chat client id at the provider" "cerea"
		ask_secret_value CHAT_OIDC_CLIENT_SECRET "Chat client secret"
		ask_value CHAT_OIDC_SCOPES "Chat OIDC scopes" "openid profile email"
		fi
 	elif [ "$standalone" = "0" ]; then
		# Team-house and homelab. Team-bundled skips this: the fixup below
		# writes the bundled values instead, and a house client registry
		# beside a disabled house IdP would only confuse.
		if [ -z "$IDP_BUNDLED" ]; then
			set_value GATEWAY_OIDC__ENABLED "false"
			set_house_idp_values
		fi
	fi
	# Bundled issuers need the public origin, which is only known here: the
	# team and satellite menus ran before it, enterprise inline above (same
	# call, kept in one place so the three shapes cannot drift).
	if [ -n "$IDP_BUNDLED" ]; then
		case "$profile" in
			team | enterprise) set_bundled_idp_values "$IDP_BUNDLED" ;;
			satellite)
				if [ "$IDP_BUNDLED" != "authelia" ]; then
					fail "satellite supports only the bundled Authelia (got '$IDP_BUNDLED')."
				fi
				# One secret serves both halves, house-style: the chat's
				# Authelia client reuses the minted fallback the overlay
				# requires, so the two names cannot disagree.
				set_bundled_idp_values authelia "${VALUES[CHAT_IDP_CLIENT_SECRET]}"
				;;
			*)
				fail "bundled IdP on profile '$profile' is not wired."
				;;
		esac
	fi
	if [ "$standalone" = "0" ] && [ "${VALUES[GATEWAY_IDP__ENABLED]:-}" != "true" ] && [ -z "${VALUES[GATEWAY_IDP__CLIENTS]+x}" ]; then
		# No house IdP, no registry — but the name must still parse: the
		# compose file passes it through as an empty string when unset,
		# and an empty string is not a valid list, which crashes gateway
		# startup (found live, never reachable from dry-run). `[]` parses
		# to no clients, and the at-least-one-client rule only fires when
		# the IdP is enabled.
		set_value GATEWAY_IDP__CLIENTS "[]"
	fi

	# Chat Postgres credentials: generated here, role created in phase 1.
	if [ "$standalone" = "1" ]; then
		# One Postgres identity on this box: POSTGRES_USER is the initdb
		# superuser and the chat connects as that same role, so both
		# passwords are one value. A separately generated chat password
		# would be ALTERed over the superuser's by the role block in phase
		# 1 — two secrets where one is silently clobbered.
		set_value CHAT_PG_PASSWORD "${VALUES[POSTGRES_PASSWORD]}"
		set_value CHAT_PG_URL "postgresql://chat:${VALUES[POSTGRES_PASSWORD]}@postgres:5432/chat"
		# Fixed component set — these profiles hold no gateway, so there is
		# nothing to meter with and no redaction engine to select. Usage and
		# the user-token mode were set per profile above (satellite reads
		# central's ledger with the user's token; generic has no ledger and
		# must never send a user token out).
		if [ "$ST_CODETOOL" = "1" ]; then set_value CHAT_CODE_TOOL_ENABLED "true"; else set_value CHAT_CODE_TOOL_ENABLED ""; fi
		if [ "$ST_KNOWLEDGE" = "1" ]; then set_value CHAT_KNOWLEDGE_ENABLED "true"; else set_value CHAT_KNOWLEDGE_ENABLED "false"; fi
		if [ "$ST_MEMORY" = "1" ]; then set_value CHAT_MEMORY_ENABLED "true"; else set_value CHAT_MEMORY_ENABLED "false"; fi
		return
	fi
	token_url_safe 24
	set_value CHAT_PG_PASSWORD "$TOKEN_VAL"
	set_value CHAT_PG_URL "postgresql://chat:${TOKEN_VAL}@postgres:5432/chat"

	# Toggle-derived deployment flags.
	if [ "$ST_METERING" = "1" ]; then
		set_value GATEWAY_ACCOUNTING__ENABLED "true"
		set_value GATEWAY_QUOTA__ENABLED "true"
	else
		set_value GATEWAY_ACCOUNTING__ENABLED "false"
		set_value GATEWAY_QUOTA__ENABLED "false"
	fi
	if [ "$REDACTION_STATE" = "off" ]; then
		set_value GATEWAY_REDACTION__ENGINE "noop"
	else
		set_value GATEWAY_REDACTION__ENGINE "http"
		if [ "$REDACTION_STATE" = "ner" ]; then
			set_value SPACY_MODELS "en_core_web_lg"
			set_value REDACTION_NLP_ENGINE "spacy"
			note 'NER build: the Italian-name model (it_core_news_lg) is CC BY-NC-SA 3.0 — the default en_core_web_lg build stays MIT throughout. Add it later by rebuilding with SPACY_MODELS="en_core_web_lg it_core_news_lg".'
		else
			set_value SPACY_MODELS ""
			set_value REDACTION_NLP_ENGINE "disabled"
		fi
		set_value REDACTION_LANGUAGE "en"
	fi
	set_value FETCH_BACKEND "$ST_FETCH"
	if [ "$ST_CODETOOL" = "1" ]; then set_value CHAT_CODE_TOOL_ENABLED "true"; else set_value CHAT_CODE_TOOL_ENABLED ""; fi
	if [ "$ST_USAGE" = "1" ]; then set_value CHAT_USAGE_ENABLED "true"; else set_value CHAT_USAGE_ENABLED ""; fi
	if [ "$ST_KNOWLEDGE" = "1" ]; then set_value CHAT_KNOWLEDGE_ENABLED "true"; else set_value CHAT_KNOWLEDGE_ENABLED "false"; fi
	if [ "$ST_MEMORY" = "1" ]; then set_value CHAT_MEMORY_ENABLED "true"; else set_value CHAT_MEMORY_ENABLED "false"; fi
	# GATEWAY_SESSION_COOKIE_SECURE is deliberately not set here: it stays
	# whatever the fragment says (false for homelab/team loopback shapes,
	# true for enterprise), and the proxy overlay forces true at the
	# container regardless. On plain http a Secure cookie is set and never
	# sent back — a login that lands on a signed-out console with nothing in
	# any log — so this is not a value to default behind the operator's back.
	set_value GATEWAY_LOCAL_AUTH__ENABLED "true"
	set_value GATEWAY_ENVIRONMENT "production"
	if pending_has GATEWAY_PORT; then
		# The one non-ask override the collect tail carries: a --set port
		# wins over the fragment's/parsed value.
		pending_take GATEWAY_PORT
		set_value GATEWAY_PORT "$REPLY_VAL"
		note "GATEWAY_PORT: $REPLY_VAL (--set)"
	else
		set_value GATEWAY_PORT "${PARSED[GATEWAY_PORT]:-8000}"
	fi
}

# Review: keys with provenance, values masked. Asked-for secrets that no
# spec generates are pasted, never shown back — the same rule as the
# generated ones.
show_review() {
	title "Review"
	local key value shown
	for key in "${VALUES_ORDER[@]}"; do
		value="${VALUES[$key]}"
		case "$key" in
			CHAT_PG_URL)
				if [[ "$value" =~ ^(postgresql://[^:]+:)[^@]+(@.*)$ ]]; then
					shown="${BASH_REMATCH[1]}(hidden)${BASH_REMATCH[2]}"
				else
					shown="$value"
				fi
				;;
			POSTGRES_PASSWORD | GATEWAY_SECRET_KEY | GATEWAY_SESSION_SECRET | REDACTION_PLACEHOLDER_KEY | GATEWAY_IDP__INTERNAL_TOKEN | GATEWAY_IDP__SIGNING_KEY | CHAT_IDP_CLIENT_SECRET | CHAT_SECRET_KEY | CHAT_PG_PASSWORD | GATEWAY_UPSTREAM__API_KEY | GATEWAY_OIDC__CLIENT_SECRET | OPENAI_API_KEY | CHAT_OIDC_CLIENT_SECRET | KEYCLOAK_ADMIN_PASSWORD | IDP_SESSION_SECRET | IDP_HMAC_SECRET | IDP_STORAGE_KEY | IDP_CONSOLE_CLIENT_SECRET) shown="(secret, hidden)" ;;
			*) [ -z "$value" ] && shown="(empty)" || shown="$value" ;;
		esac
		printf '  %s=%s\n' "$key" "$shown"
	done
}

# ------------------------------------------------------------------ #
# compose: always --env-file, never the shell environment             #
# ------------------------------------------------------------------ #

dry_print_cmd() {
	printf '%s[dry-run] (cd %s &&' "$CYAN" "$PYSTINO_ROOT"
	local arg
	for arg in "$@"; do
		printf ' %q' "$arg"
	done
	printf ')%s\n' "$R"
}

# Try a compose command, returning its status (for probes and steps whose
# failure is a decision point, not the end). `exec` gains -T when stdin is
# not a TTY: a scripted run (answers piped in) has no terminal to allocate,
# and without -T the container sees EOF at the first prompt — the phase-1
# `gateway passwd` step then dies mid-password. With -T the prompt reads
# stdin, echoing it with the same warning ask_hidden gives.
try_compose() { # try_compose <env-file> <args...>
	local envfile="$1"
	shift
	if [ "$DRY_RUN" = "1" ]; then
		dry_print_cmd docker compose --env-file "$envfile" "$@"
		return 0
	fi
	compose_exec_t "$@"
	(cd "$PYSTINO_ROOT" && "${SCRUB[@]}" compose --env-file "$envfile" "${COMPOSE_ARGS[@]}")
}

# A compose command whose failure stops the installer.
run_compose() { # run_compose <env-file> <args...>
	local envfile="$1"
	shift
	if ! try_compose "$envfile" "$@"; then
		fail "docker compose $* exited non-zero."
	fi
}

# Ask overlays.sh for the -f list. The installer never restates the mapping:
# profile sets go through profile_overlays, deviated sets through
# custom_overlays. Sourced in a subshell so its functions and positional
# parameters never leak into this script. CHAT_REPO is exported into that
# subshell because custom_overlays requires it for the playwright overlay —
# the node installer scrubbed it from the derivation's environment instead,
# which would have failed every playwright selection.
overlay_flags() { # overlay_flags <mode> <args...>
	local mode="$1"
	shift
	local out
	out="$(
		cd "$PYSTINO_ROOT" &&
			CHAT_REPO="$CHAT_REPO_VAL" &&
			export CHAT_REPO &&
			. deploy/profiles/overlays.sh &&
			"$mode" "$@"
	)" || fail "overlays.sh refused the selection (see the message above)."
	# One -f path pair per two words; paths with spaces are refused at
	# checkout validation, so whitespace splitting is safe by construction.
	read -r -a OVERLAY_FLAGS <<<"$out"
}

# The bundled issuer answers through the proxy at its public URL — exactly
# what the gateway and the chat fetch at startup, so the probe uses the
# public origin, not the loopback (Caddy serves the certificate by SNI, and
# a loopback probe does not carry the hostname). wget lives in the proxy
# image, so the host needs nothing new; the certificate is deliberately not
# checked here (trust is the CA dance's job, next). Deadline is generous:
# Keycloak's first boot imports the realm and takes ~80 s before discovery
# answers. Edge shape probes the local plain-HTTP listener instead.
wait_for_idp() { # wait_for_idp <env-file> <flags...>
	local envfile="$1"
	shift
	if [ "$DRY_RUN" = "1" ]; then
		note "[dry-run] would wait for the bundled issuer's discovery (proxy wget, 300s deadline)"
		return
	fi
	local path="/authelia/.well-known/openid-configuration"
	if [ "${VALUES[IDP_BUNDLED]:-}" = "keycloak" ]; then
		path="/idp/realms/pystino/.well-known/openid-configuration"
	fi
	local url="${VALUES[PUBLIC_ORIGIN]}${path}"
	if [ "${EXPOSURE:-proxy}" = "edge" ]; then
		url="http://127.0.0.1:${VALUES[HTTPS_PORT]:-8443}${path}"
	fi
	local deadline=$((SECONDS + 300))
	printf 'Waiting for the bundled issuer'
	while :; do
		if try_compose "$envfile" "$@" exec -T proxy wget -q -O /dev/null --no-check-certificate "$url" 2>/dev/null; then
			printf ' — answering.\n'
			return
		fi
		if [ "$SECONDS" -gt "$deadline" ]; then
			printf '\n'
			fail "the bundled issuer did not answer $path in time. Inspect with: docker compose logs ${VALUES[IDP_BUNDLED]} proxy"
		fi
		printf '.'
		sleep 5
	done
}

# Proxy shape only: make the gateway (and, in phase 2, the chat) trust the
# proxy's internal CA. The bundle is the public roots plus Caddy's local
# authority, de-duplicated — SSL_CERT_FILE *replaces* the trust store, so a
# bundle of only the local root would blind the gateway to its upstream
# provider. Edge shape skips this (plain HTTP behind the edge: no CA to
# trust, and nothing to verify against).
#
# Health-gated: the rebundle runs only when the live proxy root is not
# already in the bundle. A recreated caddy-data volume mints a NEW CA whose
# root is absent, so the dance heals it; an intact stack finds its root
# already trusted and stops here instead of rewriting a file that was hot
# on the operator's box.
bundle_contains_cert() { # bundle_contains_cert <bundle-file> <pem> -> exit 0 when present
	local probe cert
	# Both sides go through the same normalization the bundle writer uses
	# (each certificate reassembled as one exact block) and are then
	# compared whole: a plain grep cannot match a multi-line PEM. The
	# reassembly deliberately leaves no trailing newline on either side —
	# the probe travels through a command substitution, which strips them,
	# and the read -d '' loop keeps them, so a newline-terminated block
	# would never equal its own stripped copy.
	probe="$(printf '%s\n' "$2" | awk '/BEGIN CERTIFICATE/{p=""} {p=(p == "" ? "" : p "\n") $0} /END CERTIFICATE/{printf "%s", p}')"
	while IFS= read -r -d '' cert; do
		if [ "$cert" = "$probe" ]; then return 0; fi
	done < <(awk '/BEGIN CERTIFICATE/{p=""} {p=(p == "" ? "" : p "\n") $0} /END CERTIFICATE/{printf "%s\0", p}' "$1" 2>/dev/null)
	return 1
}

idp_ca_dance() { # idp_ca_dance <env-file> <flags...>
	local envfile="$1"
	shift
	if [ -z "${VALUES[IDP_BUNDLED]:-}" ]; then return; fi
	if [ "${EXPOSURE:-proxy}" != "proxy" ]; then
		note "Edge shape: no CA dance (plain HTTP behind the edge)."
		return
	fi
	if [ "$DRY_RUN" = "1" ]; then
		note "[dry-run] would append the proxy's local CA root to deploy/tls/caddy-root.crt (public roots first, de-duplicated) and restart the gateway"
		return
	fi
	local tls_dir="$PYSTINO_ROOT/deploy/tls"
	local bundle="$tls_dir/caddy-root.crt"
	mkdir -p "$tls_dir"
	echo "Trusting the proxy's local CA ..."
	local proxy_root public_roots tmp_bundle
	if ! proxy_root="$(cd "$PYSTINO_ROOT" && "${SCRUB[@]}" compose --env-file "$envfile" "$@" exec -T proxy cat /data/caddy/pki/authorities/local/root.crt 2>/dev/null)"; then
		fail "could not read the proxy's local CA root (is the proxy up? docker compose logs proxy)."
	fi
	case "$proxy_root" in
		*"BEGIN CERTIFICATE"*) ;;
		*) fail "the proxy's CA root did not look like a certificate." ;;
	esac
	# The skip is explicit and logged: the precondition (the live root
	# missing from the bundle) is absent, so nothing is rewritten and the
	# public-roots docker run below never happens.
	if [ -f "$bundle" ] && bundle_contains_cert "$bundle" "$proxy_root"; then
		note "The proxy's local CA root is already in deploy/tls/caddy-root.crt — already trusted, skipping the rebundle."
		return
	fi
	if ! public_roots="$(docker run --rm caddy:2.11-alpine cat /etc/ssl/certs/ca-certificates.crt 2>/dev/null)"; then
		fail "could not read the public roots (docker run caddy:2.11-alpine failed)."
	fi
	tmp_bundle="$bundle.new.$$"
	{
		[ -f "$bundle" ] && cat "$bundle"
		printf '%s\n' "$public_roots"
		printf '%s\n' "$proxy_root"
	} | awk '/BEGIN CERTIFICATE/{p=""} {p=p $0 "\n"} /END CERTIFICATE/{if (!seen[p]++) printf "%s", p}' >"$tmp_bundle"
	mv -f "$tmp_bundle" "$bundle"
	chmod 644 "$bundle"
	note "Trust bundle refreshed: $(grep -c 'BEGIN CERTIFICATE' "$bundle") certificates in deploy/tls/caddy-root.crt."
}

# Edge shape: Caddyfile.netbird has no conf.d import, so the bundled route
# is appended once to a shared snippet both sites import. Proxy shape needs
# nothing (the overlay mounts into conf.d). Idempotent behind a marker; if
# the sites no longer match the shape below, stop with manual instructions
# rather than writing a file Caddy refuses.
ensure_edge_idp_route() {
	if [ -z "${VALUES[IDP_BUNDLED]:-}" ]; then return; fi
	if [ "${EXPOSURE:-}" != "edge" ]; then return; fi
	local kind="${VALUES[IDP_BUNDLED]}"
	local netbird="$PYSTINO_ROOT/deploy/caddy/Caddyfile.netbird"
	local marker="# installer: bundled $kind route (deploy/compose/docker-compose.idp-$kind.yml)"
	if [ "$DRY_RUN" = "1" ]; then
		note "[dry-run] would append the bundled $kind route to deploy/caddy/Caddyfile.netbird (shared snippet, both sites)"
		return
	fi
	if grep -q "installer: bundled .* route" "$netbird" 2>/dev/null; then
		note "Bundled route already present in Caddyfile.netbird."
		return
	fi
	local snippet_src=""
	if [ "$kind" = "authelia" ]; then
		snippet_src="$PYSTINO_ROOT/deploy/caddy/conf.d-authelia/20-authelia.caddy"
	else
		snippet_src="$PYSTINO_ROOT/deploy/idp/10-idp-keycloak.caddy"
	fi
	[ -f "$snippet_src" ] || fail "missing $snippet_src (generate the IdP files first)."
	# Snippets are defined BEFORE the sites that import them: Caddy adapts
	# top-down, and an import whose snippet appears later in the file is
	# 'File to import not found' — the proxy crash-loop appending-at-the-end
	# once produced on a fresh install, the moment phase 1 started it. The
	# insertion point is the first site block's opener (the ':8443 {'
	# line): everything above it is the file's fixed prefix — globals, the
	# auto_https block, the (origin-routes) snippet — so the snippet lands
	# after its sibling and before the sites that import both.
	local site_line
	site_line="$(grep -nE '^[a-z0-9.:-]+ \{$' "$netbird" | head -1 | cut -d: -f1)"
	[ -n "$site_line" ] || fail "Caddyfile.netbird no longer matches the shape this installer knows (no site block opener to insert the (idp-routes) snippet before). Add it by hand above the sites, then re-run with --phase2."
	local tmp_nb="$netbird.new.$$"
	{
		sed -n "1,$((site_line - 1))p" "$netbird"
		printf '\n%s\n' "$marker"
		printf '(idp-routes) {\n'
		cat "$snippet_src"
		printf '}\n'
		sed -n "${site_line},\$p" "$netbird"
	} >"$tmp_nb"
	# Both sites import origin-routes; teach them the new snippet too. The
	# match is exact-indentation on purpose: anything else means the file
	# moved on, and a blind append would write a route nobody imports.
	if ! grep -q $'^\timport origin-routes$' "$tmp_nb"; then
		rm -f "$tmp_nb"
		fail "Caddyfile.netbird no longer matches the shape this installer knows (no '<tab>import origin-routes' lines). Add the (idp-routes) snippet's import to both sites by hand, then re-run with --phase2."
	fi
	sed -i 's|^\(\t*\)import origin-routes$|\1import origin-routes\n\1import idp-routes|' "$tmp_nb"
	mv -f "$tmp_nb" "$netbird"
	note "Bundled $kind route inserted above the sites in Caddyfile.netbird (both sites import it)."
}

# Escape a value for the sed replacement half (delimiter |): backslashes,
# ampersands and the delimiter arrive quoted. Values are single-line by
# construction (asserted in main), so no newline handling is needed.
esc_sed() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

# The bundled provider's generated files: the realm JSON plus the verbatim
# Caddy snippet for Keycloak (rendered from the template with minted values),
# the Authelia trio via its generator (bash+openssl only). Refuses to
# overwrite a previous install — a re-import wipes every user created since,
# so regeneration is a deliberate delete, never an accident.
generate_idp_files() { # generate_idp_files <out-dir>
	local out="$1" kind="${VALUES[IDP_BUNDLED]:-}"
	[ -z "$kind" ] && return 0
	mkdir -p "$out"
	if [ "$kind" = "keycloak" ]; then
		local f
		for f in keycloak-realm.json 10-idp-keycloak.caddy; do
			if [ -e "$out/$f" ]; then
				fail "refusing: $out/$f exists (delete it deliberately to regenerate — a re-import wipes every user created since)."
			fi
		done
		sed -e "s|__PUBLIC_ORIGIN__|$(esc_sed "${VALUES[PUBLIC_ORIGIN]}")|g" \
			-e "s|__GATEWAY_CLIENT_SECRET__|$(esc_sed "${VALUES[GATEWAY_OIDC__CLIENT_SECRET]}")|g" \
			-e "s|__CHAT_CLIENT_SECRET__|$(esc_sed "${VALUES[CHAT_OIDC_CLIENT_SECRET]}")|g" \
			-e "s|__FIRST_USER_PASSWORD__|$(esc_sed "$IDP_FIRST_PASSWORD")|g" \
			"$PYSTINO_ROOT/deploy/idp/keycloak-realm.json.template" >"$out/keycloak-realm.json"
		chmod 600 "$out/keycloak-realm.json"
		cp "$PYSTINO_ROOT/deploy/idp/10-idp-keycloak.caddy.template" "$out/10-idp-keycloak.caddy"
		note "Rendered $out/keycloak-realm.json + $out/10-idp-keycloak.caddy."
	else
		if [ -e "$out/authelia-configuration.yml" ] || [ -e "$out/users_database.yml" ] || [ -e "$out/authelia-jwks-rsa.pem" ]; then
			fail "refusing: $out already holds generated Authelia files (delete them deliberately to regenerate — rotating the key re-provisions every user)."
		fi
		IDP_OUT_DIR="$out" \
			IDP_PUBLIC_ORIGIN="${VALUES[PUBLIC_ORIGIN]}" \
			IDP_COOKIE_DOMAIN="${VALUES[PUBLIC_HOST]}" \
			IDP_SESSION_SECRET="${VALUES[IDP_SESSION_SECRET]}" \
			IDP_HMAC_SECRET="${VALUES[IDP_HMAC_SECRET]}" \
			IDP_STORAGE_KEY="${VALUES[IDP_STORAGE_KEY]}" \
			IDP_CONSOLE_CLIENT_SECRET="${VALUES[GATEWAY_OIDC__CLIENT_SECRET]}" \
			IDP_CHAT_CLIENT_SECRET="${VALUES[CHAT_OIDC_CLIENT_SECRET]}" \
			IDP_ADMIN_USER="$IDP_ADMIN_USER" \
			IDP_ADMIN_EMAIL="$IDP_ADMIN_EMAIL" \
			IDP_ADMIN_NAME="$IDP_ADMIN_NAME" \
			IDP_ADMIN_PASSWORD="$IDP_ADMIN_PASSWORD" \
			bash "$PYSTINO_ROOT/deploy/idp/generate-authelia-config.sh"
	fi
}

# Resume guard: the files must already exist (first boot imports them, and
# the passwords that rendered them are not recoverable from deploy/.env).
check_idp_files() {
	local kind="${VALUES[IDP_BUNDLED]:-}"
	[ -z "$kind" ] && return 0
	local dir="$PYSTINO_ROOT/deploy/idp" f
	if [ "$kind" = "keycloak" ]; then
		for f in keycloak-realm.json 10-idp-keycloak.caddy; do
			[ -f "$dir/$f" ] || fail "--phase2 with a bundled Keycloak needs $dir/$f (re-run the full flow to generate it)."
		done
	else
		for f in authelia-configuration.yml users_database.yml; do
			[ -f "$dir/$f" ] || fail "--phase2 with a bundled Authelia needs $dir/$f (re-run the full flow to generate it)."
		done
	fi
	# The "exists, skipping" leg of the idempotence rule: a resume finds the
	# generated files where the fresh run refused to overwrite them, and says
	# so instead of passing silently — regeneration stays a deliberate delete.
	note "Bundled $kind files present in $dir — exists, skipping (regeneration stays refused: a re-import wipes every user created since)."
}

# The gateway profiles wait on the gateway's /healthz, which only turns
# green once Postgres is usable. The probe runs inside the gateway container
# — the same check its compose healthcheck runs — so the host needs no HTTP
# client at all (no curl, no node) and the internal port is used whatever
# the published mapping is.
wait_for_gateway() { # wait_for_gateway <env-file> <flags...>
	local envfile="$1"
	shift
	if [ "$DRY_RUN" = "1" ]; then
		note "[dry-run] would wait for the gateway's /healthz (in-container probe, 180s deadline)"
		return
	fi
	local probe='import urllib.request,sys; sys.exit(0 if urllib.request.urlopen("http://localhost:8000/healthz", timeout=3).status == 200 else 1)'
	local deadline=$((SECONDS + 180))
	printf 'Waiting for the gateway'
	while :; do
		if try_compose "$envfile" "$@" exec -T gateway python -c "$probe" 2>/dev/null; then
			printf ' — healthy.\n'
			return
		fi
		if [ "$SECONDS" -gt "$deadline" ]; then
			printf '\n'
			fail "the gateway did not become healthy in time. Inspect with: docker compose logs gateway"
		fi
		printf '.'
		sleep 3
	done
}

# Standalone profiles have no gateway, so they wait on the database directly
# before creating the chat role.
wait_for_postgres() { # wait_for_postgres <env-file> <pg-user> <flags...>
	local envfile="$1" pg_user="$2"
	shift 2
	if [ "$DRY_RUN" = "1" ]; then
		note "[dry-run] would wait for postgres (docker compose exec -T postgres pg_isready -U $pg_user, 120s deadline)"
		return
	fi
	local deadline=$((SECONDS + 120))
	printf 'Waiting for postgres'
	while :; do
		if try_compose "$envfile" "$@" exec -T postgres pg_isready -U "$pg_user" 2>/dev/null; then
			printf ' — ready.\n'
			return
		fi
		if [ "$SECONDS" -gt "$deadline" ]; then
			printf '\n'
			fail "postgres did not become ready in time. Inspect with: docker compose logs postgres"
		fi
		printf '.'
		sleep 2
	done
}

# Creates the chat's Postgres role and database. flags is the overlay set
# the postgres service comes from (base-only for gateway profiles, the
# standalone set for satellite/generic). Connects to the stock postgres
# maintenance database, which exists from initdb on — unlike a named
# POSTGRES_DB, which may itself be the database being created.
ensure_chat_database() { # ensure_chat_database <env-file> <flags...>
	local envfile="$1"
	shift
	local pg_user="${VALUES[POSTGRES_USER]:-gateway}"
	local password="${VALUES[CHAT_PG_PASSWORD]}"
	local sql
	sql="$(printf 'DO $$ BEGIN\n  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = %s) THEN\n    CREATE ROLE chat WITH LOGIN PASSWORD %s;\n  ELSE\n    ALTER ROLE chat WITH LOGIN PASSWORD %s;\n  END IF;\nEND $$;\nSELECT %s;\nCREATE DATABASE chat OWNER chat;\nGRANT ALL PRIVILEGES ON DATABASE chat TO chat;\n' "'chat'" "'${password//\'/\'\'}'" "'${password//\'/\'\'}'" "'role ok'")"
	if [ "$DRY_RUN" = "1" ]; then
		dry_print_cmd docker compose --env-file "$envfile" "$@" exec -T postgres psql -U "$pg_user" -d postgres -v ON_ERROR_STOP=1
		note "[dry-run] psql stdin (password masked): ${sql//"${password}"/(hidden)}"
		return
	fi
	echo ""
	echo "Creating the chat's Postgres role and database ..."
	# CREATE DATABASE fails if it exists; the role block above is idempotent,
	# so a failure here on resume means "already there" — verified below
	# rather than assumed.
	local ok=0
	if printf '%s\n' "$sql" | try_compose "$envfile" "$@" exec -T postgres psql -U "$pg_user" -d postgres -v ON_ERROR_STOP=1; then
		ok=1
	fi
	if [ "$ok" = "0" ]; then
		local check
		note "chat database step reported a failure — continuing if the database already exists."
		check="$(try_compose "$envfile" "$@" exec -T postgres psql -U "$pg_user" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='chat'" 2>/dev/null || true)"
		trim "$check"
		if [ "$REPLY_VAL" != "1" ]; then
			fail "the chat database does not exist and creating it failed. Create it by hand, then re-run with --phase2."
		fi
		note "Chat database already present — continuing."
	fi
}

# The operator email a bundled-IdP shape seeds the gateway's admin with, in
# the order of authority: the recorded value (fresh installs and resumes of
# their .env files carry IDP_ADMIN_EMAIL in deploy/.env), else Keycloak's
# realm-template first human (fixed), else — the legacy-resume case — the
# first human in the Authelia seed file, which is where the installer wrote
# them at install time and the only place a pre-metadata .env still names
# them.
operator_email_for() { # operator_email_for <authelia|keycloak> -> ADMIN_EMAIL_VAL
	ADMIN_EMAIL_VAL="${VALUES[IDP_ADMIN_EMAIL]:-}"
	if [ -n "$ADMIN_EMAIL_VAL" ]; then return 0; fi
	case "$1" in
		keycloak)
			ADMIN_EMAIL_VAL="owner@example.org" # fixed by the realm template
			;;
		authelia)
			ADMIN_EMAIL_VAL="$(sed -n "s/^[[:space:]]*email: *['\"]\([^'\"]*\)['\"].*/\1/p" "$PYSTINO_ROOT/deploy/idp/users_database.yml" 2>/dev/null | awk 'NR==1')"
			;;
		*)
			ADMIN_EMAIL_VAL=""
			;;
	esac
}

# The bundled-IdP admin re-seed, the flagship of the health-gated phases: a
# database volume recreation wipes the users table, and the next SSO login
# provisions a fresh non-admin row — the operator is locked out of the
# console with no error anywhere. Phase 2 therefore re-counts the admin rows
# once the stack is up (the same exec -T psql pattern ensure_chat_database
# uses) and re-runs the phase-1 passwd step when the count is zero, so a
# resume after a partial failure or a volume recreation heals the row
# instead of leaving the lockout. Non-bundled and standalone shapes have
# nothing to re-seed (no operator email, no gateway).
ensure_bundled_admin() { # ensure_bundled_admin <env-file> <flags...>
	local envfile="$1"
	shift
	is_standalone_profile "$PROFILE" && return 0
	local kind="${VALUES[IDP_BUNDLED]:-}"
	[ -n "$kind" ] || return 0
	operator_email_for "$kind"
	local email="$ADMIN_EMAIL_VAL"
	if [ -z "$email" ]; then
		warn "cannot determine the operator email for the admin re-seed (no IDP_ADMIN_EMAIL in deploy/.env, none in the IdP seed files) — promote by hand (see the next steps)."
		return
	fi
	local pg_user="${VALUES[POSTGRES_USER]:-gateway}"
	local pg_db="${VALUES[POSTGRES_DB]:-gateway}"
	local count_sql="SELECT count(*) FROM users WHERE is_admin"
	if [ "$DRY_RUN" = "1" ]; then
		note "[dry-run] would wait for postgres (docker compose exec -T postgres pg_isready -U $pg_user, 120s deadline)"
		dry_print_cmd docker compose --env-file "$envfile" "$@" exec -T postgres psql -U "$pg_user" -d "$pg_db" -tAc "$count_sql"
		note "[dry-run] would re-run 'gateway passwd $email --admin' when the count is 0 (the wiped-volume re-seed)"
		return
	fi
	wait_for_postgres "$envfile" "$pg_user" "$@"
	local count
	if ! count="$(try_compose "$envfile" "$@" exec -T postgres psql -U "$pg_user" -d "$pg_db" -tAc "$count_sql" 2>/dev/null)"; then
		fail "could not count the admin rows (is postgres up? docker compose logs postgres)."
	fi
	trim "$count"
	if [ "$REPLY_VAL" = "0" ]; then
		echo "No admin row in the gateway's database (a recreated volume wipes them) — re-seeding the break-glass admin ..."
		run_compose "$envfile" "$@" exec gateway gateway passwd "$email" --admin
	else
		note "Admin row present (count=$REPLY_VAL) — re-seed skipped."
	fi
}

# The deploy/compose.sh wrapper: recorded at the end of a real run, printed
# on a dry run. The overlay flags are whatever the phase-2 derivation left
# in OVERLAY_FLAGS — the exact list this install runs. The --profile
# embeddings are supplied only when deploy/.env lacks the COMPOSE_PROFILES
# line (legacy resumes): the flags replace, never extend, the file's list,
# so a file that carries the line must keep winning.
emit_compose_wrapper() {
	derive_compose_profiles
	local embed=""
	if ! grep -q '^COMPOSE_PROFILES=' "$ENV_FILE" 2>/dev/null; then
		embed="$COMPOSE_PROFILES_VALUE"
	fi
	if is_standalone_profile "$PROFILE"; then
		# The standalone sets name their services on every up (a name-less
		# `up -d` would start the base file's untagged gateway too); the
		# gateway profiles let the profiles decide the set.
		UP_SERVICES=(chat proxy)
		if [ "${VALUES[IDP_BUNDLED]:-}" = "authelia" ]; then UP_SERVICES+=(authelia); fi
	else
		UP_SERVICES=()
	fi
	if [ "$DRY_RUN" = "1" ]; then
		note "[dry-run] the deploy/compose.sh wrapper a real run would write to $PYSTINO_ROOT/deploy/compose.sh (executable):"
		compose_wrapper_text deploy/.env "$embed" "${OVERLAY_FLAGS[@]}"
	else
		write_compose_wrapper "$PYSTINO_ROOT/deploy/compose.sh" deploy/.env "$embed" "${OVERLAY_FLAGS[@]}"
		note "Wrote $PYSTINO_ROOT/deploy/compose.sh (executable) — ./deploy/compose.sh up|down|logs|ps|build."
	fi
}

# ------------------------------------------------------------------ #
# the four phases                                                     #
# ------------------------------------------------------------------ #

phase_one() { # phase_one <env-file>
	local envfile="$1"
	title "Phase 1 — database, gateway, first credentials"
	local idp_file
	idp_file="$(idp_overlay_file)"
	phase_one_flags
	if [ -n "$idp_file" ]; then
		echo "Starting postgres, valkey, migrations, the gateway, the proxy and the bundled ${VALUES[IDP_BUNDLED]} ..."
		run_compose "$envfile" "${BASE_FLAGS[@]}" up -d "${BUILD_FLAG[@]}" postgres valkey migrate gateway "${VALUES[IDP_BUNDLED]}" ca-bundle proxy
		wait_for_gateway "$envfile" "${BASE_FLAGS[@]}"
		wait_for_idp "$envfile" "${BASE_FLAGS[@]}"
		idp_ca_dance "$envfile" "${BASE_FLAGS[@]}"
		# Discovery is read once at startup — before the trust bundle and
		# the issuer both existed. The restart every bundled install needs
		# anyway picks up both; then the install proceeds as usual.
		echo "Restarting the gateway against the bundled issuer ..."
		run_compose "$envfile" "${BASE_FLAGS[@]}" restart gateway
		wait_for_gateway "$envfile" "${BASE_FLAGS[@]}"
	else
		echo "Starting postgres, valkey, migrations and the gateway ..."
		run_compose "$envfile" "${BASE_FLAGS[@]}" up -d "${BUILD_FLAG[@]}"
		wait_for_gateway "$envfile" "${BASE_FLAGS[@]}"
	fi

	echo ""
	echo "Create the first administrator. The password is prompted for here —"
	echo "it never lands in shell history or in any file."
	if [ -n "${VALUES[IDP_BUNDLED]:-}" ]; then
		# Bundled-IdP shapes seed the admin as the operator's own identity,
		# never admin@local: the first IdP login with this exact email
		# adopts the row (verified claim), so one account is both the SSO
		# admin and the break-glass local login.
		operator_email_for "${VALUES[IDP_BUNDLED]}"
		if [ -z "$ADMIN_EMAIL_VAL" ]; then
			fail "the bundled ${VALUES[IDP_BUNDLED]} shape needs its first human's email to seed the gateway admin (--admin-email for Authelia)."
		fi
		run_compose "$envfile" "${BASE_FLAGS[@]}" exec gateway gateway passwd "$ADMIN_EMAIL_VAL" --admin
	else
		run_compose "$envfile" "${BASE_FLAGS[@]}" exec gateway gateway passwd admin@local
	fi

	ensure_chat_database "$envfile" "${BASE_FLAGS[@]}"

	local port="${VALUES[GATEWAY_PORT]:-8000}"
	printf '\nPhase 1 is up (%shttp://localhost:%s/console%s). Nothing left to mint — the chat boots anonymously against it (ADR 0081).\n' "$CYAN" "$port" "$R"
}

phase_two() { # phase_two <env-file>
	local envfile="$1"
	title "Phase 2 — full stack"
	overlay_flags custom_overlays "$EXPOSURE" "$REDACTION_STATE" "$ST_FETCH"
	append_idp_overlay
	local file_list="${OVERLAY_FLAGS[*]}"
	file_list="${file_list//-f /}"
	echo "Overlay set: $file_list"
	if [ "$BUILD" = "1" ]; then
		echo "Rebuilding images and starting (--build) ..."
	else
		echo "Starting (first run builds any missing image; the browser image is 3.45 GB — pass --build to force a rebuild) ..."
	fi
	run_compose "$envfile" "${OVERLAY_FLAGS[@]}" up -d "${BUILD_FLAG[@]}"
	# The health-gated re-seed (see ensure_bundled_admin): bundled shapes
	# re-check the admin row now that the stack is up, and heal it when the
	# database lost it. Every other shape passes through untouched.
	ensure_bundled_admin "$envfile" "${OVERLAY_FLAGS[@]}"
	printf '\n%sUp.%s Next steps:\n' "$GREEN" "$R"
	echo "  - Chat:      ${VALUES[PUBLIC_ORIGIN]}/chat"
	echo "  - Console:   ${VALUES[PUBLIC_ORIGIN]}/console (or http://localhost:${VALUES[GATEWAY_PORT]:-8000}/console over SSH)"
	if [ "${VALUES[GATEWAY_IDP__ENABLED]:-}" = "true" ]; then
		echo "  - Sign in:   console with the admin account from phase 1 (admin@local unless you added your own); the chat signs in against the house IdP on the same session — no separate chat account exists."
	elif [ -n "${VALUES[IDP_BUNDLED]:-}" ]; then
		local issuer="${VALUES[GATEWAY_OIDC__ISSUER]}" admin_email
		operator_email_for "${VALUES[IDP_BUNDLED]}"
		admin_email="${ADMIN_EMAIL_VAL:-<their email>}"
		echo "  - Sign in:   console and chat both against the bundled ${VALUES[IDP_BUNDLED]} ($issuer) — same session either way, per-user /v1 billing with audience pystino-api."
		if [ "${VALUES[IDP_BUNDLED]}" = "keycloak" ]; then
			printf '  - Directory admin: %s / %s (bootstrap password shown once — store it now; later resets go through the Admin Console at %s/idp/admin/)\n' "${VALUES[KEYCLOAK_ADMIN]}" "${VALUES[KEYCLOAK_ADMIN_PASSWORD]}" "${VALUES[PUBLIC_ORIGIN]}"
		else
			echo "  - Directory admin: ${IDP_ADMIN_USER:-the local admin asked at install} — password asked at install, stored nowhere."
			echo "  - Users:     append a block to deploy/idp/users_database.yml (Authelia hot-reloads it, watch: true) and hash the password with openssl passwd -6."
			echo "  - Roadmap:   an Authelia admin dashboard is roadmap (v4.40+) — user management stays file-based until then."
		fi
		echo "  - Admin:     phase 1 created the local admin $admin_email (--admin); the first ${VALUES[IDP_BUNDLED]} login with this exact email adopts that row (verified claim), so one account is both the SSO identity and the break-glass local password login."
		echo "  - Break-glass: installs made before local linking (or an admin row lost with a recreated database volume) promote by hand:"
		printf '      docker compose --env-file deploy/.env -f deploy/compose/docker-compose.yml exec -T postgres psql -U %s -d %s -c "UPDATE users SET is_admin = true WHERE email = '"'"'%s'"'"';"\n' "${VALUES[POSTGRES_USER]:-gateway}" "${VALUES[POSTGRES_DB]:-gateway}" "$admin_email"
	else
		echo "  - Sign in:   console with the admin account from phase 1, or the SSO door; the chat signs in against ${VALUES[CHAT_OIDC_PROVIDER_URL]:-its provider, once CHAT_OIDC_* is set}."
	fi
	if [ -z "${VALUES[GATEWAY_UPSTREAM__API_KEY]:-}" ]; then
		echo "  - Providers: no upstream key was given, so nothing answers until providers are added in the console."
	else
		echo "  - Providers: add real models in the console — no profile ships a provider, so nothing answers until then."
	fi
	if [ "${VALUES[GATEWAY_OIDC__ENABLED]:-}" = "true" ] && [ -z "${VALUES[GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE]:-}" ]; then
		echo "  - Audience:  /v1 takes API keys only until an access-token audience is set (deploy/.env + gateway restart); the chat's per-user calls wait on it."
	fi
	if [ "${VALUES[GATEWAY_ACCOUNTING__ENABLED]:-}" = "true" ]; then
		echo "  - Quotas: define quota rules in the console; the demo cap pattern is EUR 1/hour."
	else
		echo "  - Ledger: off (passthrough shape). Turning it on later records from that moment — history before it is a gap, not a bug."
	fi
	printf '\n%sBack up GATEWAY_SECRET_KEY with the database now,%s not when you need it.\n' "$YELLOW" "$R"
}

# Databases only: no gateway to wait for and no `gateway passwd` step —
# users live on the central deployment or the third party, not here.
phase_one_standalone() { # phase_one_standalone <env-file>
	local envfile="$1"
	title "Phase 1 — databases only (no gateway on this profile)"
	if [ "${VALUES[IDP_BUNDLED]:-}" = "authelia" ]; then
		# Plus the local directory: Authelia needs no database role, but the
		# proxy must run so the issuer answers (wait_for_idp) and its CA can
		# be trusted (the dance). One up now: the exposure overlays no longer
		# name the gateway as the proxy's dependency, so the named set is
		# exactly what starts — and naming each service auto-activates its
		# compose profile (chat for chat-mongo, authelia for the bundle).
		echo "Starting postgres, chat-mongo, the bundled Authelia and the proxy ..."
		run_compose "$envfile" "${OVERLAY_FLAGS[@]}" up -d "${BUILD_FLAG[@]}" postgres chat-mongo authelia ca-bundle proxy
		wait_for_postgres "$envfile" "${VALUES[POSTGRES_USER]:-chat}" "${OVERLAY_FLAGS[@]}"
		wait_for_idp "$envfile" "${OVERLAY_FLAGS[@]}"
		idp_ca_dance "$envfile" "${OVERLAY_FLAGS[@]}"
		printf 'Chat database: %s (created by initdb as POSTGRES_DB; no role step on this profile)%s\n' "${VALUES[POSTGRES_DB]:-chat}" "$DIM"
		printf '\nPhase 1 is up. %sNo gateway, no admin password%s — sign-in is local (Authelia), models bill the stored central key.\n' "$CYAN" "$R"
		return
	fi
	echo "Starting postgres and chat-mongo ..."
	run_compose "$envfile" "${OVERLAY_FLAGS[@]}" up -d "${BUILD_FLAG[@]}" postgres chat-mongo
	wait_for_postgres "$envfile" "${VALUES[POSTGRES_USER]:-chat}" "${OVERLAY_FLAGS[@]}"
	# The standalone fragments make POSTGRES_USER=chat the initdb superuser
	# and POSTGRES_DB=chat the database initdb already created, so this box
	# needs no role and no second database: the chat connects as the
	# superuser, to the database that has existed since first boot. The
	# role-and-database block the gateway profiles run would only print
	# "CREATE DATABASE chat ... already exists" against it.
	printf 'Chat database: %s (created by initdb as POSTGRES_DB; no role step on this profile)%s\n' "${VALUES[POSTGRES_DB]:-chat}" "$DIM"
	printf '\nPhase 1 is up. %sNo gateway, no admin password, nothing to mint%s — sign-in and models live upstream of this box.\n' "$CYAN" "$R"
}

phase_two_standalone() { # phase_two_standalone <env-file>
	local envfile="$1"
	# No --no-deps and no gateway anywhere: the exposure overlays no longer
	# name the gateway as the proxy's dependency, so naming the services is
	# what keeps "the named set" literally true — `up chat proxy` starts
	# exactly those, and naming chat/authelia auto-activates their compose
	# profiles whatever the .env's COMPOSE_PROFILES line says.
	title "Phase 2 — chat and proxy (no gateway services)"
	local file_list="${OVERLAY_FLAGS[*]}"
	file_list="${file_list//-f /}"
	echo "Overlay set: $file_list"
	local services=(chat proxy)
	if [ "${VALUES[IDP_BUNDLED]:-}" = "authelia" ]; then
		services+=(authelia)
		echo "Service set: chat chat-mongo postgres proxy authelia — databases and the directory already run from phase 1."
	else
		echo "Service set: chat chat-mongo postgres proxy — databases already run from phase 1."
	fi
	if [ "$BUILD" = "1" ]; then
		echo "Rebuilding images and starting (--build) ..."
	else
		echo "Starting (first run builds any missing image; pass --build to force a rebuild) ..."
	fi
	run_compose "$envfile" "${OVERLAY_FLAGS[@]}" up -d "${BUILD_FLAG[@]}" "${services[@]}"
	printf '\n%sUp.%s Next steps:\n' "$GREEN" "$R"
	echo "  - Chat:      ${VALUES[PUBLIC_ORIGIN]}/chat"
	if [ "$PROFILE" = "satellite" ]; then
		echo "  - Models:    managed on central (${VALUES[OPENAI_BASE_URL]}) — nothing answers here until central serves them."
		if [ "${VALUES[IDP_BUNDLED]:-}" = "authelia" ]; then
			echo "  - Users:     local — the bundled Authelia on this box holds the accounts, not central."
			echo "  - Sign in:   the chat signs in against the local Authelia; every call bills the stored central key."
			echo "  - Usage:     hidden — the tab reads central's ledger with the signer's own token, which no longer exists here."
		else
			echo "  - Users:     managed centrally too — this box creates no accounts."
			echo "  - Sign in:   the chat signs in against central; the session it gets is what the Usage tab reads the ledger with."
			echo "  - Usage:     the tab reads central's ledger with each signed-in person's own token."
		fi
	else
		echo "  - Models:    served by the third party (${VALUES[OPENAI_BASE_URL]}) — every call bills the shared key."
		echo "  - Sign in:   the chat signs in against ${VALUES[CHAT_OIDC_PROVIDER_URL]}; nobody signs in anywhere else on this box."
		echo "  - Ledger:    none on this profile. There is no per-user spend to show, which is why the Usage tab stays hidden."
	fi
	printf '\n%sBack up POSTGRES_PASSWORD and CHAT_SECRET_KEY with the database now,%s not when you need it.\n' "$YELLOW" "$R"
}

# ------------------------------------------------------------------ #
# main                                                                #
# ------------------------------------------------------------------ #

# The metadata-vs-flag contradiction check, shared by --phase2 and by a
# flagged fresh run over an existing .env: an installer-written block is the
# install's own record of its shape, so a flag that disagrees is an operator
# mistake to surface, not an override to apply. Both values are shown; one
# is never silently picked.
check_meta_contradictions() { # check_meta_contradictions (reads INSTALLER_META, FLAG_*, COMPONENTS_SPEC)
	[ "$META_PRESENT" = "1" ] || return 0
	if [ -n "$FLAG_PROFILE" ] && [ -n "${INSTALLER_META[INSTALLER_PROFILE]:-}" ] &&
		[ "$FLAG_PROFILE" != "${INSTALLER_META[INSTALLER_PROFILE]}" ]; then
		fail "--profile $FLAG_PROFILE contradicts the installer metadata in $ENV_FILE (INSTALLER_PROFILE=${INSTALLER_META[INSTALLER_PROFILE]}). Re-run with the metadata's value, or delete the .env and re-install fresh."
	fi
	if [ -n "$FLAG_EXPOSURE" ] && [ -n "${INSTALLER_META[INSTALLER_EXPOSURE]:-}" ] &&
		[ "$FLAG_EXPOSURE" != "${INSTALLER_META[INSTALLER_EXPOSURE]}" ]; then
		fail "--exposure $FLAG_EXPOSURE contradicts the installer metadata in $ENV_FILE (INSTALLER_EXPOSURE=${INSTALLER_META[INSTALLER_EXPOSURE]}). Re-run with the metadata's value, or delete the .env and re-install fresh."
	fi
	if [ -n "$FLAG_IDP" ] && [ -n "${INSTALLER_META[INSTALLER_IDP]:-}" ] &&
		[ "$FLAG_IDP" != "${INSTALLER_META[INSTALLER_IDP]}" ]; then
		fail "--idp $FLAG_IDP contradicts the installer metadata in $ENV_FILE (INSTALLER_IDP=${INSTALLER_META[INSTALLER_IDP]}). Re-run with the metadata's value, or delete the .env and re-install fresh."
	fi
	if [ -n "$COMPONENTS_SPEC" ] && [ -n "${INSTALLER_META[INSTALLER_COMPONENTS]:-}" ] &&
		components_differ "$COMPONENTS_SPEC" "${INSTALLER_META[INSTALLER_COMPONENTS]}"; then
		fail "--components $COMPONENTS_SPEC contradicts the installer metadata in $ENV_FILE (INSTALLER_COMPONENTS=${INSTALLER_META[INSTALLER_COMPONENTS]}). Re-run with the metadata's shape, or delete the .env and re-install fresh."
	fi
}

main() {
	parse_install_flags "$@"

	set_build_flag "$BUILD"

	printf '%s\n' ""
	printf '%sCerea + Pystino installer%s\n' "$BOLD" "$R"
	echo "Chat interface plus self-hosted OpenAI-compatible gateway, on one box."
	if [ "$DRY_RUN" = "1" ]; then
		note "Dry run: nothing is run and nothing outside a temp directory is written."
	else
		check_docker
	fi

	resolve_pystino_root
	resolve_chat_repo
	ENV_FILE="$PYSTINO_ROOT/deploy/.env"

	if [ "$PHASE2_ONLY" = "1" ]; then
		if [ ! -f "$ENV_FILE" ]; then
			fail "--phase2 needs $ENV_FILE to exist. Run the full installer first."
		fi
		parse_env_file "$ENV_FILE"
		note "Resuming with $ENV_FILE — existing secrets are kept, none regenerated."
		check_meta_contradictions
		# Profile and exposure: a flag wins (that is the point of the flag),
		# then the metadata block read verbatim, then the prompt — or, in a
		# non-interactive run with neither, the loud missing-decision failure.
		if [ -n "$FLAG_PROFILE" ]; then
			PROFILE="$FLAG_PROFILE"
			note "Profile (--profile): $PROFILE"
		elif [ "$META_PRESENT" = "1" ] && [ -n "${INSTALLER_META[INSTALLER_PROFILE]:-}" ]; then
			PROFILE="${INSTALLER_META[INSTALLER_PROFILE]}"
			note "Profile (installer metadata): $PROFILE"
		elif [ "$NON_INTERACTIVE" = "1" ]; then
			MISSING_DECISIONS=()
			record_missing "profile" "--profile <homelab|team|enterprise|satellite|generic>, or an .env whose installer metadata block names it"
			if [ "$META_PRESENT" != "1" ] || [ -z "${INSTALLER_META[INSTALLER_EXPOSURE]:-}" ]; then
				record_missing "exposure" "--exposure <edge|proxy>, or an .env whose installer metadata block names it"
			fi
			fail_missing_decisions
		else
			ask "Profile this .env was built from (homelab|team|enterprise|satellite|generic)" "homelab"
			PROFILE="$REPLY_VAL"
		fi
		case "$PROFILE" in
			homelab | team | enterprise | satellite | generic) ;;
			*) fail "unknown profile '$PROFILE'." ;;
		esac
		if [ -n "$FLAG_EXPOSURE" ]; then
			EXPOSURE="$FLAG_EXPOSURE"
			note "Exposure (--exposure): $EXPOSURE"
		elif [ "$META_PRESENT" = "1" ] && [ -n "${INSTALLER_META[INSTALLER_EXPOSURE]:-}" ]; then
			EXPOSURE="${INSTALLER_META[INSTALLER_EXPOSURE]}"
			note "Exposure (installer metadata): $EXPOSURE"
		elif [ "$NON_INTERACTIVE" = "1" ]; then
			MISSING_DECISIONS=()
			record_missing "exposure" "--exposure <edge|proxy>, or an .env whose installer metadata block names it"
			fail_missing_decisions
		else
			ask "Exposure (edge|proxy)" "edge"
			EXPOSURE="$REPLY_VAL"
		fi
		case "$EXPOSURE" in
			edge | proxy) ;;
			*) fail "exposure must be edge or proxy." ;;
		esac
		# The shape: the metadata block verbatim when the file carries one
		# (the reason the block exists — the heuristics have mis-inferred
		# shapes live); the legacy infer_* heuristics otherwise.
		if [ "$META_PRESENT" = "1" ] && [ -n "${INSTALLER_META[INSTALLER_COMPONENTS]:-}" ]; then
			apply_metadata_shape
			note "Installer metadata: profile=$PROFILE exposure=$EXPOSURE idp=${INSTALLER_META[INSTALLER_IDP]:-} components=${INSTALLER_META[INSTALLER_COMPONENTS]}"
			if [ -n "$COMPONENTS_SPEC" ]; then
				components_to_shape "$COMPONENTS_SPEC"
				REDACTION_STATE="$ST_REDACTION"
				note "Components overridden (--components): $COMPONENTS_SPEC"
			fi
		elif is_standalone_profile "$PROFILE"; then
			[ -z "$COMPONENTS_SPEC" ] || fail "--components does not apply to standalone profiles ($PROFILE has a fixed component set)."
			# Fixed component set — nothing to infer beyond what the file
			# says. usage is an exact match here (generic writes "false",
			# which the gateway inference would misread as shown).
			infer_standalone_toggles
			note "Standalone profile: fixed component set (no gateway toggles). Re-run the full flow to change values."
		else
			infer_gateway_toggles
			note "Inferred toggles: redaction=$REDACTION_STATE fetch=$ST_FETCH metering=$ST_METERING. Re-run the full flow to change them."
			# The enterprise sign-in shape is inferred the same way: a bundled
			# provider means its shape, external console OIDC means external,
			# house IdP on means house, neither means a custom split someone
			# assembled by hand. (infer_auth_mode in lib/values.sh.)
			if [ "$PROFILE" = "enterprise" ]; then
				infer_auth_mode
			fi
			if [ -n "$COMPONENTS_SPEC" ]; then
				components_to_shape "$COMPONENTS_SPEC"
				REDACTION_STATE="$ST_REDACTION"
				note "Components overridden (--components): $COMPONENTS_SPEC"
			fi
		fi
		if [ -n "$FLAG_IDP" ] && [ "$META_PRESENT" != "1" ]; then
			warn "--idp ignored on resume: $ENV_FILE carries no installer metadata block, so the sign-in shape is inferred from its values."
		fi
		if [ -n "$FLAG_ADMIN_EMAIL" ]; then
			warn "--admin-email ignored on resume: no credentials are collected in phase 2."
		fi
		# Resume keeps every parsed value; CHAT_REPO is re-confirmed below
		# and nothing is regenerated. The bundled shape travels in the file
		# (IDP_BUNDLED); the global mirrors it so required_keys_for sees the
		# same shape as a fresh run.
		IDP_BUNDLED="${PARSED[IDP_BUNDLED]:-}"
		local key
		for key in "${PARSED_ORDER[@]}"; do
			set_value "$key" "${PARSED[$key]}"
		done
		# --set on a resume: applied over the parsed values and re-validated
		# with everything else below. The settable-key filter already ran at
		# parse time, so a derived/generated key cannot sneak in here.
		local pkey n_applied=0
		for pkey in "${!PENDING[@]}"; do
			set_value "$pkey" "${PENDING[$pkey]}"
			n_applied=$((n_applied + 1))
		done
		if [ "$n_applied" -gt 0 ]; then
			PENDING=()
			note "Applied $n_applied --set override(s) over the parsed values."
		fi
	else
		# A fresh run over an existing .env replaces it (with a backup), but
		# a shape decided by flag against a file that carries installer
		# metadata is a contradiction, not an override. Peek read-only, fail
		# loudly on a mismatch, then drop the parse: a fresh run must never
		# inherit the old file's values as prompt defaults.
		if [ -f "$ENV_FILE" ] && { [ -n "$FLAG_PROFILE" ] || [ -n "$FLAG_EXPOSURE" ] || [ -n "$FLAG_IDP" ] || [ -n "$COMPONENTS_SPEC" ]; }; then
			parse_env_file "$ENV_FILE"
			check_meta_contradictions
			reset_parsed_state
		fi
		if [ "$NON_INTERACTIVE" = "1" ]; then
			# The two decisions everything downstream hangs on: fail before
			# any prompt-shaped work when either is absent.
			MISSING_DECISIONS=()
			[ -n "$FLAG_PROFILE" ] || record_missing "profile" "--profile <homelab|team|enterprise|satellite|generic>"
			[ -n "$FLAG_EXPOSURE" ] || record_missing "exposure" "--exposure <edge|proxy>"
			fail_missing_decisions
		fi
		choose_profile
		if is_standalone_profile "$PROFILE"; then
			# No component toggles: without a gateway there is no redaction
			# engine, ledger or fetch backend to choose between — the set is
			# the profile.
			[ -z "$COMPONENTS_SPEC" ] || fail "--components does not apply to standalone profiles ($PROFILE has a fixed component set)."
			REDACTION_STATE="off"
			ST_FETCH="direct"
			ST_METERING=0
			case "$PROFILE" in
				satellite) ST_USAGE=1 ;;
				generic) ST_USAGE=0 ;;
			esac
			ST_CODETOOL=1
			ST_KNOWLEDGE=1
			ST_MEMORY=1
			note "$PROFILE: fixed component set (chat + databases + proxy, direct fetch, no redaction, no local ledger) — no toggles to offer."
		else
			toggle_components "$PROFILE"
			REDACTION_STATE="$ST_REDACTION"
		fi
		choose_exposure
		collect_values "$PROFILE"
		fail_missing_decisions
		fail_unconsumed
		# The compose profiles this shape activates (lib/compose-flags.sh):
		# chat for every profile that ships it, plus the bundled IdP's own.
		# Written as a regular deploy/.env line — compose consumes it
		# natively from --env-file — so the name-less phase-2 `up -d` brings
		# up exactly the shape's set. A gateway-only shape (none today)
		# derives empty and the line is omitted entirely.
		derive_compose_profiles
		if [ -n "$COMPOSE_PROFILES_VALUE" ]; then set_value COMPOSE_PROFILES "$COMPOSE_PROFILES_VALUE"; fi
	fi
	set_value CHAT_REPO "$CHAT_REPO_VAL"
	assert_values_single_line

	# The signing key paths must exist in the value map before validation:
	# the house IdP's key check reads them. On a dry run the temp directory
	# is created here too, so the real checkout is never touched.
	if [ "$PHASE2_ONLY" != "1" ]; then
		if [ "$DRY_RUN" = "1" ]; then
			# mktemp needs the parent to exist, and TMPDIR's default (/tmp)
			# is the one directory a fresh box is guaranteed to have. A
			# deeper template (this once read /tmp/opencode/...) inherits a
			# convention this machine happens to have and nothing else does.
			TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cerea-install-dryrun.XXXXXX")"
			IDP_KEY_PATH="$TMP_DIR/idp-signing-key.pem"
			ENV_OUT="$TMP_DIR/deploy.env"
		else
			IDP_KEY_PATH="$PYSTINO_ROOT/deploy/idp-signing-key.pem"
			ENV_OUT="$ENV_FILE"
		fi
		# The file pair the house IdP boots from, wherever it is on. The
		# validator below reads these; external-only enterprise and the
		# standalone profiles skip them — no house IdP, no key, nothing
		# to mount (the compose file mounts /dev/null in that case).
		if [ "${VALUES[GATEWAY_IDP__ENABLED]:-}" = "true" ] && ! is_standalone_profile "$PROFILE"; then
			set_value IDP_SIGNING_KEY_HOST_PATH "$IDP_KEY_PATH"
			set_value GATEWAY_IDP__SIGNING_KEY_FILE "/run/idp/signing-key.pem"
		fi
	fi

	required_keys_for "$PROFILE" "$EXPOSURE"
	validate_values "$PROFILE" VALUES

	if [ "$PHASE2_ONLY" = "1" ]; then
		build_scrub "$ENV_FILE"
		check_idp_files
		if is_standalone_profile "$PROFILE"; then
			standalone_overlay_flags "$EXPOSURE" "${VALUES[IDP_BUNDLED]:-}"
			phase_two_standalone "$ENV_FILE"
		else
			phase_two "$ENV_FILE"
		fi
		emit_compose_wrapper
		if [ "$DRY_RUN" = "1" ]; then
			title "Dry run complete"
			echo "Nothing was run; the existing $ENV_FILE was only read."
		fi
		return
	fi

	show_review
	if [ "$DRY_RUN" = "1" ]; then
		local key
		note ""
		note "Generated secret values (dry-run throwaways — a real run keeps them behind a confirm):"
		for key in "${VALUES_ORDER[@]}"; do
			case "$key" in
				POSTGRES_PASSWORD | GATEWAY_SECRET_KEY | GATEWAY_SESSION_SECRET | REDACTION_PLACEHOLDER_KEY | GATEWAY_IDP__INTERNAL_TOKEN | CHAT_IDP_CLIENT_SECRET | CHAT_SECRET_KEY | CHAT_PG_PASSWORD)
					printf '  %s=%s\n' "$key" "${VALUES[$key]}"
					;;
			esac
		done
		# Bundled-only mints, printed only when set (external shapes paste
		# these instead, and pasted secrets are never shown back).
		if [ -n "${VALUES[IDP_BUNDLED]:-}" ]; then
			for key in GATEWAY_OIDC__CLIENT_SECRET CHAT_OIDC_CLIENT_SECRET IDP_SESSION_SECRET IDP_HMAC_SECRET IDP_STORAGE_KEY IDP_CONSOLE_CLIENT_SECRET KEYCLOAK_ADMIN KEYCLOAK_ADMIN_PASSWORD; do
				if [ -n "${VALUES[$key]:-}" ]; then
					printf '  %s=%s\n' "$key" "${VALUES[$key]}"
				fi
			done
		fi
	else
		confirm "Show generated secret values once (they live in deploy/.env afterwards)?" 0
		if [ "$CONFIRM_VAL" = "1" ]; then
			local key
			for key in "${VALUES_ORDER[@]}"; do
				case "$key" in
					POSTGRES_PASSWORD | GATEWAY_SECRET_KEY | GATEWAY_SESSION_SECRET | REDACTION_PLACEHOLDER_KEY | GATEWAY_IDP__INTERNAL_TOKEN | CHAT_IDP_CLIENT_SECRET | CHAT_SECRET_KEY | CHAT_PG_PASSWORD)
						printf '  %s=%s\n' "$key" "${VALUES[$key]}"
						;;
				esac
			done
			if [ -n "${VALUES[IDP_BUNDLED]:-}" ]; then
				for key in GATEWAY_OIDC__CLIENT_SECRET CHAT_OIDC_CLIENT_SECRET IDP_SESSION_SECRET IDP_HMAC_SECRET IDP_STORAGE_KEY IDP_CONSOLE_CLIENT_SECRET KEYCLOAK_ADMIN KEYCLOAK_ADMIN_PASSWORD; do
					if [ -n "${VALUES[$key]:-}" ]; then
						printf '  %s=%s\n' "$key" "${VALUES[$key]}"
					fi
				done
			fi
			printf '  CHAT_PG_URL=%s\n' "${VALUES[CHAT_PG_URL]}"
		fi
		confirm "Write $ENV_FILE?" 1
		if [ "$CONFIRM_VAL" = "0" ]; then
			fail "not written. Re-run when ready — nothing was changed."
		fi
		if [ -f "$ENV_FILE" ]; then
			local backup="${ENV_FILE}.bak-$(date +%Y-%m-%dT%H-%M-%S)"
			cp "$ENV_FILE" "$backup"
			note "Existing file backed up to $backup."
		fi
	fi

	# The signing key is written before the .env that points at it — wherever
	# the house IdP is on (homelab, team, enterprise-house). Standalone
	# profiles and external-only enterprise have no house IdP, so no key.
	if [ "${VALUES[GATEWAY_IDP__ENABLED]:-}" = "true" ] && ! is_standalone_profile "$PROFILE"; then
		gen_signing_key "$IDP_KEY_PATH"
		if [ "$DRY_RUN" = "1" ]; then
			note "[dry-run] a throwaway signing key is at $IDP_KEY_PATH — a real run writes it to $PYSTINO_ROOT/deploy/idp-signing-key.pem (chmod 600)"
		fi
	fi

	# The bundled provider's files, before the .env that names them —
	# Keycloak imports the realm at first boot only, so the JSON must exist
	# before phase 1 starts anything.
	if [ -n "${VALUES[IDP_BUNDLED]:-}" ]; then
		if [ "$DRY_RUN" = "1" ]; then
			generate_idp_files "$TMP_DIR/idp"
			note "[dry-run] throwaway IdP files are under $TMP_DIR/idp — a real run writes them to $PYSTINO_ROOT/deploy/idp/ (mode 600, never committed)"
		else
			generate_idp_files "$PYSTINO_ROOT/deploy/idp"
		fi
	fi

	local tmp_env="$ENV_OUT"
	if [ "$DRY_RUN" != "1" ]; then tmp_env="$ENV_FILE.installing.$$"; fi
	build_env_file "$PYSTINO_ROOT/deploy/profiles/$(profile_fragment "$PROFILE")" >"$tmp_env"
	chmod 600 "$tmp_env"
	# Re-validate against what was actually built: the fragment could carry a
	# key the value map never saw, and the fail-closed guards exist for the
	# file, not for the memory of it.
	parse_env_file "$tmp_env"
	VALUES_ORDER=()
	VALUES=()
	local key
	for key in "${PARSED_ORDER[@]}"; do
		set_value "$key" "${PARSED[$key]}"
	done
	required_keys_for "$PROFILE" "$EXPOSURE"
	validate_values "$PROFILE" VALUES
	if [ "$DRY_RUN" = "1" ]; then
		ENV_FILE="$tmp_env"
	else
		mv -f "$tmp_env" "$ENV_FILE"
		echo "Wrote $ENV_FILE (mode 600)."
	fi

	build_scrub "$ENV_FILE"

	# Compose refuses a file whose required interpolation is missing — run
	# the parse now, against the real overlay set, so a dry run proves the
	# .env composes before anything is started. Needs no daemon, and is
	# skipped when docker is absent rather than failing the dry run on it.
	if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
		if is_standalone_profile "$PROFILE"; then
			standalone_overlay_flags "$EXPOSURE" "${VALUES[IDP_BUNDLED]:-}"
		else
			overlay_flags custom_overlays "$EXPOSURE" "$REDACTION_STATE" "$ST_FETCH"
			append_idp_overlay
		fi
		# The derivation needed CHAT_REPO for the playwright overlay; the
		# scrub for the parse check must keep it (it is re-supplied as an
		# explicit assignment instead of being left to the shell).
		scrub_keep CHAT_REPO
		local -a check_cmd=("${SCRUB_KEEP[@]}" -u GATEWAY_PORT CHAT_REPO="$CHAT_REPO_VAL" docker)
		if ! (cd "$PYSTINO_ROOT" && "${check_cmd[@]}" compose --env-file "$ENV_FILE" "${OVERLAY_FLAGS[@]}" config --quiet); then
			fail "docker compose refuses the generated environment (see the message above)."
		fi
		if [ "$DRY_RUN" = "1" ]; then
			note "[dry-run] docker compose config --quiet accepted the generated .env against the overlay set."
		fi
		# The transition hazard P1 flagged, checked where it would bite: a
		# fresh install whose COMPOSE_PROFILES line failed to land would
		# compose without the chat/IdP services. config --services lists the
		# ACTIVE model — assert every profile-activated service is in it
		# (the parse check above proved the file parses; this proves the
		# profiles took). Runs with no --profile flags: the env-file line is
		# the mechanism under test.
		if [ -n "${COMPOSE_PROFILES_VALUE:-}" ]; then
			local need=() prof svc
			for prof in ${COMPOSE_PROFILES_VALUE//,/ }; do
				case "$prof" in
					chat) need+=(chat chat-mongo) ;;
					authelia) need+=(authelia ca-bundle) ;;
					keycloak) need+=(keycloak ca-bundle) ;;
				esac
			done
			local services_out
			if ! services_out="$(cd "$PYSTINO_ROOT" && "${check_cmd[@]}" compose --env-file "$ENV_FILE" "${OVERLAY_FLAGS[@]}" config --services)"; then
				fail "docker compose config --services failed (see the message above)."
			fi
			for svc in "${need[@]}"; do
				if ! printf '%s\n' "$services_out" | grep -qx "$svc"; then
					fail "the compose model is missing '$svc' — COMPOSE_PROFILES did not activate its profile (services: $(printf '%s' "$services_out" | tr '\n' ' '))."
				fi
			done
			if [ "$DRY_RUN" = "1" ]; then
				note "[dry-run] docker compose config --services shows the profile-activated set: ${need[*]}."
			fi
		fi
		# Bundled gateway profiles bring up a smaller set in phase 1 (base +
		# exposure + IdP, plus redaction for its variables when the engine
		# is not noop); prove that set parses too, not just the full one —
		# the same set phase_one_flags builds for phase 1 itself.
		if [ -n "${VALUES[IDP_BUNDLED]:-}" ] && ! is_standalone_profile "$PROFILE"; then
			phase_one_flags
			if ! (cd "$PYSTINO_ROOT" && "${check_cmd[@]}" compose --env-file "$ENV_FILE" "${BASE_FLAGS[@]}" config --quiet); then
				fail "docker compose refuses the phase-1 set (see the message above)."
			fi
			if [ "$DRY_RUN" = "1" ]; then
				note "[dry-run] docker compose config --quiet accepted the phase-1 set (base + exposure + bundled ${VALUES[IDP_BUNDLED]})."
			fi
		fi
	fi

	if [ -n "${VALUES[IDP_BUNDLED]:-}" ]; then
		ensure_edge_idp_route
	fi
	if is_standalone_profile "$PROFILE"; then
		standalone_overlay_flags "$EXPOSURE" "${VALUES[IDP_BUNDLED]:-}"
		phase_one_standalone "$ENV_FILE"
		phase_two_standalone "$ENV_FILE"
	else
		phase_one "$ENV_FILE"
		phase_two "$ENV_FILE"
	fi
	# The recorded command line, last: the wrapper describes the deployment
	# as it now stands (the phase-2 shape), written for real, printed on a
	# dry run.
	emit_compose_wrapper

	if [ "$DRY_RUN" = "1" ]; then
		title "Dry run complete"
		echo "The .env that would have been written: $ENV_OUT (mode 600)"
		echo "Nothing was run, and nothing outside $TMP_DIR was touched."
		echo "Delete it with: rm -rf $TMP_DIR"
	fi
}

main "$@"
