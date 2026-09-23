#!/usr/bin/env bash
# Tests for lib/values.sh: validators, the value store, the derived IdP
# value shapes, prompt defaults, and the --phase2 resume inference.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
. tests/lib.sh
. lib/term.sh
. lib/values.sh

reset_values() {
	unset VALUES VALUES_ORDER
	declare -gA VALUES=()
	VALUES_ORDER=()
}

reset_parsed() {
	unset PARSED PARSED_ORDER
	declare -gA PARSED=()
	PARSED_ORDER=()
}

# vals <profile> <exposure> [K=V ...] — populate the VALS map and derive
# REQUIRED, exactly the state main() establishes before validate_values.
# The validate call itself must go through assert_ok / assert_fails_with so
# a lib `fail` ends its subshell, not this test file.
vals() {
	local profile="$1" exposure="$2"; shift 2
	declare -gA VALS=()
	local kv
	for kv in "$@"; do VALS[${kv%%=*}]="${kv#*=}"; done
	required_keys_for "$profile" "$exposure"
}

# ---- trim
trim "  hello world  "
assert_eq "trim strips both ends" "hello world" "$REPLY_VAL"
trim $'\t spaced \n'
assert_eq "trim strips tab/newline edges" "spaced" "$REPLY_VAL"
trim ""
assert_eq "trim of empty stays empty" "" "$REPLY_VAL"
trim 'back\slash kept'
assert_eq "trim keeps backslashes intact" 'back\slash kept' "$REPLY_VAL"

# ---- is_absolute_url
assert_ok "absolute https URL accepted" is_absolute_url "https://cerea.example/chat"
assert_ok "absolute http URL accepted" is_absolute_url "http://127.0.0.1:8000"
assert_fails "bare hostname refused" is_absolute_url "cerea.example"
assert_fails "empty refused" is_absolute_url ""
assert_fails "embedded space refused" is_absolute_url "https://a b/"
assert_fails "bare path refused" is_absolute_url "/chat"

# ---- is_ipv4 (shape heuristic, as the installer always used it)
assert_ok "10.0.0.7 is IP-shaped" is_ipv4 "10.0.0.7"
assert_fails "a hostname is not IP-shaped" is_ipv4 "cerea.example"
assert_fails "three groups are not IP-shaped" is_ipv4 "1.2.3"
assert_fails "empty is not IP-shaped" is_ipv4 ""

# ---- profiles
assert_eq "profile_fragment homelab" "homelab.env" "$(profile_fragment homelab)"
assert_eq "profile_fragment enterprise" "enterprise.env" "$(profile_fragment enterprise)"
assert_fails "profile_fragment refuses unknown profiles" profile_fragment bogusp
assert_ok "satellite is standalone" is_standalone_profile satellite
assert_ok "generic is standalone" is_standalone_profile generic
assert_fails "team is not standalone" is_standalone_profile team
assert_fails "homelab is not standalone" is_standalone_profile homelab

# ---- token_url_safe: the secrets.token_urlsafe shape
token_url_safe 32
assert_eq "32 bytes -> 43 urlsafe chars" "43" "${#TOKEN_VAL}"
case "$TOKEN_VAL" in
	*[+/=]*) flunk "token_url_safe leaks std-base64 alphabet or padding" ;;
	*) pass "token_url_safe uses the urlsafe alphabet, no padding" ;;
esac
token_url_safe 48
assert_eq "48 bytes -> 64 chars" "64" "${#TOKEN_VAL}"
token_url_safe 24
assert_eq "24 bytes -> 32 chars" "32" "${#TOKEN_VAL}"

# ---- set_value: insertion order kept, overwrite in place
reset_values
set_value POSTGRES_PASSWORD one
set_value PUBLIC_HOST two
set_value POSTGRES_PASSWORD three
assert_eq "first insert appends to VALUES_ORDER" "POSTGRES_PASSWORD PUBLIC_HOST" "${VALUES_ORDER[*]}"
assert_eq "overwrite replaces the value, keeps the position" "three" "${VALUES[POSTGRES_PASSWORD]}"

# ---- assert_values_single_line
reset_values
set_value OK simple
assert_ok "single-line values pass" assert_values_single_line
reset_values
set_value BROKEN $'line1\nline2'
assert_fails_with "newline in a value is refused" "line break" assert_values_single_line
reset_values
set_value BROKEN $'line1\rline2'
assert_fails_with "carriage return in a value is refused" "line break" assert_values_single_line

