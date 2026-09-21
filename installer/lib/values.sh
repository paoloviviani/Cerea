#!/usr/bin/env bash
#
# values.sh — the deployment's values: profile metadata, the value store,
# validation, and the pure pieces of value collection.
#
# Pure by construction: no docker, no files, no stdin — the only effects are
# stdout where documented, stderr + exit 1 through `fail`, and the state
# variables listed here. Prompts stay in install.sh. Unit-tested by
# installer/tests/test-values.sh.
#
# State:
#   VALUES / VALUES_ORDER   value store: key -> single-line value, in the
#                           order keys were first set (deploy/.env keeps it)
#   REQUIRED                array filled by required_keys_for
#   REPLY_VAL               output of trim
#   TOKEN_VAL               output of token_url_safe
#   ORIGIN_DEFAULT, HTTPS_PORT_DEFAULT   outputs of the prompt-default helpers
#   ST_REDACTION ST_FETCH ST_METERING ST_CODETOOL ST_USAGE ST_KNOWLEDGE ST_MEMORY
#   ST_CODEPANEL             component toggles: set by toggle_components on a
#                            fresh run, by the infer_* functions on --phase2
#                            (ST_CODEPANEL: the /code remote-agent panel, ADR 0085)
#   AUTH_MODE               enterprise sign-in shape (collect or infer_auth_mode)
#
# Functions (inputs -> outputs):
#   trim <string>                    -> REPLY_VAL, leading/trailing whitespace gone
#   is_standalone_profile <profile>  -> exit 0 for satellite|generic
#   profile_fragment <profile>       -> "<profile>.env" on stdout; fails otherwise
#   token_url_safe <n-bytes>         -> TOKEN_VAL, urlsafe base64 without padding
#   set_value <key> <value>          -> VALUES/VALUES_ORDER (first insert ordered)
#   assert_values_single_line        -> fails when any stored value carries a line break
#   is_absolute_url <string>         -> exit 0 for an absolute http(s) URL
#   is_ipv4 <string>                 -> exit 0 for four dot-separated digit groups
#                                       (the shape heuristic the installer has always
#                                       used — not an octet-range check)
#   required_keys_for <profile> <exposure> -> REQUIRED[], the names that must be
#                                       non-empty before anything is written
#   validate_values <profile> <values-name> -> fails closed on empty required
#                                       values, impossible IdP shapes and the
#                                       SAFETY guards (stored keys / user tokens)
#   set_house_idp_values             -> VALUES: the house IdP's four values,
#                                       derived from PUBLIC_ORIGIN + the chat secret
#   set_bundled_idp_values <authelia|keycloak> [chat-secret] -> VALUES: issuer,
#                                       clients, audience, the local-link flag
#                                       and operator email, and the bundle's
#                                       own secrets, derived from PUBLIC_ORIGIN
#   default_https_port <host>        -> HTTPS_PORT_DEFAULT (8443 for a bare IP, 443 otherwise)
#   default_public_origin <parsed|empty> <host> <port> -> ORIGIN_DEFAULT
#   infer_standalone_toggles         -> REDACTION_STATE + ST_* from PARSED (standalone)
#   infer_gateway_toggles            -> REDACTION_STATE + ST_* from PARSED (gateway profiles)
#   infer_auth_mode                  -> AUTH_MODE from PARSED (enterprise; reads PARSED)

# ------------------------------------------------------------------ #
# small string helper                                                 #
# ------------------------------------------------------------------ #

