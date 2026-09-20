#!/usr/bin/env bash
# Tests for lib/compose-flags.sh: compose argument assembly — the --build
# materialisation (including the empty-array expansion under
# `set -euo pipefail`), the env scrub list, overlay file lists, the phase-1
# set and the exec -T rewrite.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
. tests/lib.sh
. lib/term.sh
. lib/values.sh
. lib/envfile.sh
. lib/compose-flags.sh

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/cerea-flags-tests.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT

reset_values() {
	unset VALUES VALUES_ORDER
	declare -gA VALUES=()
	VALUES_ORDER=()
}

# ---- the exact call-site shape: every `up -d "${BUILD_FLAG[@]}"` in
# install.sh expands against BUILD_FLAG, empty or not, under the installer's
# `set -euo pipefail`. An empty array was "unbound" before bash 4.4; these
# pin the behaviour the seven call sites rely on.
out="$(bash -c 'set -euo pipefail; BUILD_FLAG=(); printf "[%s]" "${BUILD_FLAG[@]}"')"
assert_eq 'empty quoted "${BUILD_FLAG[@]}" expands to nothing under set -euo pipefail' "[]" "$out"
out="$(bash -c 'set -euo pipefail; BUILD_FLAG=(); printf "[%s]" ${BUILD_FLAG[@]}')"
assert_eq 'empty unquoted ${BUILD_FLAG[@]} expands to nothing under set -euo pipefail' "[]" "$out"
out="$(bash -c 'set -euo pipefail; BUILD_FLAG=(--build); printf "[%s]" "${BUILD_FLAG[@]}"')"
assert_eq '--build expands to exactly one word' "[--build]" "$out"

# ---- set_build_flag
set_build_flag 0
assert_eq "set_build_flag 0 leaves BUILD_FLAG empty (a re-run reuses what is built)" "0" "${#BUILD_FLAG[@]}"
set_build_flag 1
assert_eq "set_build_flag 1 materialises --build" "--build" "${BUILD_FLAG[*]}"

# ---- build_scrub: every key in the file and in the value map is scrubbed;
# GATEWAY_PORT (compose reads it even when the fragment never names it) and
# docker close the list.
cat >"$TMPD/scrub.env" <<'EOF'
FILE_A=1
FILE_B=2
EOF
reset_values
set_value MAP_C 3
build_scrub "$TMPD/scrub.env"
assert_eq "scrub list: env, file keys, map keys, GATEWAY_PORT, docker" \
	"env -u FILE_A -u FILE_B -u MAP_C -u GATEWAY_PORT docker" "${SCRUB[*]}"

# ---- scrub_keep: drop exactly the -u <key> pair for the parse check
SCRUB=(env -u A -u CHAT_REPO -u B docker)
scrub_keep CHAT_REPO
assert_eq "scrub_keep drops only the kept key's pair (docker drops too; main re-adds it)" \
	"env -u A -u B" "${SCRUB_KEEP[*]}"
SCRUB=(env -u A -u B docker)
scrub_keep CHAT_REPO
assert_eq "scrub_keep with nothing to drop" "env -u A -u B" "${SCRUB_KEEP[*]}"

# ---- standalone_overlay_flags
standalone_overlay_flags edge
assert_eq "standalone edge set: base + chat + edge" \
	"-f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.chat.yml -f deploy/compose/docker-compose.edge.yml" \
	"${OVERLAY_FLAGS[*]}"
standalone_overlay_flags proxy authelia
assert_eq "standalone proxy + Authelia bundle" \
	"-f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.chat.yml -f deploy/compose/docker-compose.proxy.yml -f deploy/compose/docker-compose.idp-authelia.yml" \
	"${OVERLAY_FLAGS[*]}"
assert_fails_with "standalone flags refuse a bogus exposure" "sideways" standalone_overlay_flags sideways
assert_fails_with "standalone profiles ship only the Authelia bundle" \
	"only the Authelia bundle" standalone_overlay_flags edge keycloak