# ---- set_house_idp_values: everything derives from PUBLIC_ORIGIN + chat secret
reset_values
set_value PUBLIC_ORIGIN "https://cerea.example:8443"
set_value CHAT_IDP_CLIENT_SECRET "chat-secret"
set_house_idp_values
assert_eq "house issuer is the public origin" "https://cerea.example:8443" "${VALUES[GATEWAY_IDP__ISSUER]}"
assert_eq "house internal base stays on the compose network" "http://gateway:8000" "${VALUES[GATEWAY_IDP__INTERNAL_BASE_URL]}"
assert_eq "house IdP is enabled" "true" "${VALUES[GATEWAY_IDP__ENABLED]}"
assert_contains "client registry names the chat client" '"client_id":"cerea"' "${VALUES[GATEWAY_IDP__CLIENTS]}"
assert_contains "client registry points at the chat callback" '"redirect_path":"/chat/login/callback"' "${VALUES[GATEWAY_IDP__CLIENTS]}"
assert_contains "client registry carries the minted chat secret" '"secret":"chat-secret"' "${VALUES[GATEWAY_IDP__CLIENTS]}"

# ---- set_bundled_idp_values: authelia shape
reset_values
set_value PUBLIC_ORIGIN "https://cerea.example"
set_value CHAT_IDP_CLIENT_SECRET "shared-secret"
IDP_ADMIN_EMAIL="op@example.org"
set_bundled_idp_values authelia "shared-secret"
assert_eq "authelia issuer is origin + /authelia" "https://cerea.example/authelia" "${VALUES[GATEWAY_OIDC__ISSUER]}"
assert_eq "authelia chat client id" "cerea" "${VALUES[CHAT_OIDC_CLIENT_ID]}"
assert_eq "satellite passes one shared chat secret through" "shared-secret" "${VALUES[CHAT_OIDC_CLIENT_SECRET]}"
assert_eq "bundled IdP turns the house IdP off" "false" "${VALUES[GATEWAY_IDP__ENABLED]}"
assert_eq "bundled IdP turns external OIDC on" "true" "${VALUES[GATEWAY_OIDC__ENABLED]}"
assert_eq "audience is fixed by the overlays, never prompted" "pystino-api" "${VALUES[GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE]}"
assert_eq "authelia scopes carry groups" "openid profile email groups" "${VALUES[CHAT_OIDC_SCOPES]}"
assert_eq "IDP_BUNDLED recorded" "authelia" "${VALUES[IDP_BUNDLED]}"
assert_eq "console client id" "pystino-console" "${VALUES[GATEWAY_OIDC__CLIENT_ID]}"
assert_eq "the local-link flag ships with bundled shapes" "true" "${VALUES[GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL]}"
assert_eq "the operator email is recorded for the resume re-seed" "op@example.org" "${VALUES[IDP_ADMIN_EMAIL]}"
assert_eq "authelia session secret minted, 64 hex chars" "64" "${#VALUES[IDP_SESSION_SECRET]}"
case "${VALUES[IDP_SESSION_SECRET]}" in
	*[!0-9a-f]*) flunk "IDP_SESSION_SECRET is lowercase hex" ;;
	*) pass "IDP_SESSION_SECRET is lowercase hex" ;;
esac

# ---- set_bundled_idp_values: keycloak shape
reset_values
set_value PUBLIC_ORIGIN "https://cerea.example"
set_bundled_idp_values keycloak
assert_eq "keycloak issuer is origin + realm path" "https://cerea.example/idp/realms/pystino" "${VALUES[GATEWAY_OIDC__ISSUER]}"
assert_eq "keycloak chat client id" "pystino-chat" "${VALUES[CHAT_OIDC_CLIENT_ID]}"
assert_eq "keycloak chat secret minted when none passed" "64" "${#VALUES[CHAT_OIDC_CLIENT_SECRET]}"
assert_eq "keycloak bootstrap admin" "admin" "${VALUES[KEYCLOAK_ADMIN]}"
assert_eq "keycloak bootstrap password minted" "32" "${#VALUES[KEYCLOAK_ADMIN_PASSWORD]}"
assert_eq "the local-link flag ships with keycloak too" "true" "${VALUES[GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL]}"
assert_eq "keycloak's operator email is the realm template's fixed first human" \
	"owner@example.org" "${VALUES[IDP_ADMIN_EMAIL]}"

# ---- required_keys_for: one exact list per shape
REDACTION_STATE="off"
AUTH_MODE=""
IDP_BUNDLED=""
required_keys_for homelab edge
assert_eq "homelab/edge (house IdP)" \
	"POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET CHAT_PG_URL CHAT_IDP_CLIENT_SECRET CHAT_SECRET_KEY CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN GATEWAY_IDP__ISSUER GATEWAY_IDP__INTERNAL_TOKEN" \
	"${REQUIRED[*]}"

