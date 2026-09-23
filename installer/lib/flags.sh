#!/usr/bin/env bash
#
# flags.sh — the command-line decision surface.
#
# A scripted/CI install must not depend on prompt choreography: every
# decision the interactive flow asks for is addressable as a flag, every
# flag value is validated by the same rules the interactive answer would
# meet, and an unresolved decision is a loud error listing exactly what is
# missing — never a silent fallback and never a hang waiting on stdin.
#
# Mode rule: any decision given by flag (--profile --exposure --idp
# --components --admin-email --set) switches the run to non-interactive;
# --non-interactive forces it outright. Interactive prompting stays the
# default when no decision arrives by flag and stdin is a TTY. --pystino,
# --chat-repo, --phase2, --dry-run and --build are inputs and switches, not
# decisions, and never switch the mode.
#
# The --set answers travel in PENDING and are consumed by install.sh's ask
# helpers exactly where the prompt would have answered — so a flagged value
# flows through the same post-processing and the same validate_values as the
# typed one. A --set the chosen shape never asks for is a loud unconsumed
# error, not a silent ignore.
#
# State:
#   DRY_RUN PHASE2_ONLY CLI_PYSTINO BUILD      switches (BUILD is
#                                              materialised by compose-flags.sh)
#   NON_INTERACTIVE                            1 once a decision arrives by flag
#   FLAG_PROFILE FLAG_EXPOSURE FLAG_IDP        the shape decisions
#   FLAG_ADMIN_EMAIL FLAG_ADMIN_EMAIL_USED     the bundled-Authelia first human
#   FLAG_CHAT_REPO                             the Cerea checkout to build from
#   COMPONENTS_SPEC                            the raw --components spec
#   PENDING                                    --set KEY=VALUE map, consumed by
#                                              the ask helpers as they answer
#   MISSING_DECISIONS                          accumulated missing decisions
#   ENV_IDP_ADMIN_PASSWORD / ENV_IDP_FIRST_PASSWORD
#                                              environment snapshots, taken at
#                                              parse time — the collect flow
#                                              clears the same-named working
#                                              variables before it runs, and
#                                              these two passwords never land
#                                              in deploy/.env, so the
#                                              environment (not argv) is their
#                                              only non-interactive channel
#
# Functions (inputs -> outputs):
#   usage                            -> flag documentation on stdout
#   parse_install_flags <args...>    -> the state above; --help exits 0,
#                                       unknown arguments exit 2, rejected
#                                       values fail (exit 1)
#   pending_has <key>                -> exit 0 when --set carried the key
#                                       (even as an empty value)
#   pending_take <key>               -> REPLY_VAL = the value, key consumed
#   record_missing <key> <hint>      -> MISSING_DECISIONS += "key — hint"
#   fail_missing_decisions           -> fail listing them (no-op when none)
#   fail_unconsumed                  -> fail on --set / --admin-email the
#                                       install shape never consumed

DRY_RUN=0
PHASE2_ONLY=0
CLI_PYSTINO=""
BUILD=0
NON_INTERACTIVE=0
FLAG_PROFILE=""
FLAG_EXPOSURE=""
FLAG_IDP=""
FLAG_ADMIN_EMAIL=""
FLAG_ADMIN_EMAIL_USED=0
FLAG_CHAT_REPO=""
COMPONENTS_SPEC=""
declare -A PENDING=()
MISSING_DECISIONS=()
ENV_IDP_ADMIN_PASSWORD="${IDP_ADMIN_PASSWORD:-}"
ENV_IDP_FIRST_PASSWORD="${IDP_FIRST_PASSWORD:-}"