# ---- idp_overlay_file / append_idp_overlay
reset_values
run_capture idp_overlay_file
assert_eq "no bundled IdP -> no overlay file" "" "$OUT"
set_value IDP_BUNDLED authelia
assert_eq "authelia overlay file" "deploy/compose/docker-compose.idp-authelia.yml" "$(idp_overlay_file)"
set_value IDP_BUNDLED keycloak
assert_eq "keycloak overlay file" "deploy/compose/docker-compose.idp-keycloak.yml" "$(idp_overlay_file)"
OVERLAY_FLAGS=(-f base.yml)
append_idp_overlay
assert_eq "append_idp_overlay adds the bundled file" \
	"-f base.yml -f deploy/compose/docker-compose.idp-keycloak.yml" "${OVERLAY_FLAGS[*]}"
reset_values
OVERLAY_FLAGS=(-f base.yml)
append_idp_overlay
assert_eq "append_idp_overlay adds nothing without a bundle" "-f base.yml" "${OVERLAY_FLAGS[*]}"

# ---- phase_one_flags: base + (exposure + IdP when bundled) + (redaction when engine on)
reset_values
EXPOSURE=edge
REDACTION_STATE=off
phase_one_flags
assert_eq "plain phase-1 set is base only" "-f deploy/compose/docker-compose.yml" "${BASE_FLAGS[*]}"

set_value IDP_BUNDLED authelia
REDACTION_STATE=ner
phase_one_flags
assert_eq "bundled phase-1 set: base + exposure + IdP + redaction" \
	"-f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.edge.yml -f deploy/compose/docker-compose.idp-authelia.yml -f deploy/compose/docker-compose.redaction.yml" \
	"${BASE_FLAGS[*]}"

set_value IDP_BUNDLED keycloak
REDACTION_STATE=off
EXPOSURE=proxy
phase_one_flags
assert_eq "keycloak phase-1 set without redaction" \
	"-f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.proxy.yml -f deploy/compose/docker-compose.idp-keycloak.yml" \
	"${BASE_FLAGS[*]}"

# ---- compose_exec_t: the first bare exec gains -T, once
compose_exec_t up -d
assert_eq "no exec: args pass through untouched" "up -d" "${COMPOSE_ARGS[*]}"
compose_exec_t exec gateway gateway passwd admin@local
assert_eq "first bare exec gains -T (a piped run has no terminal to allocate)" \
	"exec -T gateway gateway passwd admin@local" "${COMPOSE_ARGS[*]}"
compose_exec_t exec a exec b
assert_eq "only the first exec is rewritten" "exec -T a exec b" "${COMPOSE_ARGS[*]}"

# ---- derive_compose_profiles: the shape -> profile-set mapping (the wiring
# P1 flagged: a fresh install that activates nothing composes without the
# chat/IdP services)
derive_case() { # derive_case <profile> <idp|-> -> COMPOSE_PROFILES_VALUE
	reset_values
	PROFILE="$1"
	if [ "$2" != "-" ]; then set_value IDP_BUNDLED "$2"; fi
	derive_compose_profiles
}
derive_case team authelia
assert_eq "team + bundled Authelia -> chat,authelia" "chat,authelia" "$COMPOSE_PROFILES_VALUE"
derive_case team -
assert_eq "team house -> chat alone" "chat" "$COMPOSE_PROFILES_VALUE"
derive_case enterprise keycloak
assert_eq "enterprise + bundled Keycloak -> chat,keycloak" "chat,keycloak" "$COMPOSE_PROFILES_VALUE"
derive_case homelab -
assert_eq "homelab -> chat" "chat" "$COMPOSE_PROFILES_VALUE"
derive_case satellite authelia
assert_eq "satellite + local Authelia -> chat,authelia" "chat,authelia" "$COMPOSE_PROFILES_VALUE"
derive_case satellite -
assert_eq "satellite central -> chat" "chat" "$COMPOSE_PROFILES_VALUE"
derive_case generic -
assert_eq "generic -> chat" "chat" "$COMPOSE_PROFILES_VALUE"
derive_case - -
assert_eq "no profile (gateway-only shape) -> empty, the line is omitted" "" "$COMPOSE_PROFILES_VALUE"