# Trim leading and trailing whitespace (the bash parameter-expansion idiom;
# no external tool, so a value with backslashes survives untouched).
trim() {
	local s="$1"
	s="${s#"${s%%[![:space:]]*}"}"
	s="${s%"${s##*[![:space:]]}"}"
	REPLY_VAL="$s"
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
P_BLURB[enterprise]="Everything: NER redaction, browser fetch, external or bundled OIDC, per-group billing."
P_FOOTPRINT[enterprise]="team +~750 MB RSS (NER), +3.45 GB disk for the browser"
P_BLURB[satellite]="Chat against a central Pystino: users and ledger live there, this box holds chat + databases only. Sign-in against central, or a bundled local Authelia."
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

# ------------------------------------------------------------------ #
# the value store: every value single-line, insertion order kept       #
# ------------------------------------------------------------------ #

declare -A VALUES=()
VALUES_ORDER=()

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
# derived value shapes (no prompting — callers own the questions)      #
# ------------------------------------------------------------------ #

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

# Bundled providers (Authelia/Keycloak), shared by team, enterprise and the
# satellite-local shape: the audience is fixed by the overlays (`pystino-api`
# on both clients, implicitly granted), so it is written, never prompted;
# the issuer is the public origin plus the provider's prefix. The house IdP
# stays off on these shapes — the `[]` fallback in collect covers the client
# registry. The first-human password is asked, never minted (shell variables
# IDP_ADMIN_* / IDP_FIRST_PASSWORD, never VALUES, so it never lands in
# deploy/.env); everything generatable is minted here.
set_bundled_idp_values() { # set_bundled_idp_values <authelia|keycloak> [chat-secret]
	local kind="$1" chat_secret="${2:-}" issuer chat_id
	if [ "$kind" = "authelia" ]; then
		issuer="${VALUES[PUBLIC_ORIGIN]}/authelia"
		chat_id="cerea"
	else
		issuer="${VALUES[PUBLIC_ORIGIN]}/idp/realms/pystino"
		chat_id="pystino-chat"
	fi
	set_value IDP_BUNDLED "$kind"
	set_value GATEWAY_IDP__ENABLED "false"
	set_value GATEWAY_OIDC__ENABLED "true"
	set_value GATEWAY_OIDC__ISSUER "$issuer"
	set_value GATEWAY_OIDC__CLIENT_ID "pystino-console"
	token_url_safe 48
	set_value GATEWAY_OIDC__CLIENT_SECRET "$TOKEN_VAL"
	set_value GATEWAY_OIDC__GROUPS_CLAIM "groups"
	# Fixed by the overlays, never prompted: both clients are granted
	# `pystino-api` implicitly, so no IdP API call is needed to learn it.
	set_value GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE "pystino-api"
	# Bundled shapes only: the gateway adopts its local accounts by email,
	# so the first IdP login whose verified email matches the local admin
	# row takes that row over instead of provisioning a fresh non-admin
	# account beside it (the gateway reads this flag; other shapes never
	# write the variable — absence is the default-off).
	set_value GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL "true"
	# The operator email travels in deploy/.env — not a secret (the IdP seed
	# files carry it in plaintext anyway) — so a --phase2 resume can re-seed
	# the break-glass admin after a database volume recreation without
	# asking again. Keycloak's first human is fixed by the realm template;
	# Authelia's arrives from the --admin-email flag / the prompt, collected
	# before this runs.
	if [ "$kind" = "authelia" ]; then
		set_value IDP_ADMIN_EMAIL "${IDP_ADMIN_EMAIL:-}"
	else
		set_value IDP_ADMIN_EMAIL "owner@example.org"
	fi
	set_value CHAT_OIDC_PROVIDER_URL "$issuer"
	set_value CHAT_OIDC_CLIENT_ID "$chat_id"
	if [ -n "$chat_secret" ]; then
		set_value CHAT_OIDC_CLIENT_SECRET "$chat_secret"
	else
		token_url_safe 48
		set_value CHAT_OIDC_CLIENT_SECRET "$TOKEN_VAL"
	fi
	# Tokens validate locally with no userinfo round trip — without `groups`
	# in the token, billing sees nobody.
	set_value CHAT_OIDC_SCOPES "openid profile email groups"
	if [ "$kind" = "authelia" ]; then
		# Authelia-internal secrets, baked into deploy/idp/ at generation.
		# Stored (not derived) so a deliberate regeneration reuses them.
		set_value IDP_SESSION_SECRET "$(openssl rand -hex 32)"
		set_value IDP_HMAC_SECRET "$(openssl rand -hex 32)"
		set_value IDP_STORAGE_KEY "$(openssl rand -hex 32)"
	else
		# The master-realm bootstrap admin (the overlay maps these onto
		# Keycloak 26's KC_BOOTSTRAP_ADMIN_* names). Minted, shown once at
		# the end of the install, resettable in the Admin Console after.
		set_value KEYCLOAK_ADMIN "admin"
		token_url_safe 24
		set_value KEYCLOAK_ADMIN_PASSWORD "$TOKEN_VAL"
	fi
}

# ------------------------------------------------------------------ #
# validation: fail closed before anything is written or started       #
# ------------------------------------------------------------------ #

is_absolute_url() { # -> 0 when $1 is an absolute http(s) URL
	[[ "${1:-}" =~ ^https?://[^[:space:]]+$ ]]
}

# The IP-shape test the installer has always inlined (four dot-separated
# digit groups, no range check): browsers refuse a Domain cookie on a bare
# IP, and Caddy cannot Let's-Encrypt one, so the choice of default port and
# certificate mode hangs on it.
is_ipv4() { # -> 0 when $1 is IP-shaped
	[[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
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
		# Shared-key mode needs its key: generic always, satellite only with
		# a local IdP (central mode bills the signer's own token instead).
		if [ "$profile" = "generic" ]; then REQUIRED+=(OPENAI_API_KEY); fi
		if [ "$profile" = "satellite" ] && [ "${IDP_BUNDLED:-}" = "authelia" ]; then
			REQUIRED+=(OPENAI_API_KEY)
		fi
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
		# picked: external and bundled both name OIDC clients on the two
		# sides, house names the house IdP's two values, custom requires
		# nothing (each side was asked optionally, and whatever stayed
		# empty is console work later).
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
		# Team-bundled names OIDC clients like enterprise-external; the
		# house shapes name the house IdP instead.
		if [ -n "${IDP_BUNDLED:-}" ]; then
			REQUIRED+=(GATEWAY_OIDC__ISSUER GATEWAY_OIDC__CLIENT_ID
				GATEWAY_OIDC__CLIENT_SECRET CHAT_OIDC_PROVIDER_URL CHAT_OIDC_CLIENT_ID
				CHAT_OIDC_CLIENT_SECRET)
		else
			# The signing key is deliberately absent from this list: it arrives as
			# a file (fresh installs) or inline (legacy resumes), and
			# validate_values checks the two shapes below rather than a name.
			REQUIRED+=(GATEWAY_IDP__ISSUER GATEWAY_IDP__INTERNAL_TOKEN)
		fi
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
	# Bundled Authelia on a bare IP refuses: browsers will not hold a Domain
	# cookie on an IP, so the login session never sticks (the generator
	# enforces a dotted domain for the same reason). Keycloak has no such
	# constraint. Point a name at this box and re-run.
	if [ "${vals[IDP_BUNDLED]:-}" = "authelia" ] && is_ipv4 "${vals[PUBLIC_HOST]:-}"; then
		fail "bundled Authelia needs a name, not ${vals[PUBLIC_HOST]}: browsers refuse a Domain cookie holding a bare IP, so nobody could stay signed in."
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
		if [ -n "${vals[IDP_BUNDLED]:-}" ]; then
			if [ "${vals[IDP_BUNDLED]:-}" != "authelia" ]; then
				fail "satellite supports only the bundled Authelia (got '${vals[IDP_BUNDLED]}')."
			fi
			# Shared-key mode, the only coherent pairing: central's /v1
			# never accepts a local-IdP token (wrong iss), so inference
			# bills the stored central key and no user token may flow.
			if [ -z "$REPLY_VAL" ]; then
				fail "satellite with a local IdP sets OPENAI_API_KEY: central's /v1 never accepts the local IdP's tokens, so a stored central key pays for every call."
			fi
			if [ "${vals[USE_USER_TOKEN]:-}" != "false" ]; then
				fail "satellite with a local IdP forces USE_USER_TOKEN=false: the local token unlocks nothing on central, and sending it out would leak a credential that does unlock this box's accounts."
			fi
		elif [ -n "$REPLY_VAL" ]; then
			fail "satellite sets no OPENAI_API_KEY: the catalogue fetch is public (ADR 0081) and every real call carries the user's own token — a stored key would bill every user to one account."
		fi
	fi
	if [ "$profile" = "generic" ] && [ "${vals[USE_USER_TOKEN]:-}" = "true" ]; then
		fail "generic forces USE_USER_TOKEN=false: user-token mode would send the signed-in person's IdP access token out as a Bearer to the third party."
	fi
}

# ------------------------------------------------------------------ #
# prompt defaults: computed, never duplicated inline                  #
# ------------------------------------------------------------------ #

# The proxy exposure's HTTPS port default: a bare IP self-signs from its own
# CA on 8443, a name can take 443 for Let's Encrypt.
default_https_port() { # default_https_port <public-host> -> HTTPS_PORT_DEFAULT
	if is_ipv4 "$1"; then HTTPS_PORT_DEFAULT=8443; else HTTPS_PORT_DEFAULT=443; fi
}

# The public origin the operator is offered: whatever a resumed .env
# already declared, else https://host on 443, else https://host:port.
default_public_origin() { # default_public_origin <parsed-origin|empty> <public-host> <https-port> -> ORIGIN_DEFAULT
	if [ -n "$1" ]; then
		ORIGIN_DEFAULT="$1"
	elif [ "$3" = "443" ]; then
		ORIGIN_DEFAULT="https://$2"
	else
		ORIGIN_DEFAULT="https://$2:$3"
	fi
}

# ------------------------------------------------------------------ #
# resume inference: --phase2 rebuilds the toggles from the parsed .env #
#                                                                    #
# LEGACY FALLBACK ONLY. Installs made by this installer write an      #
# installer-metadata block into deploy/.env (lib/envfile.sh), and     #
# --phase2 reads the shape from it verbatim (apply_metadata_shape).   #
# These infer_* heuristics exist for .env files written before the    #
# block existed: they reverse-engineer the shape from which values    #
# are set, which has mis-inferred shapes live (standalone-vs-gateway, #
# usage shown-vs-hidden). Do not extend them; fix the block writer.   #
# ------------------------------------------------------------------ #

infer_standalone_toggles() { # -> REDACTION_STATE + ST_* (reads PARSED) — LEGACY FALLBACK, see the section header
	REDACTION_STATE="off"
	ST_FETCH="${PARSED[FETCH_BACKEND]:-direct}"
	[ -z "$ST_FETCH" ] && ST_FETCH="direct"
	ST_METERING=0
	[ "${PARSED[CHAT_CODE_TOOL_ENABLED]:-}" = "true" ] && ST_CODETOOL=1 || ST_CODETOOL=0
	[ "${PARSED[CHAT_USAGE_ENABLED]:-}" = "true" ] && ST_USAGE=1 || ST_USAGE=0
	[ "${PARSED[CHAT_KNOWLEDGE_ENABLED]:-}" != "false" ] && ST_KNOWLEDGE=1 || ST_KNOWLEDGE=0
	[ "${PARSED[CHAT_MEMORY_ENABLED]:-}" != "false" ] && ST_MEMORY=1 || ST_MEMORY=0
	# The /code panel flag (ADR 0085): the chat overlay interpolates it from
	# deploy/.env, so the block-less fallback reads exactly what the chat
	# itself will read.
	[ "${PARSED[CODE_AGENTS_ENABLED]:-}" = "true" ] && ST_CODEPANEL=1 || ST_CODEPANEL=0
}

infer_gateway_toggles() { # -> REDACTION_STATE + ST_* (reads PARSED) — LEGACY FALLBACK, see the section header
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
	[ "${PARSED[CODE_AGENTS_ENABLED]:-}" = "true" ] && ST_CODEPANEL=1 || ST_CODEPANEL=0
}

# The enterprise sign-in shape is inferred the same way: a bundled
# provider means its shape, external console OIDC means external, house
# IdP on means house, neither means a custom split someone assembled by
# hand. LEGACY FALLBACK — the metadata block's INSTALLER_AUTH_MODE is
# authoritative on installs that carry one.
infer_auth_mode() { # -> AUTH_MODE (reads PARSED) — LEGACY FALLBACK, see the section header
	if [ "${PARSED[GATEWAY_OIDC__ENABLED]:-}" = "true" ]; then
		case "${PARSED[IDP_BUNDLED]:-}" in
			authelia) AUTH_MODE="bundled-authelia" ;;
			keycloak) AUTH_MODE="bundled-keycloak" ;;
			*) AUTH_MODE="external" ;;
		esac
	elif [ "${PARSED[GATEWAY_IDP__ENABLED]:-}" = "true" ]; then
		AUTH_MODE="house"
	else
		AUTH_MODE="custom"
	fi
}

# ------------------------------------------------------------------ #
# the component vocabulary: what --components and the installer        #
# metadata block both speak                                            #
# ------------------------------------------------------------------ #

# The seven component toggles, serialized as comma-separated key=value
# words. This one vocabulary serves three surfaces on purpose: the
# --components flag (a fresh run's override over the profile defaults),
# the INSTALLER_COMPONENTS line of the metadata block (what the install
# decided), and --phase2's verbatim restore. Values:
#   redaction  off|pattern|ner      (REDACTION_STATE)
#   fetch      direct|playwright    (ST_FETCH)
#   metering   on|off               (ST_METERING)
#   usage      shown|hidden         (ST_USAGE)
#   code-tool  on|off               (ST_CODETOOL)
#   knowledge  on|off               (ST_KNOWLEDGE)
#   memory     on|off               (ST_MEMORY)
COMPONENT_VALUE_WORDS=(
	"redaction:off pattern ner"
	"fetch:direct playwright"
	"metering:on off"
	"usage:shown hidden"
	"code-tool:on off"
	"knowledge:on off"
	"memory:on off"
	"code-panel:on off"
)

components_value_ok() { # components_value_ok <key> <value>
	# IFS is pinned: the caller (components_parse) word-splits on commas and
	# bash's dynamic scoping would otherwise leak that IFS in here, gluing
	# this function's value words into one unsplit token.
	local IFS=" "
	local spec k vals
	for spec in "${COMPONENT_VALUE_WORDS[@]}"; do
		k="${spec%%:*}"
		vals="${spec#*:}"
		if [ "$k" = "$1" ]; then
			local v
			for v in $vals; do
				[ "$v" = "$2" ] && return 0
			done
			return 1
		fi
	done
	return 2
}

components_parse() { # components_parse <spec> <map-name> — nameref map of key -> value
	# The target must be declared associative HERE: `out=()` on a nameref to
	# an undeclared name would create an indexed array, and `${out[key]}`
	# would then evaluate the key as arithmetic (an "unbound variable" under
	# set -u).
	declare -gA "$2=()"
	local -n out="$2"
	local spec="$1" pair k v
	[ -n "$spec" ] || fail "the component spec is empty (expected key=value pairs, e.g. redaction=pattern,fetch=direct)."
	out=()
	local IFS=','
	for pair in $spec; do
		trim "$pair"
		pair="$REPLY_VAL"
		[ -n "$pair" ] || continue
		case "$pair" in
			*=*) ;;
			*) fail "component '$pair' is not key=value (e.g. redaction=pattern,fetch=direct)." ;;
		esac
		k="${pair%%=*}"
		v="${pair#*=}"
		[ -n "${out[$k]+x}" ] && fail "component '$k' appears twice in the spec."
		components_value_ok "$k" "$v" ||
			fail "component '$k=$v' is outside the vocabulary (redaction=off|pattern|ner, fetch=direct|playwright, metering=on|off, usage=shown|hidden, code-tool=on|off, knowledge=on|off, memory=on|off, code-panel=on|off)."
		out[$k]="$v"
	done
	[ "${#out[@]}" -gt 0 ] || fail "the component spec carries no key=value pairs."
}

components_to_shape() { # components_to_shape <spec> -> ST_* + REDACTION_STATE
	components_parse "$1" SHAPE_MAP
	local k v
	for k in "${!SHAPE_MAP[@]}"; do
		v="${SHAPE_MAP[$k]}"
		case "$k" in
			redaction) ST_REDACTION="$v" ;;
			fetch) ST_FETCH="$v" ;;
			metering) [ "$v" = "on" ] && ST_METERING=1 || ST_METERING=0 ;;
			usage) [ "$v" = "shown" ] && ST_USAGE=1 || ST_USAGE=0 ;;
			code-tool) [ "$v" = "on" ] && ST_CODETOOL=1 || ST_CODETOOL=0 ;;
			knowledge) [ "$v" = "on" ] && ST_KNOWLEDGE=1 || ST_KNOWLEDGE=0 ;;
			memory) [ "$v" = "on" ] && ST_MEMORY=1 || ST_MEMORY=0 ;;
			code-panel) [ "$v" = "on" ] && ST_CODEPANEL=1 || ST_CODEPANEL=0 ;;
		esac
	done
	# REDACTION_STATE mirrors ST_REDACTION — the same copy main() makes
	# after toggle_components, kept here so the function is self-consistent
	# wherever it runs (every caller has profile defaults or an inferred
	# shape in ST_REDACTION already when the spec is partial).
	REDACTION_STATE="${ST_REDACTION:-off}"
}