usage() {
	echo "Usage: ./installer/install.sh [--pystino <path>] [--phase2] [--dry-run] [--build]"
	echo "                              [--profile <p>] [--exposure <e>] [--idp <i>]"
	echo "                              [--components <spec>] [--admin-email <email>]"
	echo "                              [--chat-repo <path>] [--set KEY=VALUE ...]"
	echo "                              [--non-interactive]"
	echo "  --phase2            resume against an existing deploy/.env (full bring-up)"
	echo "  --dry-run           resolve everything, write the .env to a temp path, print"
	echo "                      the exact docker compose command lines, run nothing"
	echo "  --build             force a rebuild of images that already exist. Off by"
	echo "                      default: a first run still builds what is missing, and a"
	echo "                      re-run (or a registry-image deployment) reuses it"
	echo ""
	echo "  Non-interactive surface — any of these switches the run to"
	echo "  non-interactive: prompts never fire, and a decision nothing supplies"
	echo "  becomes a loud error listing exactly what is missing (CI fails"
	echo "  instead of hanging on stdin):"
	echo "  --profile <name>    homelab | team | enterprise | satellite | generic"
	echo "  --exposure <e>      edge | proxy (the exposure menu's only two shapes;"
	echo "                      loopback would leave the chat unreachable)"
	echo "  --idp <i>           sign-in shape: house | authelia | keycloak (team),"
	echo "                      external | house | custom | authelia | keycloak"
	echo "                      (enterprise), central | authelia (satellite),"
	echo "                      external (generic), house (homelab, its only shape)"
	echo "  --components <spec> comma list of component overrides over the profile's"
	echo "                      defaults: redaction=off|pattern|ner, fetch=direct|"
	echo "                      playwright, metering=on|off, usage=shown|hidden,"
	echo "                      code-tool=on|off, knowledge=on|off, memory=on|off,"
	echo "                      code-panel=on|off"
	echo "                      (partial lists keep the profile defaults; never valid"
	echo "                      for the standalone profiles, whose set is fixed)"
	echo "  --admin-email <e>   the bundled-Authelia first human's email"
	echo "  --public-host <h>   the public hostname browsers use (PUBLIC_HOST)"
	echo "  --https-port <p>    the edge/proxy HTTPS port (HTTPS_PORT, default 8443)"
	echo "  --acme-email <e>    certificate expiry notices (ACME_EMAIL, proxy shape)"
	echo "  --central <url>     point at a central Pystino: fills the backend"
	echo "                      base URL and the OIDC issuer (satellite/generic);"
	echo "                      --set CHAT_OIDC_PROVIDER_URL after it overrides"
	echo "                      the issuer when it genuinely differs"
	echo "  --chat-repo <path>  the Cerea checkout the chat image builds from"
	echo "                      (default: this checkout; never switches the mode)"
	echo "  --set KEY=VALUE     a deploy/.env value the prompts would otherwise ask"
	echo "                      for (repeatable; validated like the interactive"
	echo "                      answer). Secret values given this way are visible in"
	echo "                      the process list — the two passwords that never land"
	echo "                      in deploy/.env can only come from the environment:"
	echo "                      IDP_ADMIN_PASSWORD (Authelia), IDP_FIRST_PASSWORD"
	echo "                      (Keycloak)"
	echo "  --non-interactive   force the mode even with no decision flag"
}

# Keys --set may carry: exactly the values the prompts would set. Everything
# else in the value store is generated (minted here), component-derived (the
# --components spec's serialization) or fixed/derived for the chosen shape —
# letting --set write those would fight the shape the overlays and the
# metadata block describe.
is_settable_key() { # is_settable_key <key> -> REJECT_REASON (empty when settable)
	REJECT_REASON=""
	case "$1" in
		PUBLIC_HOST | HTTPS_PORT | TLS_DIRECTIVE | ACME_EMAIL | PUBLIC_ORIGIN | OPENAI_BASE_URL | OPENAI_API_KEY | CHAT_OIDC_PROVIDER_URL | CHAT_OIDC_CLIENT_ID | CHAT_OIDC_CLIENT_SECRET | CHAT_OIDC_SCOPES | CHAT_OCR_BASE_URL | CHAT_OCR_MODEL | CHAT_OCR_API_KEY | GATEWAY_OIDC__ENABLED | GATEWAY_OIDC__ISSUER | GATEWAY_OIDC__CLIENT_ID | GATEWAY_OIDC__CLIENT_SECRET | GATEWAY_OIDC__GROUPS_CLAIM | GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE | GATEWAY_IDP__ENABLED | GATEWAY_PORT) return 0 ;;
		GATEWAY_REDACTION__ENGINE | SPACY_MODELS | REDACTION_NLP_ENGINE | REDACTION_LANGUAGE | GATEWAY_ACCOUNTING__ENABLED | GATEWAY_QUOTA__ENABLED | FETCH_BACKEND | CHAT_USAGE_ENABLED | CHAT_CODE_TOOL_ENABLED | CHAT_KNOWLEDGE_ENABLED | CHAT_MEMORY_ENABLED | USE_USER_TOKEN)
			REJECT_REASON="component- or safety-derived — express it with --components (or leave the install shape to decide)"
			return 1
			;;
		CODE_AGENTS_ENABLED | CODE_RELAY_URL)
			REJECT_REASON="component-derived (the /code panel toggle, ADR 0085) — express it with --components code-panel=on|off"
			return 1
			;;
		POSTGRES_PASSWORD | GATEWAY_SECRET_KEY | GATEWAY_SESSION_SECRET | REDACTION_PLACEHOLDER_KEY | GATEWAY_IDP__INTERNAL_TOKEN | CHAT_IDP_CLIENT_SECRET | CHAT_SECRET_KEY | CHAT_PG_PASSWORD | KEYCLOAK_ADMIN_PASSWORD | IDP_SESSION_SECRET | IDP_HMAC_SECRET | IDP_STORAGE_KEY | IDP_CONSOLE_CLIENT_SECRET)
			REJECT_REASON="generated by the installer (secrets are minted, never passed in)"
			return 1
			;;
		POSTGRES_USER | POSTGRES_DB | CHAT_PG_URL | GATEWAY_IDP__ISSUER | GATEWAY_IDP__INTERNAL_BASE_URL | GATEWAY_IDP__CLIENTS | IDP_BUNDLED | KEYCLOAK_ADMIN | GATEWAY_LOCAL_AUTH__ENABLED | GATEWAY_ENVIRONMENT | CHAT_REPO)
			REJECT_REASON="fixed or derived for the chosen shape"
			return 1
			;;
		IDP_ADMIN_EMAIL)
			REJECT_REASON="carried by --admin-email (bundled shapes) or fixed by the realm template — never --set"
			return 1
			;;
		COMPOSE_PROFILES | GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL)
			REJECT_REASON="derived from the install shape (profiles from profile+IdP+/code panel; the link flag ships with bundled IdPs only)"
			return 1
			;;
		*)
			REJECT_REASON="unknown deploy/.env key"
			return 1
			;;
	esac
}

