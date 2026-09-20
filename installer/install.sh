#!/usr/bin/env bash
#
# The Cerea + Pystino installer: the main entry point for a new deployment.
#
# Zero runtime dependencies beyond bash, coreutils, openssl, git and docker —
# no node on the host, no container wrapping the installer. Run it against a
# fresh clone:
#
#   ./installer/install.sh [--pystino <path>] [--phase2] [--dry-run]
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

DRY_RUN=0
PHASE2_ONLY=0
CLI_PYSTINO=""
# Enterprise sign-in shape: house (gateway's own issuer, no external
# provider), external (one provider for gateway console and chat), custom
# (each side configured separately, or left for later). Set during collect,
# inferred from the file on --phase2.
AUTH_MODE=""

# ------------------------------------------------------------------ #
# small terminal kit: ANSI colors, prompts, messages                  #
# ------------------------------------------------------------------ #

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

trap 'printf "\nAborted. Nothing was changed beyond what the transcript above says.\n" >&2' INT

input_ended() {
	fail "input ended unexpectedly. Re-run interactively; nothing was written unless the transcript above says so."
}

# Trim leading and trailing whitespace (the bash parameter-expansion idiom;
# no external tool, so a value with backslashes survives untouched).
trim() {
	local s="$1"
	s="${s#"${s%%[![:space:]]*}"}"
	s="${s%"${s##*[![:space:]]}"}"
	REPLY_VAL="$s"
}

# One line of input, from a TTY or a pipe. On a TTY this is plain read; off
# one, the answer is echoed back for transcript fidelity (a piped answer is
# otherwise invisible in the transcript). EOF with nothing buffered is fatal,
# never a silent exit 0 mid-flow — mirrors the node installer's rule.
ask() { # ask <prompt> [default] -> REPLY_VAL
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

usage() {
	echo "Usage: ./installer/install.sh [--pystino <path>] [--phase2] [--dry-run]"
	echo "  --phase2   resume against an existing deploy/.env (full bring-up)"
	echo "  --dry-run  resolve everything, write the .env to a temp path, print"
	echo "             the exact docker compose command lines, run nothing"
}

# ------------------------------------------------------------------ #
# profiles, components, footprints                                    #
# ------------------------------------------------------------------ #

# Measured on the live host, September 2026 (docker stats, docker images).
# RSS first, image size second. Shown at selection time so an operator sees
# what each component costs before paying it.
declare -A P_BLURB P_FOOTPRINT
P_BLURB[homelab]="Single box. No ledger, no redaction, local sign-in + house IdP."
P_FOOTPRINT[homelab]="~625 MB RSS, ~3.8 GB disk, 2 vCPU"
P_BLURB[team]="Homelab plus accountability: ledger, quotas, pattern-only redaction."
P_FOOTPRINT[team]="homelab +~300 MB RSS (pattern-only redaction + local extractor)"
P_BLURB[enterprise]="Everything: NER redaction, browser fetch, external OIDC, per-group billing."
P_FOOTPRINT[enterprise]="team +~750 MB RSS (NER), +3.45 GB disk for the browser"
P_BLURB[satellite]="Chat against a central Pystino: users and ledger live there, this box holds chat + databases only."
P_FOOTPRINT[satellite]="~400 MB RSS, ~2.5 GB disk, 1 vCPU (estimate — not yet weighed on a live host)"
P_BLURB[generic]="Chat against any OpenAI-compatible third party: shared key, no user tokens, no ledger."
P_FOOTPRINT[generic]="~400 MB RSS, ~2.5 GB disk, 1 vCPU (estimate — not yet weighed on a live host)"

PROFILE_KEYS=(homelab team enterprise satellite generic)

is_standalone_profile() {
	case "$1" in
		satellite | generic) return 0 ;;
		*) return 1 ;;
	esac
}

profile_fragment() {
	case "$1" in
		homelab) echo "homelab.env" ;;
		team) echo "team.env" ;;
		enterprise) echo "enterprise.env" ;;
		satellite) echo "satellite.env" ;;
		generic) echo "generic.env" ;;
		*) fail "unknown profile '$1'" ;;
	esac
}

# ------------------------------------------------------------------ #
# secrets                                                             #
# ------------------------------------------------------------------ #

# secrets.token_urlsafe(n): urlsafe base64 without padding, n random bytes.
# openssl rand -base64 emits padded standard base64 with line wraps; strip
# the padding and translate the alphabet, and the entropy is identical.
token_url_safe() { # token_url_safe <n-bytes> -> TOKEN_VAL
	TOKEN_VAL="$(openssl rand -base64 "$1" | tr -d '\n=' | tr '+/' '-_')"
}

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
# the value store: every value single-line, insertion order kept       #
# ------------------------------------------------------------------ #

declare -A VALUES=()
VALUES_ORDER=()

# Filled by parse_env_file; declared here so `${PARSED[key]:-}` is safe
# before the first parse (fresh installs never parse anything).
declare -A PARSED=()
PARSED_ORDER=()

set_value() { # set_value <key> <value>
	local key="$1" value="$2"
	if [ -z "${VALUES[$key]+x}" ]; then
		VALUES_ORDER+=("$key")
	fi
	VALUES[$key]="$value"
}

