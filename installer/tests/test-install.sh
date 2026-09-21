#!/usr/bin/env bash
# Integration tests: installer/install.sh end to end under --dry-run,
# against a fake Pystino checkout built under the test temp dir (valid
# minimal compose files + a stub overlays.sh + minimal fragments). The
# operator's real checkout and its live deploy/.env are never touched.
#
# Covers what the lib tests cannot see: the missing-decision failure
# listing, the metadata block landing in the written .env, the flag-vs-
# metadata contradiction failures, the legacy (block-less) resume through
# the infer fallback, and flag/interactive compose-line equivalence.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
. tests/lib.sh

# The other test files cd into installer/ and source libs relatively; the
# install.sh under test lives one level up.
CEREA_UNDER_TEST="$(cd "$PWD/.." && pwd)"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/cerea-install-tests.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT

# ---- the fake Pystino checkout
FAKE="$TMPD/pystino"
mkdir -p "$FAKE/deploy/compose" "$FAKE/deploy/profiles"

# Minimal but valid: docker compose config --quiet must accept the sets the
# fresh-run parse check builds (docker is present on this host). The chat and
# bundled-IdP overlays carry the profile tags Pystino's real files carry
# (`profiles: [chat]` / `profiles: [authelia]`), under the service names the
# profile-activation check asserts on — that check proves COMPOSE_PROFILES
# took, which only means something when the tagged services exist.
minimal_compose='services:
  fixture:
    image: busybox:latest
'
for f in docker-compose.yml docker-compose.edge.yml \
	docker-compose.proxy.yml docker-compose.redaction.yml \
	docker-compose.playwright.yml; do
	printf '%s' "$minimal_compose" >"$FAKE/deploy/compose/$f"
done
cat >"$FAKE/deploy/compose/docker-compose.chat.yml" <<'EOF'
services:
  chat:
    image: busybox:latest
    profiles: [chat]
  chat-mongo:
    image: busybox:latest
    profiles: [chat]
EOF
cat >"$FAKE/deploy/compose/docker-compose.idp-authelia.yml" <<'EOF'
services:
  authelia:
    image: busybox:latest
    profiles: [authelia]
  ca-bundle:
    image: busybox:latest
    profiles: [authelia]
EOF
cat >"$FAKE/deploy/compose/docker-compose.idp-keycloak.yml" <<'EOF'
services:
  keycloak:
    image: busybox:latest
    profiles: [keycloak]
  ca-bundle:
    image: busybox:latest
    profiles: [keycloak]
EOF

cat >"$FAKE/deploy/profiles/overlays.sh" <<'EOF'
# fixture stub: the same selection shape as the real overlays.sh, without
# the real file inventory
custom_overlays() {
	exposure=${1:?} redaction=${2:?} fetch=${3:?}
	set -- -f deploy/compose/docker-compose.yml
	case $redaction in pattern | ner) set -- "$@" -f deploy/compose/docker-compose.redaction.yml ;; esac
	set -- "$@" -f deploy/compose/docker-compose.chat.yml
	if [ "$fetch" = "playwright" ]; then
		: "${CHAT_REPO:?playwright fetch needs CHAT_REPO set}"
		set -- "$@" -f "$CHAT_REPO/deploy/compose/docker-compose.playwright.yml"
	fi
	case $exposure in edge | proxy) set -- "$@" -f "deploy/compose/docker-compose.${exposure}.yml" ;; esac
	echo "$*"
}
profile_overlays() {
	case $1 in
		homelab) custom_overlays "$2" off direct ;;
		team) custom_overlays "$2" pattern direct ;;
		enterprise) custom_overlays "$2" ner playwright ;;
		*) echo "profile_overlays: unknown profile '$1'" >&2; return 1 ;;
	esac
}
EOF

for p in homelab team enterprise satellite generic; do
	printf '# %s fragment (fixture)\nGATEWAY_PORT=8000\n' "$p" >"$FAKE/deploy/profiles/$p.env"
done

# The bundled-IdP file generator: a dry run still renders the throwaway IdP
# files, so the fake checkout carries stubs.
mkdir -p "$FAKE/deploy/idp"
cat >"$FAKE/deploy/idp/generate-authelia-config.sh" <<'EOF'
#!/usr/bin/env bash
echo fixture >"${IDP_OUT_DIR:?}/authelia-stub"
EOF
printf '{}\n' >"$FAKE/deploy/idp/keycloak-realm.json.template"
printf '# fixture caddy snippet\n' >"$FAKE/deploy/idp/10-idp-keycloak.caddy.template"