set_pending() { # set_pending <key> <value>
	local key="$1" value="$2" reason
	case "$key" in
		[A-Za-z_][A-Za-z0-9_]*) ;;
		*) fail "--set '$key': not a valid variable name." ;;
	esac
	is_settable_key "$key" || fail "--set $key: $REJECT_REASON."
	case "$value" in
		*$'\n'* | *$'\r'*) fail "--set $key: values must be single-line." ;;
	esac
	PENDING[$key]="$value"
}

pending_has() { # exit 0 when the key was set by --set (even as an empty value)
	[ -n "${PENDING[$1]+x}" ]
}

pending_take() { # pending_take <key> -> REPLY_VAL
	REPLY_VAL="${PENDING[$1]}"
	unset "PENDING[$1]"
}

record_missing() { # record_missing <key> <how-to-supply>
	MISSING_DECISIONS+=("$1 — $2")
}

fail_missing_decisions() {
	[ "${#MISSING_DECISIONS[@]}" -gt 0 ] || return 0
	local msg entry
	msg="non-interactive run is missing ${#MISSING_DECISIONS[@]} decision(s):"
	for entry in "${MISSING_DECISIONS[@]}"; do
		msg="$msg
  - $entry"
	done
	msg="$msg
Supply every missing decision (flag or --set) and re-run, or re-run without
--non-interactive to answer the prompts."
	fail "$msg"
}

fail_unconsumed() { # decisions supplied but never asked for by this shape
	local left=() key
	for key in "${!PENDING[@]}"; do
		left+=("--set $key=${PENDING[$key]}")
	done
	if [ "$FLAG_ADMIN_EMAIL_USED" != "1" ] && [ -n "$FLAG_ADMIN_EMAIL" ]; then
		left+=("--admin-email $FLAG_ADMIN_EMAIL (this shape never asks for it — Keycloak's first user is fixed, house/central shapes have no local admin)")
	fi
	[ "${#left[@]}" -gt 0 ] || return 0
	local msg entry
	msg="these supplied decisions were never consumed by this install shape:"
	for entry in "${left[@]}"; do
		msg="$msg
  - $entry"
	done
	fail "$msg"
}