# The whole design rests on deploy/.env being line-oriented: one variable,
# one line, no continuations. A multi-line value here means the signing key
# leaked back in as an inline PEM — refuse rather than write a file the
# resume parser would misread.
assert_values_single_line() {
	local key value
	for key in "${VALUES_ORDER[@]}"; do
		value="${VALUES[$key]}"
		case "$value" in
			*$'\n'* | *$'\r'*)
				fail "$key would be written with a line break; every value in deploy/.env must be single-line."
				;;
		esac
	done
}

# ------------------------------------------------------------------ #
# .env assembly: profile fragment as the base, overrides on top       #
# ------------------------------------------------------------------ #

# The fragment stays the single source of defaults: its lines (comments
# included) pass through, overridden keys are replaced in place, and keys
# the fragment never had are appended under an installer section. With every
# value single-line this is one pass with no continuation tracking — the
# multi-line span rule the node installer carried existed for exactly one
# variable (the inline signing PEM), and the key is a file now.
build_env_file() { # build_env_file <fragment-path>  (env content on stdout)
	local fragment="$1" line key
	declare -A SEEN=()
	while IFS= read -r line || [ -n "$line" ]; do
		key=""
		case "$line" in
			[A-Za-z_]*=*)
				key="${line%%=*}"
				if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && [ -n "${VALUES[$key]+x}" ]; then
					SEEN[$key]=1
					printf '%s=%s\n' "$key" "${VALUES[$key]}"
					continue
				fi
				;;
		esac
		printf '%s\n' "$line"
	done <"$fragment"
	local missing=0 key2
	for key2 in "${VALUES_ORDER[@]}"; do
		if [ -z "${SEEN[$key2]+x}" ]; then
			if [ "$missing" = "0" ]; then
				printf '\n'
				printf '# --- installer additions ------------------------------------------------------\n'
				printf '# Values for toggles this fragment never had (a deviated component choice),\n'
				printf '# or names the fragment predates: the IdP signing key travels as a file, and\n'
				printf '# the standalone profiles carry parse-only gateway secrets (no gateway runs\n'
				printf '# on these profiles, but the base compose file refuses to interpolate\n'
				printf '# without them — even `docker compose logs` would fail against this .env).\n'
				missing=1
			fi
			printf '%s=%s\n' "$key2" "${VALUES[$key2]}"
		fi
	done
}

# Parse KEY=VALUE lines back (resume only; the file is never rewritten from
# this). Blank lines, comments and a stray multi-line PEM (a legacy file
# from before the key became a path) are handled: continuation lines attach
# to the current key, and a PEM END marker belongs to the value and closes
# it. One layer of matching surrounding quotes is stripped, so a hand-edited
# USE_USER_TOKEN="true" is read the way compose would read it.
parse_env_file() { # parse_env_file <path>
	local line trimmed current="" key value
	PARSED_ORDER=()
	declare -gA PARSED=()
	while IFS= read -r line || [ -n "$line" ]; do
		trimmed="${line#"${line%%[![:space:]]*}"}"
		case "$trimmed" in
			"" | \#*)
				current=""
				continue
				;;
		esac
		if [[ "$trimmed" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
			current="${BASH_REMATCH[1]}"
			value="${BASH_REMATCH[2]}"
			if [ -z "${PARSED[$current]+x}" ]; then PARSED_ORDER+=("$current"); fi
			PARSED[$current]="$value"
		elif [ -n "$current" ]; then
			case "$trimmed" in
				-----END*)
					PARSED[$current]+=$'\n'"$trimmed"
					current=""
					;;
				*)
					PARSED[$current]+=$'\n'"$trimmed"
					;;
			esac
		else
			current=""
		fi
	done <"$1"
	# Quote stripping, after the fact so continuation assembly is raw.
	local key2
	for key2 in "${PARSED_ORDER[@]}"; do
		value="${PARSED[$key2]}"
		if [ "${#value}" -ge 2 ]; then
			case "$value" in
				\"*\" | \'*\')
					value="${value:1:${#value}-2}"
					PARSED[$key2]="$value"
					;;
			esac
		fi
	done
}

# ------------------------------------------------------------------ #
# validation: fail closed before anything is written or started       #
# ------------------------------------------------------------------ #

