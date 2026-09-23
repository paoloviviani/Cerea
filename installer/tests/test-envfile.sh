#!/usr/bin/env bash
# Tests for lib/envfile.sh: .env parsing (resume) and templating (build).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
. tests/lib.sh
. lib/term.sh
. lib/values.sh
. lib/envfile.sh

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/cerea-envfile-tests.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT

reset_values() {
	unset VALUES VALUES_ORDER
	declare -gA VALUES=()
	VALUES_ORDER=()
}

# ---- parse_env_file: the resume reader
cat >"$TMPD/resume.env" <<'EOF'
# a comment

PLAIN=1
QUOTED="hello world"
SINGLE='single value'
EMPTY=
   INDENTED=2
PEM=-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBH0wawIBAQ
-----END PRIVATE KEY-----
AFTER=3
EOF

parse_env_file "$TMPD/resume.env"
assert_eq "plain key parses" "1" "${PARSED[PLAIN]}"
assert_eq "double quotes stripped, the way compose would read it" "hello world" "${PARSED[QUOTED]}"
assert_eq "single quotes stripped" "single value" "${PARSED[SINGLE]}"
assert_eq "empty value stays empty but counts as set" "" "${PARSED[EMPTY]}"
assert_eq "indented key parses (leading whitespace trimmed)" "2" "${PARSED[INDENTED]}"
assert_eq "legacy inline PEM is assembled across its lines" \
	"-----BEGIN PRIVATE KEY-----"$'\n'"MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBH0wawIBAQ"$'\n'"-----END PRIVATE KEY-----" \
	"${PARSED[PEM]}"
assert_eq "parsing resumes after the PEM END marker" "3" "${PARSED[AFTER]}"
assert_eq "PARSED_ORDER is first-seen order" "PLAIN QUOTED SINGLE EMPTY INDENTED PEM AFTER" "${PARSED_ORDER[*]}"

# A continuation line attaches to the current key (that is how a stray
# legacy multi-line value survives), and a comment closes the span.
cat >"$TMPD/cont.env" <<'EOF'
X=1
stray continuation
# comment closes it
Y=2
EOF
parse_env_file "$TMPD/cont.env"
assert_eq "a continuation line attaches to the current key" \
	"1"$'\n'"stray continuation" "${PARSED[X]}"
assert_eq "a comment resets the continuation span" "2" "${PARSED[Y]}"

# ---- build_env_file: fragment as base, overrides in place, additions appended
cat >"$TMPD/fragment.env" <<'EOF'
# homelab fragment (fixture)

POSTGRES_PASSWORD=from-fragment
GATEWAY_PORT=8000
KEEP_ME=yes
2FAST=2
EOF

reset_values
set_value POSTGRES_PASSWORD generated
set_value GATEWAY_SESSION_SECRET gen-session
set_value NEW_KEY newval

build_env_file "$TMPD/fragment.env" >"$TMPD/built.env"

expected="$(cat <<'EOF'
# homelab fragment (fixture)

POSTGRES_PASSWORD=generated
GATEWAY_PORT=8000
KEEP_ME=yes
2FAST=2

# --- installer additions ------------------------------------------------------
# Values for toggles this fragment never had (a deviated component choice),
# or names the fragment predates: the IdP signing key travels as a file, and
# the standalone profiles carry parse-only gateway secrets (no gateway runs
# on these profiles, but the base compose file refuses to interpolate
# without them — even `docker compose logs` would fail against this .env).
GATEWAY_SESSION_SECRET=gen-session
NEW_KEY=newval
EOF
)"
assert_eq "built .env is fragment + in-place overrides + additions, byte for byte" \
	"$expected" "$(cat "$TMPD/built.env")"
assert_contains "a fragment key that is not a valid identifier is never overridden" "2FAST=2" "$(cat "$TMPD/built.env")"

# ---- round trip: what was built parses back with the same values
parse_env_file "$TMPD/built.env"
assert_eq "round trip: overridden value" "generated" "${PARSED[POSTGRES_PASSWORD]}"
assert_eq "round trip: untouched fragment value" "8000" "${PARSED[GATEWAY_PORT]}"
assert_eq "round trip: installer addition" "newval" "${PARSED[NEW_KEY]}"