IDP_BUNDLED="authelia"
REDACTION_STATE="pattern"
required_keys_for team edge
assert_eq "team/edge with bundled Authelia (OIDC clients both sides, redaction key)" \
	"POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET CHAT_PG_URL CHAT_IDP_CLIENT_SECRET CHAT_SECRET_KEY CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN REDACTION_PLACEHOLDER_KEY GATEWAY_OIDC__ISSUER GATEWAY_OIDC__CLIENT_ID GATEWAY_OIDC__CLIENT_SECRET CHAT_OIDC_PROVIDER_URL CHAT_OIDC_CLIENT_ID CHAT_OIDC_CLIENT_SECRET" \
	"${REQUIRED[*]}"

AUTH_MODE="external"
REDACTION_STATE="ner"
required_keys_for enterprise proxy
assert_eq "enterprise/proxy external (NER key + OIDC clients + ACME)" \
	"POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET CHAT_PG_URL CHAT_IDP_CLIENT_SECRET CHAT_SECRET_KEY CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN REDACTION_PLACEHOLDER_KEY GATEWAY_OIDC__ISSUER GATEWAY_OIDC__CLIENT_ID GATEWAY_OIDC__CLIENT_SECRET CHAT_OIDC_PROVIDER_URL CHAT_OIDC_CLIENT_ID CHAT_OIDC_CLIENT_SECRET ACME_EMAIL" \
	"${REQUIRED[*]}"

AUTH_MODE="house"
REDACTION_STATE="off"
required_keys_for enterprise edge
assert_eq "enterprise/edge house (house IdP names, no redaction key)" \
	"POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET CHAT_PG_URL CHAT_IDP_CLIENT_SECRET CHAT_SECRET_KEY CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN GATEWAY_IDP__ISSUER GATEWAY_IDP__INTERNAL_TOKEN" \
	"${REQUIRED[*]}"

AUTH_MODE="custom"
required_keys_for enterprise edge
assert_eq "enterprise/edge custom (nothing beyond the base)" \
	"POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET CHAT_PG_URL CHAT_IDP_CLIENT_SECRET CHAT_SECRET_KEY CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN" \
	"${REQUIRED[*]}"

unset AUTH_MODE
required_keys_for enterprise edge
assert_eq "enterprise with AUTH_MODE unset defaults to external's list" \
	"POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET CHAT_PG_URL CHAT_IDP_CLIENT_SECRET CHAT_SECRET_KEY CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN GATEWAY_OIDC__ISSUER GATEWAY_OIDC__CLIENT_ID GATEWAY_OIDC__CLIENT_SECRET CHAT_OIDC_PROVIDER_URL CHAT_OIDC_CLIENT_ID CHAT_OIDC_CLIENT_SECRET" \
	"${REQUIRED[*]}"

IDP_BUNDLED="authelia"
required_keys_for satellite edge
assert_eq "satellite/edge with local Authelia (shared key required)" \
	"POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET OPENAI_BASE_URL CHAT_PG_URL CHAT_IDP_CLIENT_SECRET CHAT_SECRET_KEY CHAT_OIDC_PROVIDER_URL CHAT_OIDC_CLIENT_ID CHAT_OIDC_CLIENT_SECRET CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN OPENAI_API_KEY" \
	"${REQUIRED[*]}"
required_keys_for satellite proxy
assert_eq "satellite/proxy adds ACME_EMAIL" \
	"POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET OPENAI_BASE_URL CHAT_PG_URL CHAT_IDP_CLIENT_SECRET CHAT_SECRET_KEY CHAT_OIDC_PROVIDER_URL CHAT_OIDC_CLIENT_ID CHAT_OIDC_CLIENT_SECRET CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN OPENAI_API_KEY ACME_EMAIL" \
	"${REQUIRED[*]}"

IDP_BUNDLED=""
required_keys_for satellite edge
assert_eq "satellite/edge central mode (no stored key required)" \
	"POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET OPENAI_BASE_URL CHAT_PG_URL CHAT_IDP_CLIENT_SECRET CHAT_SECRET_KEY CHAT_OIDC_PROVIDER_URL CHAT_OIDC_CLIENT_ID CHAT_OIDC_CLIENT_SECRET CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN" \
	"${REQUIRED[*]}"