is_absolute_url() { # -> 0 when $1 is an absolute http(s) URL
	[[ "${1:-}" =~ ^https?://[^[:space:]]+$ ]]
}

# Every name here must be non-empty in the final .env, or the installer
# stops with the list instead of a compose error three layers down.
required_keys_for() { # required_keys_for <profile> <exposure>  -> REQUIRED[]
	local profile="$1" exposure="$2"
	REQUIRED=()
	if is_standalone_profile "$profile"; then
		# No gateway on these profiles, so no gateway runtime keys — but the
		# two parse-only secrets ARE required: the base compose file refuses
		# to interpolate without them (see the installer-additions comment in
		# build_env_file). CHAT_IDP_CLIENT_SECRET is minted anyway — the chat
		# overlay's OPENID_CLIENT_SECRET default chain names it, and a
		# missing name fails compose parsing whether or not the branch is
		# taken.
		REQUIRED+=(POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET
			OPENAI_BASE_URL CHAT_PG_URL CHAT_IDP_CLIENT_SECRET CHAT_SECRET_KEY
			CHAT_OIDC_PROVIDER_URL CHAT_OIDC_CLIENT_ID CHAT_OIDC_CLIENT_SECRET
			CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN)
		if [ "$profile" = "generic" ]; then REQUIRED+=(OPENAI_API_KEY); fi
		if [ "$exposure" = "proxy" ]; then REQUIRED+=(ACME_EMAIL); fi
		return
	fi
	REQUIRED+=(POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET
		CHAT_PG_URL CHAT_IDP_CLIENT_SECRET
		CHAT_SECRET_KEY CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN)
	# GATEWAY_UPSTREAM__BASE_URL and __API_KEY are deliberately absent: an
	# empty key is a supported shape (providers come from the console
	# later), and an empty base URL falls back to the compose default.
	if [ "${REDACTION_STATE}" != "off" ]; then REQUIRED+=(REDACTION_PLACEHOLDER_KEY); fi
	if [ "$profile" = "enterprise" ]; then
		# What must be non-empty depends on the sign-in shape the operator
		# picked: external names both OIDC clients, house names the house
		# IdP's two values, custom requires nothing (each side was asked
		# optionally, and whatever stayed empty is console work later).
		case "${AUTH_MODE:-external}" in
			house)
				REQUIRED+=(GATEWAY_IDP__ISSUER GATEWAY_IDP__INTERNAL_TOKEN)
				;;
			custom) ;;
			*)
				REQUIRED+=(GATEWAY_OIDC__ISSUER GATEWAY_OIDC__CLIENT_ID
					GATEWAY_OIDC__CLIENT_SECRET CHAT_OIDC_PROVIDER_URL CHAT_OIDC_CLIENT_ID
					CHAT_OIDC_CLIENT_SECRET)
				;;
		esac
	else
		# The signing key is deliberately absent from this list: it arrives as
		# a file (fresh installs) or inline (legacy resumes), and
		# validate_values checks the two shapes below rather than a name.
		REQUIRED+=(GATEWAY_IDP__ISSUER GATEWAY_IDP__INTERNAL_TOKEN)
	fi
	if [ "$exposure" = "proxy" ]; then REQUIRED+=(ACME_EMAIL); fi
}

validate_values() { # validate_values <profile> <values-name>
	local profile="$1"
	local -n vals="$2"
	local missing="" key value
	for key in "${REQUIRED[@]}"; do
		value="${vals[$key]:-}"
		trim "$value"
		if [ -z "$REPLY_VAL" ]; then missing="${missing:+$missing, }$key"; fi
	done
	if [ -n "$missing" ]; then
		fail "refusing to continue with empty required values: $missing"
	fi
	# The house IdP's issuer must be absolute, and its signing key must exist
	# in exactly one of the two shapes: inline (legacy resumes) or as the
	# file pair this installer writes. Both together are refused at gateway
	# startup; refusing here moves that refusal before anything is written.
	if [ "${vals[GATEWAY_IDP__ENABLED]:-}" = "true" ]; then
		if ! is_absolute_url "${vals[GATEWAY_IDP__ISSUER]:-}"; then
			fail "GATEWAY_IDP__ISSUER must be an absolute http(s) URL when the house IdP is on."
		fi
		local inline="${vals[GATEWAY_IDP__SIGNING_KEY]:-}"
		local host_path="${vals[IDP_SIGNING_KEY_HOST_PATH]:-}"
		local file_var="${vals[GATEWAY_IDP__SIGNING_KEY_FILE]:-}"
		if [ -n "$inline" ] && { [ -n "$host_path" ] || [ -n "$file_var" ]; }; then
			fail "set GATEWAY_IDP__SIGNING_KEY or GATEWAY_IDP__SIGNING_KEY_FILE, not both (the gateway refuses to start with both)."
		fi
		if [ -z "$inline" ] && { [ -z "$host_path" ] || [ -z "$file_var" ]; }; then
			fail "the house IdP needs a signing key: GATEWAY_IDP__SIGNING_KEY inline (legacy) or IDP_SIGNING_KEY_HOST_PATH + GATEWAY_IDP__SIGNING_KEY_FILE (this installer)."
		fi
	fi
	# An external OIDC issuer, when one is named, must be absolute: the
	# gateway discovers against it at boot, and a relative value fails
	# there instead of here.
	if [ "${vals[GATEWAY_OIDC__ENABLED]:-}" = "true" ] && [ -n "${vals[GATEWAY_OIDC__ISSUER]:-}" ] && ! is_absolute_url "${vals[GATEWAY_OIDC__ISSUER]}"; then
		fail "GATEWAY_OIDC__ISSUER must be an absolute http(s) URL."
	fi
	is_standalone_profile "$profile" || return 0
	if ! is_absolute_url "${vals[OPENAI_BASE_URL]:-}"; then
		fail "OPENAI_BASE_URL must be an absolute http(s) URL."
	fi
	# SAFETY, enforced not defaulted: a stored key would bill an entire site
	# to one account, and user-token mode would send the signed-in person's
	# IdP access token out as a Bearer to the third party — a credential
	# leak. No toggle exists for either; the guards run against whatever is
	# in the file, fresh or resumed.
	if [ "$profile" = "satellite" ]; then
		trim "${vals[OPENAI_API_KEY]:-}"
		if [ -n "$REPLY_VAL" ]; then
			fail "satellite sets no OPENAI_API_KEY: the catalogue fetch is public (ADR 0081) and every real call carries the user's own token — a stored key would bill every user to one account."
		fi
	fi
	if [ "$profile" = "generic" ] && [ "${vals[USE_USER_TOKEN]:-}" = "true" ]; then
		fail "generic forces USE_USER_TOKEN=false: user-token mode would send the signed-in person's IdP access token out as a Bearer to the third party."
	fi
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
	while :; do
		ask "Path to the Pystino checkout" "$guess"
		local answer="$REPLY_VAL" resolved
		answer="${answer/#\~/$HOME}"
		resolved="$(cd "$answer" 2>/dev/null && pwd)" || resolved=""
		if [ -z "$resolved" ]; then
			confirm "That path does not exist. Clone the internal fork there?" 1
			if [ "$CONFIRM_VAL" = "0" ]; then continue; fi
			ask "Repository URL" "$INTERNAL_FORK"
			local url="$REPLY_VAL"
			echo "Cloning $url ..."
			if ! git clone "$url" "$answer"; then
				warn "Clone failed. Check the URL and your access, then try again."
				continue
			fi
			resolved="$(cd "$answer" && pwd)"
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
	done
}