run_install() { # run_install <args...> -> OUT, RC (install.sh --dry-run unless told otherwise)
	run_capture env -u IDP_ADMIN_PASSWORD -u IDP_FIRST_PASSWORD TMPDIR="$TMPD" \
		bash "$CEREA_UNDER_TEST/installer/install.sh" "$@"
}

# A team-house legacy .env (what a pre-metadata installer wrote): every
# required house-shape key present, inline signing key, CHAT_USAGE_ENABLED
# set to false — the exact value that made the old usage heuristic lie.
legacy_team_env() {
	cat >"$FAKE/deploy/.env" <<'EOF'
# legacy fixture (no installer metadata block)
POSTGRES_PASSWORD=pgpass
GATEWAY_SECRET_KEY=gsk
GATEWAY_SESSION_SECRET=gss
GATEWAY_REDACTION__ENGINE=http
REDACTION_PLACEHOLDER_KEY=rpkey
REDACTION_LANGUAGE=en
SPACY_MODELS=
REDACTION_NLP_ENGINE=disabled
GATEWAY_ACCOUNTING__ENABLED=true
GATEWAY_QUOTA__ENABLED=true
GATEWAY_OIDC__ENABLED=false
GATEWAY_IDP__ENABLED=true
GATEWAY_IDP__ISSUER=https://legacy.example
GATEWAY_IDP__INTERNAL_TOKEN=intok
GATEWAY_IDP__SIGNING_KEY=legacy-inline-key
GATEWAY_IDP__CLIENTS=[]
GATEWAY_LOCAL_AUTH__ENABLED=true
GATEWAY_ENVIRONMENT=production
GATEWAY_PORT=8000
CHAT_REPO=/home/ubuntu/workspace/Cerea
CHAT_PG_URL=postgresql://chat:pg@postgres:5432/chat
CHAT_IDP_CLIENT_SECRET=cis
CHAT_SECRET_KEY=csk
CHAT_CODE_TOOL_ENABLED=true
CHAT_USAGE_ENABLED=false
CHAT_KNOWLEDGE_ENABLED=true
CHAT_MEMORY_ENABLED=true
FETCH_BACKEND=direct
PUBLIC_HOST=legacy.example
HTTPS_PORT=8443
TLS_DIRECTIVE="tls internal"
PUBLIC_ORIGIN=https://legacy.example:8443
CHAT_PG_PASSWORD=pg
EOF
}

# The same file carrying an installer metadata block that claims satellite:
# the contradiction fixtures.
satellite_block() {
	cat >>"$FAKE/deploy/.env" <<'EOF'

# >>> installer metadata >>>
# Written by installer/install.sh at install time and read verbatim by
# --phase2 (and by flagged fresh runs, for contradiction checks). The
# vocabulary is versioned: INSTALLER_VERSION bumps when the shape
# semantics change. Edit only together with the values it describes.
INSTALLER_VERSION=1
INSTALLER_PROFILE=satellite
INSTALLER_EXPOSURE=edge
INSTALLER_IDP=central
INSTALLER_AUTH_MODE=central
INSTALLER_COMPONENTS=redaction=off,fetch=direct,metering=off,usage=shown,code-tool=on,knowledge=on,memory=on,code-panel=off
# <<< installer metadata <<<
EOF
}

# A complete satellite-central .env, metadata block included: the standalone
# verbatim restore (the shape the old heuristics mis-inferred live).
satellite_env() {
	cat >"$FAKE/deploy/.env" <<'EOF'
POSTGRES_USER=chat
POSTGRES_PASSWORD=pgpass
POSTGRES_DB=chat
GATEWAY_SECRET_KEY=gsk
GATEWAY_SESSION_SECRET=gss
OPENAI_BASE_URL=https://central.example/v1
CHAT_PG_URL=postgresql://chat:pg@postgres:5432/chat
CHAT_IDP_CLIENT_SECRET=cis
CHAT_SECRET_KEY=csk
CHAT_OIDC_PROVIDER_URL=https://central.example
CHAT_OIDC_CLIENT_ID=cerea
CHAT_OIDC_CLIENT_SECRET=ccs
CHAT_OIDC_SCOPES=openid profile email
CHAT_CODE_TOOL_ENABLED=true
CHAT_USAGE_ENABLED=true
CHAT_KNOWLEDGE_ENABLED=true
CHAT_MEMORY_ENABLED=true
FETCH_BACKEND=direct
PUBLIC_HOST=legacy.example
HTTPS_PORT=8443
TLS_DIRECTIVE="tls internal"
PUBLIC_ORIGIN=https://legacy.example:8443
CHAT_REPO=/home/ubuntu/workspace/Cerea
GATEWAY_PORT=8000

# >>> installer metadata >>>
INSTALLER_VERSION=1
INSTALLER_PROFILE=satellite
INSTALLER_EXPOSURE=edge
INSTALLER_IDP=central
INSTALLER_AUTH_MODE=central
INSTALLER_COMPONENTS=redaction=off,fetch=direct,metering=off,usage=shown,code-tool=on,knowledge=on,memory=on,code-panel=off
# <<< installer metadata <<<
EOF
}