shape_to_components() { # -> COMPONENTS_SPEC, from REDACTION_STATE + ST_*
	COMPONENTS_SPEC="redaction=${REDACTION_STATE:-off},fetch=${ST_FETCH:-direct},metering=$( [ "${ST_METERING:-0}" = "1" ] && echo on || echo off),usage=$( [ "${ST_USAGE:-0}" = "1" ] && echo shown || echo hidden),code-tool=$( [ "${ST_CODETOOL:-0}" = "1" ] && echo on || echo off),knowledge=$( [ "${ST_KNOWLEDGE:-0}" = "1" ] && echo on || echo off),memory=$( [ "${ST_MEMORY:-0}" = "1" ] && echo on || echo off),code-panel=$( [ "${ST_CODEPANEL:-0}" = "1" ] && echo on || echo off)"
}

components_differ() { # components_differ <specA> <specB> -> exit 0 when shared keys disagree
	# Only the keys BOTH specs carry are compared: the flag may omit keys
	# (a partial override keeps the recorded shape for them), but where it
	# speaks it must agree with what the install recorded — a contradiction
	# is the operator's mistake to surface, not an override to apply.
	components_parse "$1" DIFF_A
	components_parse "$2" DIFF_B
	local k
	for k in redaction fetch metering usage code-tool knowledge memory code-panel; do
		if [ -n "${DIFF_A[$k]+x}" ] && [ -n "${DIFF_B[$k]+x}" ] &&
			[ "${DIFF_A[$k]}" != "${DIFF_B[$k]}" ]; then
			return 0
		fi
	done
	return 1
}