resolve_chat_repo() { # -> CHAT_REPO_VAL
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

# House IdP values, shared by team/homelab and enterprise-house: the issuer
# is this deployment's own origin, the internal base keeps token exchanges
# on the compose network, and the client registry carries the minted chat
# secret (the fragment ships it empty; the fragment's own contract says the
# two must match). The signing key itself arrives as a file — main writes
# the two path variables plus the PEM after confirm. Callers mint
# GATEWAY_IDP__INTERNAL_TOKEN themselves, beside their other secrets, and
# own the GATEWAY_OIDC__ENABLED flag: team and enterprise-house turn the
# console's external door off, but a custom split may keep both doors open.
set_house_idp_values() {
	set_value GATEWAY_IDP__ENABLED "true"
	set_value GATEWAY_IDP__ISSUER "${VALUES[PUBLIC_ORIGIN]}"
	set_value GATEWAY_IDP__INTERNAL_BASE_URL "http://gateway:8000"
	set_value GATEWAY_IDP__CLIENTS "[{\"client_id\":\"cerea\",\"redirect_path\":\"/chat/login/callback\",\"secret\":\"${VALUES[CHAT_IDP_CLIENT_SECRET]}\"}]"
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

# Fresh installs generate everything generatable; the asked-for values come
# after, so the operator meets each one while the consequence is on screen.
collect_values() { # collect_values <profile>
	local profile="$1" standalone=0
	is_standalone_profile "$profile" && standalone=1

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
		if [ "$profile" != "enterprise" ]; then
			# The signing key: a PEM at <pystino>/deploy/idp-signing-key.pem,
			# written once the operator confirms the write (a dry run keeps a
			# throwaway sample beside its temp .env). Two single-line names,
			# never an inline PEM.
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
			ask_required "Central Pystino public origin (e.g. https://central.example)"
			local central="$REPLY_VAL"
			while [ "${central%/}" != "$central" ]; do central="${central%/}"; done
			if ! is_absolute_url "$central"; then
				fail "The central origin must be an absolute http(s) URL."
			fi
			set_value OPENAI_BASE_URL "$central/v1"
			# Nothing is minted and nothing is stored: the catalogue fetch
			# reads central's public GET /v1/models (ADR 0081), and every
			# real call carries the signed-in person's own token.
			unset 'VALUES[OPENAI_API_KEY]'
			set_value USE_USER_TOKEN "true"
			set_value CHAT_USAGE_ENABLED "true"
			set_value FETCH_BACKEND "direct"
			title "Central identity provider"
			note "The chat is its own client at the central provider — register <this deployment's origin>/chat/login/callback there. All three are mandatory: without them nobody can sign in."
			ask_required "OIDC issuer (defaults to the central origin)" "$central"
			set_value CHAT_OIDC_PROVIDER_URL "$REPLY_VAL"
			ask_required "Chat client id at the provider" "cerea"
			set_value CHAT_OIDC_CLIENT_ID "$REPLY_VAL"
			ask_hidden "Chat client secret"
			while [ -z "$REPLY_VAL" ]; do
				printf '%sThe chat cannot sign anyone in without its client secret.%s\n' "$YELLOW" "$R"
				ask_hidden "Chat client secret"
			done
			set_value CHAT_OIDC_CLIENT_SECRET "$REPLY_VAL"
			ask "Chat OIDC scopes" "openid profile email"
			set_value CHAT_OIDC_SCOPES "$REPLY_VAL"
		else
			title "Third-party backend"
			ask_required "Backend base URL (OpenAI-compatible, e.g. https://api.example.com/v1)"
			if ! is_absolute_url "$REPLY_VAL"; then
				fail "The backend base URL must be an absolute http(s) URL."
			fi
			set_value OPENAI_BASE_URL "$REPLY_VAL"
			ask_hidden "Shared API key (pays for every call — cannot be generated)"
			while [ -z "$REPLY_VAL" ]; do
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
			ask "OCR base URL (empty to skip, e.g. https://api.mistral.ai/v1)"
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
				set_value CHAT_OCR_BASE_URL "$REPLY_VAL"
				# Required once a URL is named: there is no catalogue to
				# discover a reader from, and the chat refuses to start with
				# one set without the other. Better to fail here than at
				# boot.
				ask_required "OCR model name" "mistral-ocr-latest"
				set_value CHAT_OCR_MODEL "$REPLY_VAL"
				ask_hidden "OCR API key (empty if unauthenticated)"
				set_value CHAT_OCR_API_KEY "$REPLY_VAL"
				note "This path reads PDFs only — Office formats (.docx/.xlsx/.pptx/.odt/.epub) still need a gateway reader."
			fi
			title "Identity provider"
			note "Sign-in still needs a provider — an anonymous deployment answers nobody. All three are mandatory."
			ask_required "OIDC issuer"
			set_value CHAT_OIDC_PROVIDER_URL "$REPLY_VAL"
			ask_required "Chat client id at the provider" "cerea"
			set_value CHAT_OIDC_CLIENT_ID "$REPLY_VAL"
			ask_hidden "Chat client secret"
			while [ -z "$REPLY_VAL" ]; do
				printf '%sThe chat cannot sign anyone in without its client secret.%s\n' "$YELLOW" "$R"
				ask_hidden "Chat client secret"
			done
			set_value CHAT_OIDC_CLIENT_SECRET "$REPLY_VAL"
			ask "Chat OIDC scopes" "openid profile email"
			set_value CHAT_OIDC_SCOPES "$REPLY_VAL"
			ask "Admin usernames (comma-separated, optional)"
			set_value ADMIN_USERNAMES "$REPLY_VAL"
		fi
	else
	ask "Upstream OpenAI-compatible base URL" "${PARSED[GATEWAY_UPSTREAM__BASE_URL]:-https://api.cortecs.ai/v1}"
	set_value GATEWAY_UPSTREAM__BASE_URL "$REPLY_VAL"
	ask_hidden "Upstream API key (empty to skip — providers are added in the console later)"
	set_value GATEWAY_UPSTREAM__API_KEY "$REPLY_VAL"
	if [ -z "$REPLY_VAL" ]; then
		note "No upstream key: the gateway boots fine but answers nothing until a provider is configured in the console."
	fi
	fi

	if [ "$EXPOSURE" = "edge" ]; then
		ask_required "Public hostname browsers use (the edge terminates TLS for it)"
		set_value PUBLIC_HOST "$REPLY_VAL"
		ask "Edge forward port on this box" "8443"
		set_value HTTPS_PORT "$REPLY_VAL"
		set_value TLS_DIRECTIVE "tls internal"
	else
		ask_required "Public host — IP for self-signed, FQDN for Let's Encrypt"
		set_value PUBLIC_HOST "$REPLY_VAL"
		local looks_ip=0
		[[ "${VALUES[PUBLIC_HOST]}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && looks_ip=1
		if [ "$looks_ip" = "1" ]; then
			ask "HTTPS port" "8443"
		else
			ask "HTTPS port" "443"
		fi
		set_value HTTPS_PORT "$REPLY_VAL"
		if [ "$looks_ip" = "1" ]; then
			set_value TLS_DIRECTIVE "tls internal"
			note "IP address: Caddy issues from its own CA (browsers warn once). Let's Encrypt cannot issue for an IP."
		else
			confirm "Obtain a Let's Encrypt certificate automatically? (needs ports 80+443 reachable)" 1
			if [ "$CONFIRM_VAL" = "1" ]; then
				set_value TLS_DIRECTIVE ""
			else
				set_value TLS_DIRECTIVE "tls internal"
			fi
		fi
		ask "ACME email (certificate expiry notices)"
		set_value ACME_EMAIL "$REPLY_VAL"
	fi
	local default_origin
	if [ -n "${PARSED[PUBLIC_ORIGIN]:-}" ]; then
		default_origin="${PARSED[PUBLIC_ORIGIN]}"
	elif [ "${VALUES[HTTPS_PORT]}" = "443" ]; then
		default_origin="https://${VALUES[PUBLIC_HOST]}"
	else
		default_origin="https://${VALUES[PUBLIC_HOST]}:${VALUES[HTTPS_PORT]}"
	fi
	ask "Public origin (every advertised URL is built from this)" "$default_origin"
	if ! is_absolute_url "$REPLY_VAL"; then
		fail "PUBLIC_ORIGIN must be an absolute http(s) URL."
	fi
	set_value PUBLIC_ORIGIN "$REPLY_VAL"

	if [ "$profile" = "enterprise" ]; then
		title "Sign-in architecture"
		note "Gateway console and chat are two separate OIDC clients, and /v1 accepts the chat's user tokens only when both sides agree on one issuer plus an audience (docs/oidc-generic-provider.md). A split signs in fine on both sides but breaks per-user /v1 calls; local passwords always stay on as the bootstrap door."
		printf '  %s1)%s Single external IdP for gateway and chat\n' "$CYAN" "$R"
		printf '  %s2)%s House IdP for both — no external provider\n' "$CYAN" "$R"
		printf '  %s3)%s Custom — each side separately, now or later\n' "$CYAN" "$R"
		ask "Choose [1-3]" "1"
		case "$REPLY_VAL" in
			2) AUTH_MODE="house" ;;
			3) AUTH_MODE="custom" ;;
			*) AUTH_MODE="external" ;;
		esac
		if [ "$AUTH_MODE" = "house" ]; then
			note "House IdP with enterprise components: same sign-in as team, plus NER, browser fetch and the ledger."
			set_value GATEWAY_OIDC__ENABLED "false"
			set_house_idp_values
			token_url_safe 48
			set_value GATEWAY_IDP__INTERNAL_TOKEN "$TOKEN_VAL"
			# Chat OIDC stays unset: the overlay falls back to the house IdP.
		elif [ "$AUTH_MODE" = "custom" ]; then
			note "Each side optional; whatever stays empty is console/docs work later."
			confirm "External OIDC for the gateway console now?" 1
			if [ "$CONFIRM_VAL" = "1" ]; then
				set_value GATEWAY_OIDC__ENABLED "true"
				ask_required "OIDC issuer"
				set_value GATEWAY_OIDC__ISSUER "$REPLY_VAL"
				ask_required "Client id (gateway console)"
				set_value GATEWAY_OIDC__CLIENT_ID "$REPLY_VAL"
				ask_hidden "Client secret (gateway console, empty for a public client)"
				set_value GATEWAY_OIDC__CLIENT_SECRET "$REPLY_VAL"
				ask "Groups claim" "groups"
				set_value GATEWAY_OIDC__GROUPS_CLAIM "$REPLY_VAL"
				ask_access_token_audience
			else
				set_value GATEWAY_OIDC__ENABLED "false"
			fi
			confirm "House IdP on (covers the chat while its own provider is unset)?" 1
			if [ "$CONFIRM_VAL" = "1" ]; then
				set_house_idp_values
				token_url_safe 48
				set_value GATEWAY_IDP__INTERNAL_TOKEN "$TOKEN_VAL"
			else
				set_value GATEWAY_IDP__ENABLED "false"
			fi
			ask "Chat OIDC provider URL (empty leaves the chat on the house IdP when it is on)"
			set_value CHAT_OIDC_PROVIDER_URL "$REPLY_VAL"
			if [ -n "$REPLY_VAL" ]; then
				ask "Chat client id at the provider" "cerea"
				set_value CHAT_OIDC_CLIENT_ID "$REPLY_VAL"
				ask_hidden "Chat client secret (empty for a public client)"
				set_value CHAT_OIDC_CLIENT_SECRET "$REPLY_VAL"
				ask "Chat OIDC scopes" "openid profile email"
				set_value CHAT_OIDC_SCOPES "$REPLY_VAL"
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
		ask_required "OIDC issuer"
		set_value GATEWAY_OIDC__ISSUER "$REPLY_VAL"
		ask_required "Client id (gateway console)"
		set_value GATEWAY_OIDC__CLIENT_ID "$REPLY_VAL"
		ask_hidden "Client secret (gateway console)"
		set_value GATEWAY_OIDC__CLIENT_SECRET "$REPLY_VAL"
		ask "Groups claim" "groups"
		set_value GATEWAY_OIDC__GROUPS_CLAIM "$REPLY_VAL"
		ask_access_token_audience
		set_value GATEWAY_IDP__ENABLED "false"
		ask "Chat OIDC provider URL" "${VALUES[GATEWAY_OIDC__ISSUER]}"
		set_value CHAT_OIDC_PROVIDER_URL "$REPLY_VAL"
		ask_required "Chat client id at the provider" "cerea"
		set_value CHAT_OIDC_CLIENT_ID "$REPLY_VAL"
		ask_hidden "Chat client secret"
		set_value CHAT_OIDC_CLIENT_SECRET "$REPLY_VAL"
		ask "Chat OIDC scopes" "openid profile email"
		set_value CHAT_OIDC_SCOPES "$REPLY_VAL"
		fi
	elif [ "$standalone" = "0" ]; then
		set_value GATEWAY_OIDC__ENABLED "false"
		set_house_idp_values
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
	set_value GATEWAY_PORT "${PARSED[GATEWAY_PORT]:-8000}"
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
			POSTGRES_PASSWORD | GATEWAY_SECRET_KEY | GATEWAY_SESSION_SECRET | REDACTION_PLACEHOLDER_KEY | GATEWAY_IDP__INTERNAL_TOKEN | GATEWAY_IDP__SIGNING_KEY | CHAT_IDP_CLIENT_SECRET | CHAT_SECRET_KEY | CHAT_PG_PASSWORD | GATEWAY_UPSTREAM__API_KEY | GATEWAY_OIDC__CLIENT_SECRET | OPENAI_API_KEY | CHAT_OIDC_CLIENT_SECRET) shown="(secret, hidden)" ;;
			*) [ -z "$value" ] && shown="(empty)" || shown="$value" ;;
		esac
		printf '  %s=%s\n' "$key" "$shown"
	done
}