parse_install_flags() { # parse_install_flags <args...>
	while [ $# -gt 0 ]; do
		case "$1" in
			--pystino)
				[ $# -ge 2 ] || { echo "--pystino needs a path" >&2; exit 2; }
				CLI_PYSTINO="$2"
				shift 2
				;;
			--phase2) PHASE2_ONLY=1; shift ;;
			--dry-run) DRY_RUN=1; shift ;;
			--build) BUILD=1; shift ;;
			--profile)
				[ $# -ge 2 ] || { echo "--profile needs a value" >&2; exit 2; }
				case "$2" in
					homelab | team | enterprise | satellite | generic) FLAG_PROFILE="$2" ;;
					*) fail "--profile '$2' is not a profile (homelab|team|enterprise|satellite|generic)." ;;
				esac
				shift 2
				;;
			--exposure)
				[ $# -ge 2 ] || { echo "--exposure needs a value" >&2; exit 2; }
				case "$2" in
					edge | proxy) FLAG_EXPOSURE="$2" ;;
					*) fail "--exposure '$2' is not an exposure (edge|proxy)." ;;
				esac
				shift 2
				;;
			--idp)
				[ $# -ge 2 ] || { echo "--idp needs a value" >&2; exit 2; }
				case "$2" in
					house | external | custom | central | authelia | keycloak) FLAG_IDP="$2" ;;
					*) fail "--idp '$2' is not a sign-in shape (house|external|custom|central|authelia|keycloak)." ;;
				esac
				shift 2
				;;
		--admin-email)
			[ $# -ge 2 ] || { echo "--admin-email needs a value" >&2; exit 2; }
			[ -n "$2" ] || fail "--admin-email must not be empty."
			FLAG_ADMIN_EMAIL="$2"
			shift 2
			;;
		--public-host)
			# The one decision every edge/proxy install asks first; it
			# deserved better than --set PUBLIC_HOST=... on every CI line.
			# Injected into PENDING at parse time so the ask site consumes it
			# with its own validation and post-processing, exactly like --set.
			[ $# -ge 2 ] || { echo "--public-host needs a value" >&2; exit 2; }
			[ -n "$2" ] || fail "--public-host must not be empty."
			set_pending PUBLIC_HOST "$2"
			shift 2
			;;
		--https-port)
			[ $# -ge 2 ] || { echo "--https-port needs a value" >&2; exit 2; }
			case "$2" in
				'' | *[!0-9]*) fail "--https-port '$2' is not a port number." ;;
			esac
			set_pending HTTPS_PORT "$2"
			shift 2
			;;
		--acme-email)
			[ $# -ge 2 ] || { echo "--acme-email needs a value" >&2; exit 2; }
			[ -n "$2" ] || fail "--acme-email must not be empty."
			set_pending ACME_EMAIL "$2"
			shift 2
			;;
		--central)
			# Satellite/generic's coherent decision is "point at the central
			# Pystino": the backend base URL and the OIDC issuer both derive
			# from it. One flag fills both — the issuer stays separately
			# --set-able when it genuinely differs, and PENDING's
			# last-write-wins order means an explicit CHAT_OIDC_PROVIDER_URL
			# --set after --central still overrides. The client id/secret stay
			# separate decisions: a shared secret on argv is a leak, and the
			# missing-list names them anyway.
			[ $# -ge 2 ] || { echo "--central needs a URL" >&2; exit 2; }
			[ -n "$2" ] || fail "--central must not be empty."
			set_pending OPENAI_BASE_URL "$2"
			set_pending CHAT_OIDC_PROVIDER_URL "$2"
			shift 2
			;;
			--chat-repo)
				[ $# -ge 2 ] || { echo "--chat-repo needs a path" >&2; exit 2; }
				FLAG_CHAT_REPO="$2"
				shift 2
				;;
			--components)
				[ $# -ge 2 ] || { echo "--components needs a spec" >&2; exit 2; }
				components_parse "$2" COMPONENTS_TMP_MAP
				COMPONENTS_SPEC="$2"
				shift 2
				;;
			--set)
				[ $# -ge 2 ] || { echo "--set needs KEY=VALUE" >&2; exit 2; }
				case "$2" in
					*=*) set_pending "${2%%=*}" "${2#*=}" ;;
					*) fail "--set '$2' is not KEY=VALUE." ;;
				esac
				shift 2
				;;
			--non-interactive) NON_INTERACTIVE=1; shift ;;
			--help | -h) usage; exit 0 ;;
			*)
				echo "unknown argument: $1" >&2
				usage >&2
				exit 2
				;;
		esac
	done
	# Any decision given by flag implies non-interactive: a CI run passing
	# --profile must fail loudly on what is still missing, not fall back to
	# prompts it cannot answer.
	if [ "$NON_INTERACTIVE" != "1" ]; then
		if [ -n "$FLAG_PROFILE" ] || [ -n "$FLAG_EXPOSURE" ] || [ -n "$FLAG_IDP" ] ||
			[ -n "$FLAG_ADMIN_EMAIL" ] || [ -n "$COMPONENTS_SPEC" ] || [ "${#PENDING[@]}" -gt 0 ]; then
			NON_INTERACTIVE=1
		fi
	fi
}