# ---- 1: a fresh run with every decision on flags — no stdin at all
rm -f "$FAKE/deploy/.env"
run_install --dry-run --pystino "$FAKE" --profile team --exposure edge \
	--idp house --set PUBLIC_HOST=cerea.test
assert_eq "all-flags fresh run succeeds" "0" "$RC"
assert_contains "the fresh run prints its compose line" "[dry-run] (cd $FAKE && docker compose --env-file" "$OUT"
assert_contains "the parse check accepted the generated .env" \
	"docker compose config --quiet accepted the generated .env" "$OUT"
env_path="$(printf '%s\n' "$OUT" | sed -n 's/^The .env that would have been written: \(.*\) (mode 600)$/\1/p')"
[ -n "$env_path" ] || flunk "the dry run did not name its .env"
assert_contains "the written .env carries the metadata block" "# >>> installer metadata >>>" "$(cat "$env_path")"
for kv in "INSTALLER_VERSION=1" "INSTALLER_PROFILE=team" "INSTALLER_EXPOSURE=edge" \
	"INSTALLER_IDP=house" "INSTALLER_AUTH_MODE=house" \
	"INSTALLER_COMPONENTS=redaction=pattern,fetch=direct,metering=on,usage=shown,code-tool=on,knowledge=on,memory=on,code-panel=off"; do
	assert_contains "the block records $kv" "$kv" "$(cat "$env_path")"
done
assert_contains "the block closes" "# <<< installer metadata <<<" "$(cat "$env_path")"
assert_contains "the flagged PUBLIC_HOST landed in the .env" "PUBLIC_HOST=cerea.test" "$(cat "$env_path")"

# ---- 1b: the same shape through the interactive flow produces the same
# compose lines (mod the temp .env path) — the flags are an alternative
# front end, not a different installer.
legacy_team_env
interactive_out="$(
	# order: chat checkout (default), profile 2=team, toggles 9=done,
	# exposure 1=edge, team sign-in 1=house, PUBLIC_HOST, edge port,
	# PUBLIC_ORIGIN (default)
	printf '\n2\n9\n1\n1\ncerea.test\n8443\n\n' |
		env TMPDIR="$TMPD" bash "$CEREA_UNDER_TEST/installer/install.sh" \
			--dry-run --pystino "$FAKE" 2>&1
)"
interactive_rc=$?
# The legacy .env exists; the interactive fresh run peeks at it only when a
# shape flag is present — none is, so it behaves exactly as before.
assert_eq "the interactive equivalent succeeds" "0" "$interactive_rc"
flag_cmds="$(printf '%s\n' "$OUT" | grep -F '[dry-run] (cd' | sed -e "s|$TMPD|TMPD|g" -e 's|cerea-install-dryrun\.[A-Za-z0-9]*|cerea-install-dryrun.X|g')"
tty_cmds="$(printf '%s\n' "$interactive_out" | grep -F '[dry-run] (cd' | sed -e "s|$TMPD|TMPD|g" -e 's|cerea-install-dryrun\.[A-Za-z0-9]*|cerea-install-dryrun.X|g')"
assert_eq "flag-driven and prompt-driven runs produce identical compose lines" "$flag_cmds" "$tty_cmds"

# ---- 2: a missing decision is a loud, complete list
run_install --dry-run --pystino "$FAKE" --profile team --exposure edge
assert_eq "a missing PUBLIC_HOST fails" "1" "$RC"
assert_contains "the failure names the missing key" "PUBLIC_HOST" "$OUT"
assert_contains "the failure says how to supply it" "--set PUBLIC_HOST=VALUE" "$OUT"

# ---- 2b: with no decisions at all, the top-level ones are listed
run_install --dry-run --pystino "$FAKE" --non-interactive
assert_eq "a bare non-interactive run fails" "1" "$RC"
assert_contains "profile listed" "profile —" "$OUT"
assert_contains "exposure listed" "exposure —" "$OUT"

# ---- 3: flag vs metadata contradiction (--phase2) fails with both values
legacy_team_env
satellite_block
run_install --dry-run --phase2 --pystino "$FAKE" --profile team
assert_eq "the contradiction fails" "1" "$RC"
assert_contains "the flag's value is shown" "--profile team contradicts" "$OUT"
assert_contains "the block's value is shown" "INSTALLER_PROFILE=satellite" "$OUT"