# ------------------------------------------------------------------ #
# compose: always --env-file, never the shell environment             #
# ------------------------------------------------------------------ #

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

dry_print_cmd() {
	printf '%s[dry-run] (cd %s &&' "$CYAN" "$PYSTINO_ROOT"
	local arg
	for arg in "$@"; do
		printf ' %q' "$arg"
	done
	printf ')%s\n' "$R"
}

# Try a compose command, returning its status (for probes and steps whose
# failure is a decision point, not the end).
try_compose() { # try_compose <env-file> <args...>
	local envfile="$1"
	shift
	if [ "$DRY_RUN" = "1" ]; then
		dry_print_cmd docker compose --env-file "$envfile" "$@"
		return 0
	fi
	(cd "$PYSTINO_ROOT" && "${SCRUB[@]}" compose --env-file "$envfile" "$@")
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

# The whole standalone overlay set: base + chat + exposure, the same files
# the gateway profiles use — the gateway, valkey, migrate and redaction
# services are excluded by starting services by name, not by a different
# file list.
standalone_overlay_flags() { # standalone_overlay_flags <exposure>
	local exposure="$1"
	case "$exposure" in
		edge | proxy) ;;
		*) fail "exposure must be 'edge' or 'proxy' (got '$exposure')" ;;
	esac
	OVERLAY_FLAGS=(-f deploy/compose/docker-compose.yml
		-f deploy/compose/docker-compose.chat.yml
		-f "deploy/compose/docker-compose.${exposure}.yml")
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