required_keys_for generic edge
assert_eq "generic/edge always requires the shared key" \
	"POSTGRES_PASSWORD GATEWAY_SECRET_KEY GATEWAY_SESSION_SECRET OPENAI_BASE_URL CHAT_PG_URL CHAT_IDP_CLIENT_SECRET CHAT_SECRET_KEY CHAT_OIDC_PROVIDER_URL CHAT_OIDC_CLIENT_ID CHAT_OIDC_CLIENT_SECRET CHAT_REPO PUBLIC_HOST PUBLIC_ORIGIN OPENAI_API_KEY" \
	"${REQUIRED[*]}"

# ---- validate_values: accept and reject
REDACTION_STATE="off"
AUTH_MODE=""
IDP_BUNDLED=""
vals homelab edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_REPO=/repo PUBLIC_HOST=cerea.example \
	PUBLIC_ORIGIN=https://cerea.example GATEWAY_IDP__ENABLED=true \
	GATEWAY_IDP__ISSUER=https://cerea.example GATEWAY_IDP__INTERNAL_TOKEN=tok \
	IDP_SIGNING_KEY_HOST_PATH=/tmp/key.pem \
	GATEWAY_IDP__SIGNING_KEY_FILE=/run/idp/signing-key.pem
assert_ok "homelab happy path (house IdP, file-pair key)" validate_values homelab VALS

vals homelab edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_REPO=/repo PUBLIC_HOST=cerea.example \
	PUBLIC_ORIGIN=https://cerea.example GATEWAY_IDP__ENABLED=true \
	GATEWAY_IDP__ISSUER=https://cerea.example GATEWAY_IDP__INTERNAL_TOKEN=tok \
	IDP_SIGNING_KEY_HOST_PATH=/tmp/key.pem \
	GATEWAY_IDP__SIGNING_KEY_FILE=/run/idp/signing-key.pem
assert_fails_with "an empty required value fails with its name" "CHAT_SECRET_KEY" validate_values homelab VALS
assert_fails_with "validate_values refuses missing CHAT_SECRET_KEY" "empty required values" validate_values homelab VALS

vals homelab edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_REPO=/repo PUBLIC_HOST=cerea.example \
	PUBLIC_ORIGIN=https://cerea.example GATEWAY_IDP__ENABLED=true \
	GATEWAY_IDP__ISSUER=gateway.local GATEWAY_IDP__INTERNAL_TOKEN=tok \
	IDP_SIGNING_KEY_HOST_PATH=/tmp/key.pem \
	GATEWAY_IDP__SIGNING_KEY_FILE=/run/idp/signing-key.pem
assert_fails_with "house issuer must be absolute" "must be an absolute http(s) URL when the house IdP is on" validate_values homelab VALS

vals homelab edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_REPO=/repo PUBLIC_HOST=cerea.example \
	PUBLIC_ORIGIN=https://cerea.example GATEWAY_IDP__ENABLED=true \
	GATEWAY_IDP__ISSUER=https://cerea.example GATEWAY_IDP__INTERNAL_TOKEN=tok \
	GATEWAY_IDP__SIGNING_KEY=inline-pem \
	IDP_SIGNING_KEY_HOST_PATH=/tmp/key.pem
assert_fails_with "inline key + key file together is refused" "not both" validate_values homelab VALS

vals homelab edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_REPO=/repo PUBLIC_HOST=cerea.example \
	PUBLIC_ORIGIN=https://cerea.example GATEWAY_IDP__ENABLED=true \
	GATEWAY_IDP__ISSUER=https://cerea.example GATEWAY_IDP__INTERNAL_TOKEN=tok
assert_fails_with "house IdP with no key shape at all is refused" "needs a signing key" validate_values homelab VALS

vals homelab edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_REPO=/repo PUBLIC_HOST=cerea.example \
	PUBLIC_ORIGIN=https://cerea.example GATEWAY_IDP__ENABLED=false \
	GATEWAY_IDP__ISSUER=https://cerea.example GATEWAY_IDP__INTERNAL_TOKEN=tok \
	GATEWAY_OIDC__ENABLED=true GATEWAY_OIDC__ISSUER=not-a-url
assert_fails_with "external OIDC issuer must be absolute" "GATEWAY_OIDC__ISSUER must be an absolute http(s) URL" validate_values homelab VALS

vals homelab edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_REPO=/repo PUBLIC_HOST=10.0.0.7 \
	PUBLIC_ORIGIN=https://10.0.0.7 IDP_BUNDLED=authelia \
	GATEWAY_IDP__ISSUER=https://cerea.example GATEWAY_IDP__INTERNAL_TOKEN=tok
assert_fails_with "bundled Authelia on a bare IP is refused" "needs a name, not 10.0.0.7" validate_values homelab VALS