# ---- 3b: the same contradiction on a flagged fresh run over the .env
run_install --dry-run --pystino "$FAKE" --profile team --exposure edge --idp house --set PUBLIC_HOST=x
assert_eq "the fresh-run contradiction fails" "1" "$RC"
assert_contains "the fresh-run contradiction names both values" "INSTALLER_PROFILE=satellite" "$OUT"

# ---- 3c: agreeing flags resume fine through the metadata block (the
# satellite fixture is internally consistent: values + block agree)
satellite_env
run_install --dry-run --phase2 --pystino "$FAKE" --profile satellite --exposure edge
assert_eq "flags agreeing with the metadata resume" "0" "$RC"
assert_contains "the metadata note is printed" "Installer metadata: profile=satellite exposure=edge idp=central" "$OUT"
assert_contains "the standalone phase 2 runs" "chat and proxy (no gateway services)" "$OUT"

# ---- 4: a legacy (block-less) .env still resumes via the infer fallback
legacy_team_env
run_install --dry-run --phase2 --pystino "$FAKE" --profile team --exposure edge
assert_eq "the legacy resume succeeds" "0" "$RC"
assert_contains "the infer fallback ran" "Inferred toggles: redaction=pattern fetch=direct metering=1" "$OUT"
assert_contains "the legacy resume prints its compose line" "[dry-run] (cd $FAKE && docker compose --env-file $FAKE/deploy/.env" "$OUT"

# ---- 4b: a legacy resume with no decisions at all fails loudly
run_install --dry-run --phase2 --pystino "$FAKE" --non-interactive
assert_eq "the legacy non-interactive resume fails" "1" "$RC"
assert_contains "profile listed" "profile —" "$OUT"
assert_contains "exposure listed" "exposure —" "$OUT"

# ---- 5: --set on a resume overrides and is validated
run_install --dry-run --phase2 --pystino "$FAKE" --profile team --exposure edge --set PUBLIC_HOST=changed.example
assert_eq "the resume --set succeeds" "0" "$RC"
assert_contains "the applied override is noted" "Applied 1 --set override(s)" "$OUT"
run_install --dry-run --phase2 --pystino "$FAKE" --profile team --exposure edge --set NOT_A_KEY=x
assert_eq "an unknown --set key fails on a resume too" "1" "$RC"

# ---- 6: bundled credentials in non-interactive runs
rm -f "$FAKE/deploy/.env"
run_install --dry-run --pystino "$FAKE" --profile team --exposure edge \
	--idp authelia --set PUBLIC_HOST=cerea.test
assert_eq "authelia without credentials fails" "1" "$RC"
assert_contains "the admin email is listed" "IDP_ADMIN_EMAIL" "$OUT"
assert_contains "the admin password is listed" "IDP_ADMIN_PASSWORD" "$OUT"
run_install --dry-run --pystino "$FAKE" --profile team --exposure edge \
	--idp authelia --admin-email op@example.org --set PUBLIC_HOST=cerea.test
assert_eq "authelia with a password env but no email still fails" "1" "$RC"
run_capture env IDP_ADMIN_PASSWORD=daily-pw TMPDIR="$TMPD" \
	bash "$CEREA_UNDER_TEST/installer/install.sh" --dry-run --pystino "$FAKE" \
	--profile team --exposure edge --idp authelia --admin-email op@example.org \
	--set PUBLIC_HOST=cerea.test
assert_eq "authelia with env password + --admin-email succeeds" "0" "$RC"
env_path="$(printf '%s\n' "$OUT" | sed -n 's/^The .env that would have been written: \(.*\) (mode 600)$/\1/p')"
assert_contains "the bundled shape is recorded" "INSTALLER_IDP=authelia" "$(cat "$env_path")"
assert_contains "the bundled auth mode is recorded" "INSTALLER_AUTH_MODE=bundled-authelia" "$(cat "$env_path")"

# ---- 7: --components
run_install --dry-run --pystino "$FAKE" --profile generic --exposure edge --components metering=on
assert_eq "--components is refused on a standalone profile" "1" "$RC"
assert_contains "the refusal names the fixed set" "fixed component set" "$OUT"
run_install --dry-run --pystino "$FAKE" --profile team --exposure edge --idp house \
	--set PUBLIC_HOST=cerea.test --components redaction=off,usage=hidden