# ------------------------------------------------------------------ #
# the four phases                                                     #
# ------------------------------------------------------------------ #

phase_one() { # phase_one <env-file>
	local envfile="$1"
	title "Phase 1 — database, gateway, first credentials"
	BASE_FLAGS=(-f deploy/compose/docker-compose.yml)
	echo "Starting postgres, valkey, migrations and the gateway (base overlay only) ..."
	run_compose "$envfile" "${BASE_FLAGS[@]}" up -d --build
	wait_for_gateway "$envfile" "${BASE_FLAGS[@]}"

	echo ""
	echo "Create the first administrator. The password is prompted for here —"
	echo "it never lands in shell history or in any file."
	run_compose "$envfile" "${BASE_FLAGS[@]}" exec gateway gateway passwd admin@local

	ensure_chat_database "$envfile" "${BASE_FLAGS[@]}"

	local port="${VALUES[GATEWAY_PORT]:-8000}"
	printf '\nPhase 1 is up (%shttp://localhost:%s/console%s). Nothing left to mint — the chat boots anonymously against it (ADR 0081).\n' "$CYAN" "$port" "$R"
}

phase_two() { # phase_two <env-file>
	local envfile="$1"
	title "Phase 2 — full stack"
	overlay_flags custom_overlays "$EXPOSURE" "$REDACTION_STATE" "$ST_FETCH"
	local file_list="${OVERLAY_FLAGS[*]}"
	file_list="${file_list//-f /}"
	echo "Overlay set: $file_list"
	echo "Building images (first run downloads; the browser image is 3.45 GB) and starting ..."
	run_compose "$envfile" "${OVERLAY_FLAGS[@]}" up -d --build
	printf '\n%sUp.%s Next steps:\n' "$GREEN" "$R"
	echo "  - Chat:      ${VALUES[PUBLIC_ORIGIN]}/chat"
	echo "  - Console:   ${VALUES[PUBLIC_ORIGIN]}/console (or http://localhost:${VALUES[GATEWAY_PORT]:-8000}/console over SSH)"
	echo "  - Providers: add real models in the console — no profile ships a provider, so nothing answers until then."
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
	echo "Starting postgres and chat-mongo ..."
	run_compose "$envfile" "${OVERLAY_FLAGS[@]}" up -d --build postgres chat-mongo
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
	# --no-deps is what keeps "the named set" literally true: the exposure
	# overlays still name the gateway as the proxy's dependency (a Pystino-
	# side follow-up to drop), and without it `up chat proxy` would drag the
	# gateway and its migrations onto a box that holds no gateway — exactly
	# the container nobody asked for. The named services alone start.
	title "Phase 2 — chat and proxy (no gateway services)"
	local file_list="${OVERLAY_FLAGS[*]}"
	file_list="${file_list//-f /}"
	echo "Overlay set: $file_list"
	echo "Service set: chat chat-mongo postgres proxy — databases already run from phase 1."
	echo "Building images (first run downloads) and starting ..."
	run_compose "$envfile" "${OVERLAY_FLAGS[@]}" up -d --build --no-deps chat proxy
	printf '\n%sUp.%s Next steps:\n' "$GREEN" "$R"
	echo "  - Chat:      ${VALUES[PUBLIC_ORIGIN]}/chat"
	if [ "$PROFILE" = "satellite" ]; then
		echo "  - Models:    managed on central (${VALUES[OPENAI_BASE_URL]}) — nothing answers here until central serves them."
		echo "  - Users:     managed centrally too — this box creates no accounts."
		echo "  - Usage:     the tab reads central's ledger with each signed-in person's own token."
	else
		echo "  - Models:    served by the third party (${VALUES[OPENAI_BASE_URL]}) — every call bills the shared key."
		echo "  - Ledger:    none on this profile. There is no per-user spend to show, which is why the Usage tab stays hidden."
	fi
	printf '\n%sBack up POSTGRES_PASSWORD and CHAT_SECRET_KEY with the database now,%s not when you need it.\n' "$YELLOW" "$R"
}