# ------------------------------------------------------------------ #
# the installer metadata block: the shape, carried by deploy/.env      #
# ------------------------------------------------------------------ #

# Shape-semantics version of the metadata vocabulary. Bump when a key's
# meaning changes (never when only a value's spelling is added — that is
# what the vocabulary validation rejects loudly).
INSTALLER_META_VERSION=1

is_valid_profile() {
	case "$1" in
		homelab | team | enterprise | satellite | generic) return 0 ;;
		*) return 1 ;;
	esac
}

is_valid_exposure() {
	case "$1" in
		edge | proxy) return 0 ;;
		*) return 1 ;;
	esac
}

is_valid_idp_word() {
	case "$1" in
		house | external | custom | central | authelia | keycloak) return 0 ;;
		*) return 1 ;;
	esac
}

is_valid_auth_mode_word() {
	case "$1" in
		house | external | custom | central | bundled-authelia | bundled-keycloak) return 0 ;;
		*) return 1 ;;
	esac
}

# The sign-in shape as the metadata block records it: INSTALLER_IDP is the
# menu word (what --idp spells), INSTALLER_AUTH_MODE the resolved mode
# (what required_keys_for branches on for enterprise). Both derived from
# the same globals the .env values were written from, so block and values
# cannot drift within one install.
installer_idp_word() { # -> stdout
	case "${PROFILE:-}" in
		enterprise)
			case "${AUTH_MODE:-}" in
				bundled-authelia) echo "authelia" ;;
				bundled-keycloak) echo "keycloak" ;;
				*) echo "${AUTH_MODE:-external}" ;;
			esac
			;;
		homelab) echo "house" ;;
		team)
			if [ -n "${IDP_BUNDLED:-}" ]; then echo "$IDP_BUNDLED"; else echo "house"; fi
			;;
		satellite)
			if [ -n "${IDP_BUNDLED:-}" ]; then echo "authelia"; else echo "central"; fi
			;;
		generic) echo "external" ;;
		*) echo "" ;;
	esac
}