IDP_BUNDLED="authelia"
vals satellite edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	OPENAI_BASE_URL=https://central.example CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat \
	CHAT_IDP_CLIENT_SECRET=cis CHAT_SECRET_KEY=csk CHAT_OIDC_PROVIDER_URL=https://cerea.example/authelia \
	CHAT_OIDC_CLIENT_ID=cerea CHAT_OIDC_CLIENT_SECRET=ccs CHAT_REPO=/repo \
	PUBLIC_HOST=cerea.example PUBLIC_ORIGIN=https://cerea.example IDP_BUNDLED=authelia
# The required-values net catches this first (the satellite+authelia list
# includes OPENAI_API_KEY), before the satellite-specific message could.
assert_fails_with "satellite + local IdP without the central key dies on the required list" \
	"OPENAI_API_KEY" validate_values satellite VALS

vals satellite edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	OPENAI_BASE_URL=https://central.example OPENAI_API_KEY=sk \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_OIDC_PROVIDER_URL=https://cerea.example/authelia \
	CHAT_OIDC_CLIENT_ID=cerea CHAT_OIDC_CLIENT_SECRET=ccs CHAT_REPO=/repo \
	PUBLIC_HOST=cerea.example PUBLIC_ORIGIN=https://cerea.example IDP_BUNDLED=authelia \
	USE_USER_TOKEN=true
assert_fails_with "satellite + local IdP forces USE_USER_TOKEN=false" "forces USE_USER_TOKEN=false" validate_values satellite VALS

vals satellite edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	OPENAI_BASE_URL=https://central.example OPENAI_API_KEY=sk \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_OIDC_PROVIDER_URL=https://cerea.example/authelia \
	CHAT_OIDC_CLIENT_ID=cerea CHAT_OIDC_CLIENT_SECRET=ccs CHAT_REPO=/repo \
	PUBLIC_HOST=cerea.example PUBLIC_ORIGIN=https://cerea.example IDP_BUNDLED=authelia \
	USE_USER_TOKEN=false
assert_ok "satellite shared-key happy path" validate_values satellite VALS

IDP_BUNDLED=""
vals satellite edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	OPENAI_BASE_URL=https://central.example OPENAI_API_KEY=sk \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_OIDC_PROVIDER_URL=https://central.example \
	CHAT_OIDC_CLIENT_ID=cerea CHAT_OIDC_CLIENT_SECRET=ccs CHAT_REPO=/repo \
	PUBLIC_HOST=cerea.example PUBLIC_ORIGIN=https://cerea.example USE_USER_TOKEN=true
assert_fails_with "satellite central mode refuses a stored key" "sets no OPENAI_API_KEY" validate_values satellite VALS

vals satellite edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	OPENAI_BASE_URL=https://central.example \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_OIDC_PROVIDER_URL=https://central.example \
	CHAT_OIDC_CLIENT_ID=cerea CHAT_OIDC_CLIENT_SECRET=ccs CHAT_REPO=/repo \
	PUBLIC_HOST=cerea.example PUBLIC_ORIGIN=https://cerea.example USE_USER_TOKEN=true
assert_ok "satellite central happy path (no stored key, user token on)" validate_values satellite VALS

vals generic edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	OPENAI_BASE_URL=https://api.example.com/v1 OPENAI_API_KEY=sk \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_OIDC_PROVIDER_URL=https://idp.example \
	CHAT_OIDC_CLIENT_ID=cerea CHAT_OIDC_CLIENT_SECRET=ccs CHAT_REPO=/repo \
	PUBLIC_HOST=cerea.example PUBLIC_ORIGIN=https://cerea.example USE_USER_TOKEN=true
assert_fails_with "generic refuses user-token mode (credential leak to the third party)" "generic forces USE_USER_TOKEN=false" validate_values generic VALS

vals generic edge \
	POSTGRES_PASSWORD=pg GATEWAY_SECRET_KEY=gsk GATEWAY_SESSION_SECRET=gss \
	OPENAI_BASE_URL=https://api.example.com/v1 OPENAI_API_KEY=sk \
	CHAT_PG_URL=postgresql://chat:x@postgres:5432/chat CHAT_IDP_CLIENT_SECRET=cis \
	CHAT_SECRET_KEY=csk CHAT_OIDC_PROVIDER_URL=https://idp.example \
	CHAT_OIDC_CLIENT_ID=cerea CHAT_OIDC_CLIENT_SECRET=ccs CHAT_REPO=/repo \
	PUBLIC_HOST=cerea.example PUBLIC_ORIGIN=https://cerea.example USE_USER_TOKEN=false
assert_ok "generic happy path (shared key, user token off)" validate_values generic VALS