assert_eq "--components overrides the team defaults" "0" "$RC"
env_path="$(printf '%s\n' "$OUT" | sed -n 's/^The .env that would have been written: \(.*\) (mode 600)$/\1/p')"
assert_contains "the overridden shape is what the block records" \
	"INSTALLER_COMPONENTS=redaction=off,fetch=direct,metering=on,usage=hidden,code-tool=on,knowledge=on,memory=on,code-panel=off" \
	"$(cat "$env_path")"
assert_contains "the overridden engine is what the .env records" "GATEWAY_REDACTION__ENGINE=noop" "$(cat "$env_path")"
assert_contains "a gateway profile serves /console, so the flag is on" "CHAT_CONSOLE_ENABLED=true" "$(cat "$env_path")"

# ---- 8: the standalone metadata block resumes verbatim (the shape the
# old heuristics mis-inferred live: CHAT_USAGE_ENABLED=false on satellite)
satellite_env
run_install --dry-run --phase2 --pystino "$FAKE" --non-interactive
assert_eq "the satellite metadata resume needs no flags at all" "0" "$RC"
assert_contains "profile came from the block" "Profile (installer metadata): satellite" "$OUT"
assert_contains "exposure came from the block" "Exposure (installer metadata): edge" "$OUT"
assert_contains "usage restored as shown, verbatim" "components=redaction=off,fetch=direct,metering=off,usage=shown" "$OUT"

# ---- 9: --admin-email for a shape that never asks is loud, not silent
rm -f "$FAKE/deploy/.env"
run_install --dry-run --pystino "$FAKE" --profile team --exposure edge \
	--idp house --set PUBLIC_HOST=cerea.test --admin-email op@example.org
assert_eq "an unconsumed --admin-email fails" "1" "$RC"
assert_contains "the unconsumed flag is named" "--admin-email op@example.org" "$OUT"

# ---- 10: wave 3 — compose profiles wiring, the wrapper, the admin bootstrap
rm -f "$FAKE/deploy/.env"
run_capture env IDP_ADMIN_PASSWORD=daily-pw TMPDIR="$TMPD" \
	bash "$CEREA_UNDER_TEST/installer/install.sh" --dry-run --pystino "$FAKE" \
	--profile team --exposure edge --idp authelia --admin-email op@example.org \
	--set PUBLIC_HOST=cerea.test
assert_eq "the bundled fresh dry-run succeeds" "0" "$RC"
env_path="$(printf '%s\n' "$OUT" | sed -n 's/^The .env that would have been written: \(.*\) (mode 600)$/\1/p')"
[ -n "$env_path" ] || flunk "the bundled dry run did not name its .env"
assert_contains "the .env carries COMPOSE_PROFILES for team+authelia" "COMPOSE_PROFILES=chat,authelia" "$(cat "$env_path")"
assert_contains "the .env carries the local-link flag (bundled shapes only)" "GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL=true" "$(cat "$env_path")"
assert_contains "the .env records the operator email (the resume re-seed reads it)" "IDP_ADMIN_EMAIL=op@example.org" "$(cat "$env_path")"
assert_contains "the phase-1 admin step mints for the operator email" "gateway passwd op@example.org --admin' (exec -T, no container TTY)" "$OUT"
assert_contains "the minted step is named in the dry-run note" "would mint the 'op@example.org' break-glass password" "$OUT"
assert_not_contains "a bundled shape never seeds admin@local" "passwd admin@local" "$OUT"
assert_contains "the profile-activated set is verified via config --services" \
	"config --services shows the profile-activated set: chat chat-mongo authelia ca-bundle" "$OUT"
assert_contains "the wrapper is printed on a dry run" "deploy/compose.sh wrapper a real run would write" "$OUT"
wrapper_out="$(printf '%s\n' "$OUT" | sed -n '/^#!/,/^esac$/p')"
[ -n "$wrapper_out" ] || flunk "the dry run printed no wrapper"
assert_contains "wrapper up maps to up -d" 'up)    shift; exec "${COMPOSE[@]}" up -d "$@" ;;' "$wrapper_out"
assert_contains "wrapper down maps to down" 'down)  shift; exec "${COMPOSE[@]}" down "$@" ;;' "$wrapper_out"
assert_contains "wrapper logs maps to logs -f" 'logs)  shift; exec "${COMPOSE[@]}" logs -f "$@" ;;' "$wrapper_out"
assert_contains "wrapper ps maps to ps" 'ps)    shift; exec "${COMPOSE[@]}" ps "$@" ;;' "$wrapper_out"
assert_contains "wrapper build maps to up -d --build" 'build) shift; exec "${COMPOSE[@]}" up -d --build "$@" ;;' "$wrapper_out"
# The flag lines are tab-indented; the header COMMENT mentions --profile, so
# the absence check must anchor to the generated flag lines, not the prose.
assert_not_contains "the wrapper emits no --profile flags when the .env has the line" \
	"$(printf '\t--profile')" "$wrapper_out"