# ------------------------------------------------------------------ #
# main                                                                #
# ------------------------------------------------------------------ #

main() {
	while [ $# -gt 0 ]; do
		case "$1" in
			--pystino)
				[ $# -ge 2 ] || { echo "--pystino needs a path" >&2; exit 2; }
				CLI_PYSTINO="$2"
				shift 2
				;;
			--phase2) PHASE2_ONLY=1; shift ;;
			--dry-run) DRY_RUN=1; shift ;;
			--help | -h) usage; exit 0 ;;
			*)
				echo "unknown argument: $1" >&2
				usage >&2
				exit 2
				;;
		esac
	done

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
		ask "Profile this .env was built from (homelab|team|enterprise|satellite|generic)" "homelab"
		PROFILE="$REPLY_VAL"
		case "$PROFILE" in
			homelab | team | enterprise | satellite | generic) ;;
			*) fail "unknown profile '$PROFILE'." ;;
		esac
		ask "Exposure (edge|proxy)" "edge"
		EXPOSURE="$REPLY_VAL"
		case "$EXPOSURE" in
			edge | proxy) ;;
			*) fail "exposure must be edge or proxy." ;;
		esac
		if is_standalone_profile "$PROFILE"; then
			# Fixed component set — nothing to infer beyond what the file
			# says. usage is an exact match here (generic writes "false",
			# which the gateway inference below would misread as shown).
			REDACTION_STATE="off"
			ST_FETCH="${PARSED[FETCH_BACKEND]:-direct}"
			[ -z "$ST_FETCH" ] && ST_FETCH="direct"
			ST_METERING=0
			[ "${PARSED[CHAT_CODE_TOOL_ENABLED]:-}" = "true" ] && ST_CODETOOL=1 || ST_CODETOOL=0
			[ "${PARSED[CHAT_USAGE_ENABLED]:-}" = "true" ] && ST_USAGE=1 || ST_USAGE=0
			[ "${PARSED[CHAT_KNOWLEDGE_ENABLED]:-}" != "false" ] && ST_KNOWLEDGE=1 || ST_KNOWLEDGE=0
			[ "${PARSED[CHAT_MEMORY_ENABLED]:-}" != "false" ] && ST_MEMORY=1 || ST_MEMORY=0
			note "Standalone profile: fixed component set (no gateway toggles). Re-run the full flow to change values."
		else
		local eng="${PARSED[GATEWAY_REDACTION__ENGINE]:-noop}"
		local spacy="${PARSED[SPACY_MODELS]:-}"
		trim "$spacy"
		if [ "$eng" = "http" ]; then
			if [ -z "$REPLY_VAL" ]; then
				REDACTION_STATE="pattern"
			else
				REDACTION_STATE="ner"
			fi
		else
			REDACTION_STATE="off"
		fi
		ST_FETCH="${PARSED[FETCH_BACKEND]:-direct}"
		if [ -z "$ST_FETCH" ]; then ST_FETCH="direct"; fi
			[ "${PARSED[GATEWAY_ACCOUNTING__ENABLED]:-}" != "false" ] && ST_METERING=1 || ST_METERING=0
			[ "${PARSED[CHAT_CODE_TOOL_ENABLED]:-}" = "true" ] && ST_CODETOOL=1 || ST_CODETOOL=0
			[ -n "${PARSED[CHAT_USAGE_ENABLED]:-}" ] && ST_USAGE=1 || ST_USAGE=0
			[ "${PARSED[CHAT_KNOWLEDGE_ENABLED]:-}" != "false" ] && ST_KNOWLEDGE=1 || ST_KNOWLEDGE=0
			[ "${PARSED[CHAT_MEMORY_ENABLED]:-}" != "false" ] && ST_MEMORY=1 || ST_MEMORY=0
			note "Inferred toggles: redaction=$REDACTION_STATE fetch=$ST_FETCH metering=$ST_METERING. Re-run the full flow to change them."
			# The enterprise sign-in shape is inferred the same way: external
			# console OIDC means external, house IdP on means house, neither
			# means a custom split someone assembled by hand.
			if [ "$PROFILE" = "enterprise" ]; then
				if [ "${PARSED[GATEWAY_OIDC__ENABLED]:-}" = "true" ]; then
					AUTH_MODE="external"
				elif [ "${PARSED[GATEWAY_IDP__ENABLED]:-}" = "true" ]; then
					AUTH_MODE="house"
				else
					AUTH_MODE="custom"
				fi
			fi
		fi
		# Resume keeps every parsed value; CHAT_REPO is re-confirmed below
		# and nothing is regenerated.
		local key
		for key in "${PARSED_ORDER[@]}"; do
			set_value "$key" "${PARSED[$key]}"
		done
	else
		choose_profile
		if is_standalone_profile "$PROFILE"; then
			# No component toggles: without a gateway there is no redaction
			# engine, ledger or fetch backend to choose between — the set is
			# the profile.
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
		if is_standalone_profile "$PROFILE"; then
			standalone_overlay_flags "$EXPOSURE"
			phase_two_standalone "$ENV_FILE"
		else
			phase_two "$ENV_FILE"
		fi
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
			standalone_overlay_flags "$EXPOSURE"
		else
			overlay_flags custom_overlays "$EXPOSURE" "$REDACTION_STATE" "$ST_FETCH"
		fi
		# The derivation needed CHAT_REPO for the playwright overlay; the
		# scrub for the parse check must keep it (it is re-supplied as an
		# explicit assignment instead of being left to the shell).
		local -a check_cmd=(env)
		local sk skip_next=0
		for sk in "${SCRUB[@]}"; do
			if [ "$skip_next" = "1" ]; then
				if [ "$sk" != "CHAT_REPO" ]; then check_cmd+=(-u "$sk"); fi
				skip_next=0
				continue
			fi
			if [ "$sk" = "-u" ]; then skip_next=1; fi
		done
		check_cmd+=(-u GATEWAY_PORT CHAT_REPO="$CHAT_REPO_VAL" docker)
		if ! (cd "$PYSTINO_ROOT" && "${check_cmd[@]}" compose --env-file "$ENV_FILE" "${OVERLAY_FLAGS[@]}" config --quiet); then
			fail "docker compose refuses the generated environment (see the message above)."
		fi
		if [ "$DRY_RUN" = "1" ]; then
			note "[dry-run] docker compose config --quiet accepted the generated .env against the overlay set."
		fi
	fi

	if is_standalone_profile "$PROFILE"; then
		standalone_overlay_flags "$EXPOSURE"
		phase_one_standalone "$ENV_FILE"
		phase_two_standalone "$ENV_FILE"
	else
		phase_one "$ENV_FILE"
		phase_two "$ENV_FILE"
	fi

	if [ "$DRY_RUN" = "1" ]; then
		title "Dry run complete"
		echo "The .env that would have been written: $ENV_OUT (mode 600)"
		echo "Nothing was run, and nothing outside $TMP_DIR was touched."
		echo "Delete it with: rm -rf $TMP_DIR"
	fi
}

main "$@"