# ---- prompt defaults
default_https_port "10.0.0.7"
assert_eq "a bare IP defaults the proxy port to 8443" "8443" "$HTTPS_PORT_DEFAULT"
default_https_port "cerea.example"
assert_eq "a name defaults the proxy port to 443" "443" "$HTTPS_PORT_DEFAULT"

default_public_origin "" "cerea.example" "8443"
assert_eq "origin default carries a non-443 port" "https://cerea.example:8443" "$ORIGIN_DEFAULT"
default_public_origin "" "cerea.example" "443"
assert_eq "443 origin omits the port" "https://cerea.example" "$ORIGIN_DEFAULT"
default_public_origin "https://preset.example" "cerea.example" "8443"
assert_eq "a parsed origin wins over any computed default" "https://preset.example" "$ORIGIN_DEFAULT"

# ---- resume inference: standalone (usage is an exact 'true' match)
reset_parsed
PARSED[CHAT_CODE_TOOL_ENABLED]=true
PARSED[CHAT_USAGE_ENABLED]=true
PARSED[CHAT_MEMORY_ENABLED]=false
infer_standalone_toggles
assert_eq "standalone: redaction fixed off" "off" "$REDACTION_STATE"
assert_eq "standalone: fetch defaults direct" "direct" "$ST_FETCH"
assert_eq "standalone: metering fixed off" "0" "$ST_METERING"
assert_eq "standalone: code tool on" "1" "$ST_CODETOOL"
assert_eq "standalone: usage shown only on exact true" "1" "$ST_USAGE"
assert_eq "standalone: knowledge defaults on when absent" "1" "$ST_KNOWLEDGE"
assert_eq "standalone: memory off on exact false" "0" "$ST_MEMORY"

reset_parsed
PARSED[FETCH_BACKEND]=playwright
PARSED[CHAT_USAGE_ENABLED]=false
infer_standalone_toggles
assert_eq "standalone: fetch_backend honoured" "playwright" "$ST_FETCH"
assert_eq "standalone: usage 'false' hides the tab (exact match)" "0" "$ST_USAGE"

reset_parsed
PARSED[FETCH_BACKEND]=""
infer_standalone_toggles
assert_eq "standalone: empty FETCH_BACKEND falls back to direct" "direct" "$ST_FETCH"

# ---- resume inference: gateway profiles (usage is any-non-empty; metering defaults on)
reset_parsed
PARSED[GATEWAY_REDACTION__ENGINE]=http
PARSED[SPACY_MODELS]=en_core_web_lg
PARSED[FETCH_BACKEND]=playwright
PARSED[CHAT_USAGE_ENABLED]=false
infer_gateway_toggles
assert_eq "gateway: engine http + a spacy model = NER" "ner" "$REDACTION_STATE"
assert_eq "gateway: fetch_backend honoured" "playwright" "$ST_FETCH"
assert_eq "gateway: accounting absent means metering on (not-equal-false default)" "1" "$ST_METERING"
assert_eq "gateway: usage 'false' counts as shown (the known asymmetry)" "1" "$ST_USAGE"

reset_parsed
PARSED[GATEWAY_REDACTION__ENGINE]=http
infer_gateway_toggles
assert_eq "gateway: engine http + no spacy model = pattern" "pattern" "$REDACTION_STATE"

reset_parsed
PARSED[GATEWAY_REDACTION__ENGINE]=http
PARSED[SPACY_MODELS]="   "
infer_gateway_toggles
assert_eq "gateway: whitespace-only SPACY_MODELS trims to pattern" "pattern" "$REDACTION_STATE"

reset_parsed
infer_gateway_toggles
assert_eq "gateway: no engine at all = off" "off" "$REDACTION_STATE"
assert_eq "gateway: fetch absent = direct" "direct" "$ST_FETCH"
assert_eq "gateway: metering absent = on" "1" "$ST_METERING"
assert_eq "gateway: usage absent = hidden" "0" "$ST_USAGE"
assert_eq "gateway: knowledge absent = on" "1" "$ST_KNOWLEDGE"
assert_eq "gateway: memory absent = on" "1" "$ST_MEMORY"

reset_parsed
PARSED[GATEWAY_REDACTION__ENGINE]=noop
PARSED[GATEWAY_ACCOUNTING__ENABLED]=false
PARSED[CHAT_KNOWLEDGE_ENABLED]=false
infer_gateway_toggles
assert_eq "gateway: engine noop = off" "off" "$REDACTION_STATE"
assert_eq "gateway: accounting false = metering off" "0" "$ST_METERING"
assert_eq "gateway: knowledge false = off" "0" "$ST_KNOWLEDGE"