assert_contains "the wrapper records the env-file" 'docker compose --env-file deploy/.env' "$wrapper_out"
assert_not_contains "no --no-deps in any printed line" "--no-deps" "$OUT"
assert_contains "the next steps name the adoption" "adopts that row" "$OUT"
assert_contains "the next steps render the promote SQL with the actual email" \
	"UPDATE users SET is_admin = true WHERE email = 'op@example.org'" "$OUT"
assert_contains "the next steps carry the Authelia hash recipe" "openssl passwd -6" "$OUT"
assert_contains "the next steps carry the Authelia roadmap line" "v4.40+" "$OUT"

# ---- 10b: the house shape keeps admin@local and writes none of the bundled keys
rm -f "$FAKE/deploy/.env"
run_install --dry-run --pystino "$FAKE" --profile team --exposure edge \
	--idp house --set PUBLIC_HOST=cerea.test
assert_eq "the house fresh dry-run succeeds" "0" "$RC"
env_path="$(printf '%s\n' "$OUT" | sed -n 's/^The .env that would have been written: \(.*\) (mode 600)$/\1/p')"
assert_contains "the house .env carries COMPOSE_PROFILES=chat" "COMPOSE_PROFILES=chat" "$(cat "$env_path")"
assert_not_contains "the house .env carries no local-link flag" "GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL" "$(cat "$env_path")"
assert_not_contains "the house .env records no operator email" "IDP_ADMIN_EMAIL" "$(cat "$env_path")"
assert_contains "the house phase-1 admin step mints for admin@local" "gateway passwd admin@local --admin' (exec -T, no container TTY)" "$OUT"

# ---- 10c: standalone — no --no-deps, named service sets, wrapper names them
run_install --dry-run --pystino "$FAKE" --profile satellite --exposure edge \
	--idp central --set PUBLIC_HOST=cerea.test --set OPENAI_BASE_URL=https://central.example \
	--set CHAT_OIDC_PROVIDER_URL=https://central.example --set CHAT_OIDC_CLIENT_ID=cerea \
	--set CHAT_OIDC_CLIENT_SECRET=ccs
assert_eq "the satellite-central fresh dry-run succeeds" "0" "$RC"
env_path="$(printf '%s\n' "$OUT" | sed -n 's/^The .env that would have been written: \(.*\) (mode 600)$/\1/p')"
assert_contains "the standalone .env carries COMPOSE_PROFILES=chat" "COMPOSE_PROFILES=chat" "$(cat "$env_path")"
assert_not_contains "the standalone .env carries no local-link flag" "GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL" "$(cat "$env_path")"
# The console flag's empty value means "no /console on this origin" — an
# empty line, so the check is grep-anchored (assert_contains is substring
# and cannot express "the line is exactly this").
if printf '%s\n' "$(cat "$env_path")" | grep -qx 'CHAT_CONSOLE_ENABLED='; then
	pass "the standalone .env leaves the console flag empty (no /console on this origin)"
else
	flunk "the standalone .env does not carry an empty CHAT_CONSOLE_ENABLED line"
fi
assert_not_contains "no --no-deps in the standalone lines" "--no-deps" "$OUT"
assert_contains "the standalone phase-2 line names its services" "up -d chat proxy" "$OUT"
wrapper_out="$(printf '%s\n' "$OUT" | sed -n '/^#!/,/^esac$/p')"
assert_contains "the wrapper's up names the standalone set" 'up -d chat proxy "$@"' "$wrapper_out"
# ---- 10d: satellite + bundled Authelia — the merged phase-1 line starts the proxy
run_capture env IDP_ADMIN_PASSWORD=daily-pw TMPDIR="$TMPD" \
	bash "$CEREA_UNDER_TEST/installer/install.sh" --dry-run --pystino "$FAKE" \
	--profile satellite --exposure edge --idp authelia --admin-email op@example.org \
	--set PUBLIC_HOST=cerea.test --set OPENAI_BASE_URL=https://central.example --set OPENAI_API_KEY=sk-central