installer_auth_mode_word() { # -> stdout
	case "${PROFILE:-}" in
		enterprise) echo "${AUTH_MODE:-external}" ;;
		homelab) echo "house" ;;
		team)
			if [ -n "${IDP_BUNDLED:-}" ]; then echo "bundled-$IDP_BUNDLED"; else echo "house"; fi
			;;
		satellite)
			if [ -n "${IDP_BUNDLED:-}" ]; then echo "bundled-authelia"; else echo "central"; fi
			;;
		generic) echo "external" ;;
		*) echo "" ;;
	esac
}

# Restore the shape from a metadata block the installer itself wrote.
# Unlike the infer_* fallbacks above, nothing is guessed: every key is
# validated and every missing one is a loud error. PROFILE and EXPOSURE
# are the callers' decision (flag beats block, contradictions fail at the
# call site); this sets AUTH_MODE, REDACTION_STATE and the ST_* toggles.
apply_metadata_shape() { # apply_metadata_shape (reads INSTALLER_META from lib/envfile.sh)
	local v="${INSTALLER_META[INSTALLER_VERSION]:-}"
	[ -n "$v" ] || fail "the installer metadata block carries no INSTALLER_VERSION."
	[ "$v" = "$INSTALLER_META_VERSION" ] ||
		fail "the installer metadata block was written by shape version $v; this installer speaks version $INSTALLER_META_VERSION. Re-install fresh, or use an installer that reads this version."
	local p="${INSTALLER_META[INSTALLER_PROFILE]:-}"
	[ -z "$p" ] || is_valid_profile "$p" || fail "INSTALLER_PROFILE='$p' in the installer metadata block is not a known profile (homelab|team|enterprise|satellite|generic)."
	local e="${INSTALLER_META[INSTALLER_EXPOSURE]:-}"
	[ -z "$e" ] || is_valid_exposure "$e" || fail "INSTALLER_EXPOSURE='$e' in the installer metadata block is not a known exposure (edge|proxy)."
	local i="${INSTALLER_META[INSTALLER_IDP]:-}"
	[ -z "$i" ] || is_valid_idp_word "$i" || fail "INSTALLER_IDP='$i' in the installer metadata block is not a known sign-in shape (house|external|custom|central|authelia|keycloak)."
	local am="${INSTALLER_META[INSTALLER_AUTH_MODE]:-}"
	[ -z "$am" ] || is_valid_auth_mode_word "$am" || fail "INSTALLER_AUTH_MODE='$am' in the installer metadata block is not a known sign-in mode."
	AUTH_MODE="$am"
	local c="${INSTALLER_META[INSTALLER_COMPONENTS]:-}"
	[ -n "$c" ] || fail "the installer metadata block carries no INSTALLER_COMPONENTS."
	components_to_shape "$c"
	# The block is the installer's own serialization: every word the current
	# vocabulary carries must be there, so the restored shape is complete
	# rather than partially defaulted. 'code-panel' is the one word an older
	# block may lack (the vocabulary predates ADR 0085): its absence means
	# off, which is what the install that wrote the block did — a block from
	# before the panel existed cannot have turned it on.
	local k
	for k in redaction fetch metering usage code-tool knowledge memory code-panel; do
		case "$k" in
			redaction) [ -n "${ST_REDACTION+x}" ] || fail "INSTALLER_COMPONENTS is missing the 'redaction' word." ;;
			fetch) [ -n "${ST_FETCH+x}" ] || fail "INSTALLER_COMPONENTS is missing the 'fetch' word." ;;
			metering) [ -n "${ST_METERING+x}" ] || fail "INSTALLER_COMPONENTS is missing the 'metering' word." ;;
			usage) [ -n "${ST_USAGE+x}" ] || fail "INSTALLER_COMPONENTS is missing the 'usage' word." ;;
			code-tool) [ -n "${ST_CODETOOL+x}" ] || fail "INSTALLER_COMPONENTS is missing the 'code-tool' word." ;;
			knowledge) [ -n "${ST_KNOWLEDGE+x}" ] || fail "INSTALLER_COMPONENTS is missing the 'knowledge' word." ;;
			memory) [ -n "${ST_MEMORY+x}" ] || fail "INSTALLER_COMPONENTS is missing the 'memory' word." ;;
			code-panel) [ -n "${ST_CODEPANEL+x}" ] || ST_CODEPANEL=0 ;;
		esac
	done
	REDACTION_STATE="$ST_REDACTION"
}