# ---- resume inference: enterprise sign-in shape
reset_parsed
PARSED[GATEWAY_OIDC__ENABLED]=true
PARSED[IDP_BUNDLED]=authelia
infer_auth_mode
assert_eq "external OIDC + authelia bundle = bundled-authelia" "bundled-authelia" "$AUTH_MODE"

reset_parsed
PARSED[GATEWAY_OIDC__ENABLED]=true
PARSED[IDP_BUNDLED]=keycloak
infer_auth_mode
assert_eq "external OIDC + keycloak bundle = bundled-keycloak" "bundled-keycloak" "$AUTH_MODE"

reset_parsed
PARSED[GATEWAY_OIDC__ENABLED]=true
infer_auth_mode
assert_eq "external OIDC, no bundle = external" "external" "$AUTH_MODE"

reset_parsed
PARSED[GATEWAY_OIDC__ENABLED]=false
PARSED[GATEWAY_IDP__ENABLED]=true
infer_auth_mode
assert_eq "house IdP on, external off = house" "house" "$AUTH_MODE"

reset_parsed
infer_auth_mode
assert_eq "neither door = custom" "custom" "$AUTH_MODE"

# ---- the component vocabulary (what --components and the metadata block speak)
declare -A CMAP=()
components_parse "redaction=ner,fetch=playwright,metering=on,usage=shown,code-tool=on,knowledge=on,memory=on" CMAP
assert_eq "components_parse: full spec round-trips into the map" \
	"ner playwright on shown on on on" \
	"${CMAP[redaction]} ${CMAP[fetch]} ${CMAP[metering]} ${CMAP[usage]} ${CMAP[code-tool]} ${CMAP[knowledge]} ${CMAP[memory]}"
components_parse "metering=off" CMAP
assert_eq "components_parse: partial spec carries only its keys" "1" "${#CMAP[@]}"
assert_fails_with "components_parse rejects an unknown key" "outside the vocabulary" components_parse "sideways=on" CMAP
assert_fails_with "components_parse rejects a bad value" "outside the vocabulary" components_parse "redaction=offish" CMAP
assert_fails_with "components_parse rejects a bare key" "not key=value" components_parse "redaction" CMAP
assert_fails_with "components_parse rejects a duplicate key" "twice" components_parse "fetch=direct,fetch=playwright" CMAP
assert_fails_with "components_parse rejects the empty spec" "empty" components_parse "" CMAP

# ---- components_to_shape over profile defaults, and the round trip
REDACTION_STATE="off"
ST_REDACTION="off" ST_FETCH="direct" ST_METERING=0 ST_CODETOOL=1 ST_USAGE=0 ST_KNOWLEDGE=1 ST_MEMORY=1 ST_CODEPANEL=0
components_to_shape "redaction=pattern,fetch=playwright,usage=shown"
assert_eq "components_to_shape: redaction applied" "pattern" "$ST_REDACTION"
assert_eq "components_to_shape: fetch applied" "playwright" "$ST_FETCH"
assert_eq "components_to_shape: usage applied" "1" "$ST_USAGE"
assert_eq "components_to_shape: untouched keys keep their values" "0 1 1 1" "$ST_METERING $ST_CODETOOL $ST_KNOWLEDGE $ST_MEMORY"
components_to_shape "code-panel=on"
assert_eq "components_to_shape: code-panel applied" "1" "$ST_CODEPANEL"
shape_to_components
assert_eq "shape_to_components serialises the whole shape" \
	"redaction=pattern,fetch=playwright,metering=off,usage=shown,code-tool=on,knowledge=on,memory=on,code-panel=on" \
	"$COMPONENTS_SPEC"
components_to_shape "$COMPONENTS_SPEC"
assert_eq "spec -> shape -> spec is a fixpoint" "pattern playwright 0 1 1 1 1 1" \
	"$ST_REDACTION $ST_FETCH $ST_METERING $ST_USAGE $ST_CODETOOL $ST_KNOWLEDGE $ST_MEMORY $ST_CODEPANEL"

# ---- components_differ (exit 0 = the shapes disagree)
assert_fails "identical specs (any order) do not differ" \
	components_differ "redaction=off,fetch=direct" "fetch=direct,redaction=off"
assert_fails "a partial spec agrees with the full one on shared keys" \
	components_differ "metering=on" "metering=on,fetch=direct"
assert_ok "a disagreeing key differs" components_differ "metering=on" "metering=off"
assert_fails "a key only one spec carries is not a contradiction" components_differ "metering=on" "fetch=direct"