# ---- compose_wrapper_text: the recorded command line and the five
# subcommand mappings; no --no-deps anywhere (the dependency removal made it
# unnecessary, and its absence is part of the new-world contract)
OVERLAY_FLAGS=(-f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.chat.yml -f deploy/compose/docker-compose.edge.yml)
UP_SERVICES=()
compose_wrapper_text deploy/.env "" "${OVERLAY_FLAGS[@]}" >"$TMPD/wrapper.sh"
assert_contains "wrapper starts with a bash shebang" "#!/usr/bin/env bash" "$(cat "$TMPD/wrapper.sh")"
assert_contains "wrapper records the env-file" "docker compose --env-file deploy/.env" "$(cat "$TMPD/wrapper.sh")"
assert_contains "wrapper records the overlay list verbatim" "-f deploy/compose/docker-compose.chat.yml" "$(cat "$TMPD/wrapper.sh")"
assert_contains "wrapper up maps to up -d" 'up)    shift; exec "${COMPOSE[@]}" up -d "$@" ;;' "$(cat "$TMPD/wrapper.sh")"
assert_contains "wrapper down maps to down" 'down)  shift; exec "${COMPOSE[@]}" down "$@" ;;' "$(cat "$TMPD/wrapper.sh")"
assert_contains "wrapper logs maps to logs -f" 'logs)  shift; exec "${COMPOSE[@]}" logs -f "$@" ;;' "$(cat "$TMPD/wrapper.sh")"
assert_contains "wrapper ps maps to ps" 'ps)    shift; exec "${COMPOSE[@]}" ps "$@" ;;' "$(cat "$TMPD/wrapper.sh")"
assert_contains "wrapper build maps to up -d --build" 'build) shift; exec "${COMPOSE[@]}" up -d --build "$@" ;;' "$(cat "$TMPD/wrapper.sh")"
assert_not_contains "wrapper never emits --no-deps" "--no-deps" "$(cat "$TMPD/wrapper.sh")"
# The header COMMENT mentions --profile in prose; the absence check anchors
# to the tab-indented generated flag lines.
assert_not_contains "wrapper with an empty embed emits no --profile flags" \
	"$(printf '\t--profile')" "$(cat "$TMPD/wrapper.sh")"

UP_SERVICES=(chat proxy authelia)
compose_wrapper_text deploy/.env "chat,authelia" "${OVERLAY_FLAGS[@]}" >"$TMPD/wrapper2.sh"
assert_contains "the wrapper's up names the standalone set" 'up -d chat proxy authelia "$@"' "$(cat "$TMPD/wrapper2.sh")"
assert_contains "the wrapper's build names the standalone set too" 'up -d --build chat proxy authelia "$@"' "$(cat "$TMPD/wrapper2.sh")"
assert_contains "the legacy-file wrapper embeds the chat profile" "--profile chat" "$(cat "$TMPD/wrapper2.sh")"
assert_contains "the legacy-file wrapper embeds the IdP profile" "--profile authelia" "$(cat "$TMPD/wrapper2.sh")"
UP_SERVICES=()

# ---- write_compose_wrapper: generated text, executable bit, byte-identical
# to the printed form
write_compose_wrapper "$TMPD/compose.sh" deploy/.env "chat" "${OVERLAY_FLAGS[@]}"
[ -x "$TMPD/compose.sh" ] && pass "the written wrapper carries the executable bit" ||
	flunk "the written wrapper is not executable"
assert_eq "the written wrapper is byte-identical to the generated text" \
	"$(compose_wrapper_text deploy/.env "chat" "${OVERLAY_FLAGS[@]}")" "$(cat "$TMPD/compose.sh")"
bash -n "$TMPD/compose.sh" && pass "the generated wrapper parses as bash" ||
	flunk "the generated wrapper is not valid bash"

summary "test-compose-flags.sh"