# ---- the installer metadata block: written when the shape is in play,
# parsed back verbatim, never leaking into PARSED
reset_values
set_value SECRET s
PROFILE=team
EXPOSURE=edge
IDP_BUNDLED=""
AUTH_MODE="house"
REDACTION_STATE="pattern"
ST_REDACTION="pattern" ST_FETCH="direct" ST_METERING=1 ST_USAGE=1 ST_CODETOOL=1 ST_KNOWLEDGE=1 ST_MEMORY=1 ST_CODEPANEL=0
cat >"$TMPD/fragment2.env" <<'EOF'
KEEP=yes
EOF
build_env_file "$TMPD/fragment2.env" >"$TMPD/built2.env"
assert_contains "the block is delimited and machine-readable" "# >>> installer metadata >>>" "$(cat "$TMPD/built2.env")"
assert_contains "the block closes" "# <<< installer metadata <<<" "$(cat "$TMPD/built2.env")"
assert_contains "INSTALLER_VERSION written" "INSTALLER_VERSION=1" "$(cat "$TMPD/built2.env")"
assert_contains "INSTALLER_PROFILE written" "INSTALLER_PROFILE=team" "$(cat "$TMPD/built2.env")"
assert_contains "INSTALLER_EXPOSURE written" "INSTALLER_EXPOSURE=edge" "$(cat "$TMPD/built2.env")"
assert_contains "INSTALLER_IDP written" "INSTALLER_IDP=house" "$(cat "$TMPD/built2.env")"
assert_contains "INSTALLER_AUTH_MODE written" "INSTALLER_AUTH_MODE=house" "$(cat "$TMPD/built2.env")"
assert_contains "INSTALLER_COMPONENTS written" \
	"INSTALLER_COMPONENTS=redaction=pattern,fetch=direct,metering=on,usage=shown,code-tool=on,knowledge=on,memory=on,code-panel=off" \
	"$(cat "$TMPD/built2.env")"
parse_env_file "$TMPD/built2.env"
assert_eq "the block marks META_PRESENT" "1" "$META_PRESENT"
assert_eq "metadata parses verbatim" "team" "${INSTALLER_META[INSTALLER_PROFILE]}"
assert_eq "metadata components verbatim" \
	"redaction=pattern,fetch=direct,metering=on,usage=shown,code-tool=on,knowledge=on,memory=on,code-panel=off" \
	"${INSTALLER_META[INSTALLER_COMPONENTS]}"
assert_eq "INSTALLER_* never enter PARSED" "KEEP SECRET" "${PARSED_ORDER[*]}"
run_capture parse_env_file "$TMPD/built2.env"
assert_eq "re-parse stays clean" "0" "$RC"

# A block-less (legacy) file parses with META_PRESENT=0 — the infer
# fallback's territory.
parse_env_file "$TMPD/built.env"
assert_eq "a legacy .env carries no metadata" "0" "$META_PRESENT"

# A stray INSTALLER_ line OUTSIDE the block is bookkeeping too, never a
# deployment value.
cat >"$TMPD/stray.env" <<'EOF'
REAL=1
INSTALLER_PROFILE=satellite
EOF
parse_env_file "$TMPD/stray.env"
assert_eq "a stray INSTALLER_ key outside the block is skipped" "REAL" "${PARSED_ORDER[*]}"
assert_eq "a stray key does not mark the block present" "0" "$META_PRESENT"

# A corrupted block fails loudly instead of half-reading.
cat >"$TMPD/corrupt.env" <<'EOF'
# >>> installer metadata >>>
INSTALLER_VERSION=1
not a variable line
# <<< installer metadata <<<
EOF
assert_fails_with "a non KEY=VALUE line inside the block fails loudly" "unexpected line inside" parse_env_file "$TMPD/corrupt.env"
cat >"$TMPD/closeonly.env" <<'EOF'
X=1
# <<< installer metadata <<<
EOF
assert_fails_with "a closing marker without its opener fails loudly" "without its opening marker" parse_env_file "$TMPD/closeonly.env"

# ---- reset_parsed_state clears both maps (a fresh run must not inherit a
# peeked .env's values as prompt defaults)
reset_parsed_state
assert_eq "reset clears PARSED_ORDER" "" "${PARSED_ORDER[*]}"
assert_eq "reset clears META_PRESENT" "0" "$META_PRESENT"

summary "test-envfile.sh"