# ---- the metadata word mappers
PROFILE=team
IDP_BUNDLED=""
assert_eq "team house -> INSTALLER_IDP house" "house" "$(installer_idp_word)"
assert_eq "team house -> INSTALLER_AUTH_MODE house" "house" "$(installer_auth_mode_word)"
IDP_BUNDLED=authelia
assert_eq "team authelia -> INSTALLER_IDP authelia" "authelia" "$(installer_idp_word)"
assert_eq "team authelia -> INSTALLER_AUTH_MODE bundled-authelia" "bundled-authelia" "$(installer_auth_mode_word)"
IDP_BUNDLED=""
PROFILE=enterprise
AUTH_MODE=bundled-keycloak
assert_eq "enterprise bundled-keycloak -> INSTALLER_IDP keycloak" "keycloak" "$(installer_idp_word)"
assert_eq "enterprise keeps AUTH_MODE verbatim" "bundled-keycloak" "$(installer_auth_mode_word)"
AUTH_MODE=custom
assert_eq "enterprise custom -> INSTALLER_IDP custom" "custom" "$(installer_idp_word)"
PROFILE=satellite
AUTH_MODE=""
assert_eq "satellite central -> INSTALLER_IDP central" "central" "$(installer_idp_word)"
assert_eq "satellite central -> INSTALLER_AUTH_MODE central" "central" "$(installer_auth_mode_word)"
PROFILE=generic
assert_eq "generic -> external" "external" "$(installer_idp_word)"
PROFILE=homelab
assert_eq "homelab -> house" "house" "$(installer_idp_word)"

# ---- apply_metadata_shape: the block restored verbatim
unset INSTALLER_META
declare -gA INSTALLER_META=()
unset ST_REDACTION ST_FETCH ST_METERING ST_CODETOOL ST_USAGE ST_KNOWLEDGE ST_MEMORY
INSTALLER_META[INSTALLER_VERSION]="1"
INSTALLER_META[INSTALLER_PROFILE]="team"
INSTALLER_META[INSTALLER_EXPOSURE]="edge"
INSTALLER_META[INSTALLER_IDP]="authelia"
INSTALLER_META[INSTALLER_AUTH_MODE]="bundled-authelia"
INSTALLER_META[INSTALLER_COMPONENTS]="redaction=off,fetch=direct,metering=on,usage=hidden,code-tool=on,knowledge=on,memory=on"
REDACTION_STATE="pattern"
ST_REDACTION="pattern" ST_FETCH="direct" ST_METERING=0 ST_USAGE=1 ST_CODETOOL=1 ST_KNOWLEDGE=1 ST_MEMORY=1
AUTH_MODE=""
apply_metadata_shape
assert_eq "metadata: redaction restored verbatim" "off" "$REDACTION_STATE"
assert_eq "metadata: usage restored verbatim (no -n heuristic)" "0" "$ST_USAGE"
assert_eq "metadata: metering restored verbatim" "1" "$ST_METERING"
assert_eq "metadata: AUTH_MODE restored verbatim" "bundled-authelia" "$AUTH_MODE"

INSTALLER_META[INSTALLER_VERSION]="2"
assert_fails_with "metadata: a future shape version fails loudly" "shape version 2" apply_metadata_shape
INSTALLER_META[INSTALLER_VERSION]="1"
unset INSTALLER_META[INSTALLER_VERSION]
assert_fails_with "metadata: a missing version fails loudly" "no INSTALLER_VERSION" apply_metadata_shape
INSTALLER_META[INSTALLER_VERSION]="1"
unset ST_REDACTION ST_FETCH ST_METERING ST_CODETOOL ST_USAGE ST_KNOWLEDGE ST_MEMORY
INSTALLER_META[INSTALLER_COMPONENTS]="redaction=off"
assert_fails_with "metadata: an incomplete component list fails loudly" "missing the 'fetch' word" apply_metadata_shape
INSTALLER_META[INSTALLER_COMPONENTS]="redaction=off,fetch=direct,metering=on,usage=hidden,code-tool=on,knowledge=on,memory=on"
INSTALLER_META[INSTALLER_PROFILE]="bogus"
assert_fails_with "metadata: an unknown profile fails loudly" "INSTALLER_PROFILE='bogus'" apply_metadata_shape
INSTALLER_META[INSTALLER_PROFILE]="team"
INSTALLER_META[INSTALLER_EXPOSURE]="lan"
assert_fails_with "metadata: an unknown exposure fails loudly" "INSTALLER_EXPOSURE='lan'" apply_metadata_shape
INSTALLER_META[INSTALLER_EXPOSURE]="edge"
INSTALLER_META[INSTALLER_AUTH_MODE]="saml"
assert_fails_with "metadata: an unknown auth mode fails loudly" "INSTALLER_AUTH_MODE='saml'" apply_metadata_shape

summary "test-values.sh"