assert_eq "the satellite-authelia fresh dry-run succeeds" "0" "$RC"
env_path="$(printf '%s\n' "$OUT" | sed -n 's/^The .env that would have been written: \(.*\) (mode 600)$/\1/p')"
assert_contains "the standalone bundled .env carries COMPOSE_PROFILES=chat,authelia" "COMPOSE_PROFILES=chat,authelia" "$(cat "$env_path")"
assert_contains "the standalone bundled .env carries the local-link flag" "GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL=true" "$(cat "$env_path")"
assert_not_contains "no --no-deps in the standalone bundled lines" "--no-deps" "$OUT"
assert_contains "the merged phase-1 line starts the proxy alongside the directory" \
	"up -d postgres chat-mongo authelia ca-bundle proxy" "$OUT"

# ---- 10e: a bundled legacy resume — the re-seed SQL, the wrapper --profile
# embeddings (the file predates the COMPOSE_PROFILES line), the next-steps
# email recovered from the seed file
legacy_team_authelia_env() {
	cat >"$FAKE/deploy/.env" <<'EOF'
# legacy fixture (no installer metadata block, bundled Authelia)
POSTGRES_PASSWORD=pgpass
GATEWAY_SECRET_KEY=gsk
GATEWAY_SESSION_SECRET=gss
GATEWAY_REDACTION__ENGINE=http
REDACTION_PLACEHOLDER_KEY=rpkey
REDACTION_LANGUAGE=en
SPACY_MODELS=
REDACTION_NLP_ENGINE=disabled
GATEWAY_ACCOUNTING__ENABLED=true
GATEWAY_QUOTA__ENABLED=true
GATEWAY_OIDC__ENABLED=true
GATEWAY_OIDC__ISSUER=https://legacy.example/authelia
GATEWAY_OIDC__CLIENT_ID=pystino-console
GATEWAY_OIDC__CLIENT_SECRET=ocs
GATEWAY_OIDC__GROUPS_CLAIM=groups
GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE=pystino-api
GATEWAY_LOCAL_AUTH__ENABLED=true
GATEWAY_IDP__ENABLED=false
GATEWAY_IDP__CLIENTS=[]
CHAT_REPO=/home/ubuntu/workspace/Cerea
CHAT_PG_URL=postgresql://chat:pg@postgres:5432/chat
CHAT_IDP_CLIENT_SECRET=cis
CHAT_SECRET_KEY=csk
CHAT_CODE_TOOL_ENABLED=true
CHAT_USAGE_ENABLED=true
CHAT_KNOWLEDGE_ENABLED=true
CHAT_MEMORY_ENABLED=true
CHAT_OIDC_PROVIDER_URL=https://legacy.example/authelia
CHAT_OIDC_CLIENT_ID=cerea
CHAT_OIDC_CLIENT_SECRET=ccs
CHAT_OIDC_SCOPES=openid profile email groups
FETCH_BACKEND=direct
IDP_BUNDLED=authelia
PUBLIC_HOST=legacy.example
HTTPS_PORT=8443
TLS_DIRECTIVE="tls internal"
PUBLIC_ORIGIN=https://legacy.example:8443
CHAT_PG_PASSWORD=pg
GATEWAY_PORT=8000
EOF
}
mkdir -p "$FAKE/deploy/idp"
printf 'users:\n  admin:\n    email: %s\n' "'seed-op@example.org'" >"$FAKE/deploy/idp/users_database.yml"
printf 'fixture: true\n' >"$FAKE/deploy/idp/authelia-configuration.yml"
legacy_team_authelia_env
run_install --dry-run --phase2 --pystino "$FAKE" --profile team --exposure edge
assert_eq "the bundled legacy resume succeeds" "0" "$RC"
assert_contains "the idp files existence is logged as skipped" "exists, skipping" "$OUT"
assert_contains "the re-seed count SQL is printed against the gateway db" \
	"exec -T postgres psql -U gateway -d gateway -tAc" "$OUT"
assert_contains "the count query names the admin column" "is_admin" "$OUT"
assert_contains "the conditional re-seed is noted with the recovered email" \
	"would re-run 'gateway passwd seed-op@example.org --admin'" "$OUT"
assert_not_contains "the legacy resume prints no admin@local" "passwd admin@local" "$OUT"
wrapper_out="$(printf '%s\n' "$OUT" | sed -n '/^#!/,/^esac$/p')"
assert_contains "the legacy-resume wrapper embeds the chat profile" "--profile chat" "$wrapper_out"
assert_contains "the legacy-resume wrapper embeds the IdP profile" "--profile authelia" "$wrapper_out"
assert_contains "the legacy-resume next steps render the promote SQL" \
	"UPDATE users SET is_admin = true WHERE email = 'seed-op@example.org'" "$OUT"

# ---- 10f: keycloak's admin email is the realm template's, not a flag
run_capture env IDP_FIRST_PASSWORD=first-pw TMPDIR="$TMPD" \
	bash "$CEREA_UNDER_TEST/installer/install.sh" --dry-run --pystino "$FAKE" \
	--profile team --exposure edge --idp keycloak --set PUBLIC_HOST=cerea.test
assert_eq "the keycloak fresh dry-run succeeds" "0" "$RC"
env_path="$(printf '%s\n' "$OUT" | sed -n 's/^The .env that would have been written: \(.*\) (mode 600)$/\1/p')"
assert_contains "keycloak .env carries COMPOSE_PROFILES=chat,keycloak" "COMPOSE_PROFILES=chat,keycloak" "$(cat "$env_path")"
assert_contains "keycloak .env records the realm template's first human" "IDP_ADMIN_EMAIL=owner@example.org" "$(cat "$env_path")"
assert_contains "keycloak phase-1 admin step mints for the template email" \
	"gateway passwd owner@example.org --admin' (exec -T, no container TTY)" "$OUT"
assert_contains "keycloak .env carries the local-link flag" "GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL=true" "$(cat "$env_path")"

# ---- 10g: the derived keys are not --set-able
run_install --dry-run --pystino "$FAKE" --profile team --exposure edge --idp house \
	--set PUBLIC_HOST=cerea.test --set COMPOSE_PROFILES=chat
assert_eq "--set COMPOSE_PROFILES is refused" "1" "$RC"
assert_contains "the refusal says the profiles are derived" "derived from the install shape" "$OUT"
run_install --dry-run --pystino "$FAKE" --profile team --exposure edge --idp house \
	--set PUBLIC_HOST=cerea.test --set GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL=true
assert_eq "--set GATEWAY_OIDC__LINK_LOCAL_BY_EMAIL is refused" "1" "$RC"

summary "test-install.sh"

# ---- 11: Ctrl+C is a full stop — the INT trap exits, never resumes
# The handler replaces the default SIGINT death; a trap that only prints
# and returns would resume the install mid-flow. The signal is fired
# from inside the child (kill -INT $$) because an external kill cannot
# reach a backgrounded child from every test environment — the semantics
# under test are the handler's, and the handler cannot tell the two
# apart: the same code path runs the moment the trap fires.
trap_out="$(bash -c '
	trap "printf \"Aborted-line\n\" >&2; trap - INT; kill -INT \$\$" INT
	kill -INT $$
	echo NEVER
' 2>&1; echo "rc=$?")"
if printf '%s' "$trap_out" | grep -q NEVER; then
	assert_eq "the INT trap does not resume the script" "stops" "resumed"
else
	assert_eq "the INT trap does not resume the script" "stops" "stops"
fi
assert_contains "the abort message prints" "Aborted-line" "$trap_out"
assert_contains "the exit status is 130 (signal death, not a clean run)" "rc=130" "$trap_out"

summary "test-install.sh"

# ---- 12: trust is re-asserted AFTER phase 2's up (the stale-root hole)
# The live failure: phase 1's CA dance bundled that moment's root; phase
# 2's `up` recreated the proxy (fresh caddy-data volume ⇒ new root) and
# every OIDC discovery died on CERTIFICATE_VERIFY_FAILED. Both phase-2
# variants must now carry the post-up assertion, and the dry-run note
# states the restart-on-rebundle-only contract.
rm -f "$FAKE/deploy/.env"
run_capture env IDP_ADMIN_PASSWORD=daily-pw TMPDIR="$TMPD" \
	bash "$CEREA_UNDER_TEST/installer/install.sh" --dry-run --pystino "$FAKE" \
	--profile team --exposure edge --idp authelia --admin-email op@example.org \
	--set PUBLIC_HOST=cerea.test --chat-repo "$CEREA_UNDER_TEST"
assert_contains "the gateway phase-2 re-asserts trust after its up" \
	"would re-assert the proxy's root is trusted after bring-up" "$OUT"
# The standalone case needs the bundled IdP: central has no proxy root to
# trust and the assertion correctly stays silent for it.
satellite_env
sed -i 's/^INSTALLER_IDP=central$/INSTALLER_IDP=authelia/; s/^INSTALLER_AUTH_MODE=central$/INSTALLER_AUTH_MODE=bundled-authelia/' "$FAKE/deploy/.env"
printf 'IDP_BUNDLED=authelia\nOPENAI_API_KEY=central-key-for-local-idp\nUSE_USER_TOKEN=false\n' >>"$FAKE/deploy/.env"
run_install --dry-run --pystino "$FAKE" --phase2 --non-interactive
assert_contains "the standalone phase-2 re-asserts trust after its up" \
	"would re-assert the proxy's root is trusted after bring-up" "$OUT"

summary "test-install.sh"
