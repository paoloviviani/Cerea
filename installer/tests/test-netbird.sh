#!/usr/bin/env bash
# ensure_edge_idp_route: the bundled IdP's snippet must land ABOVE the
# sites that import it. Caddy adapts a Caddyfile top-down — 'File to
# import not found' was a live proxy crash-loop on a fresh install, born
# of appending the (idp-routes) snippet after the sites (the original
# ensure_edge_idp_route wrote it at the end). These cases pin the fixed
# insertion point against the real netbird shape: globals, the auto_https
# block, the (origin-routes) snippet, then the :8443 and TLS sites.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
. tests/lib.sh
. lib/term.sh

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/cerea-netbird-tests.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT

# The netbird shape, distilled but faithful: the first ^}$ closes the
# auto_https block BEFORE (origin-routes), so a "split at the first
# closing brace" approach silently mangles the file — the site-block
# opener is the only safe anchor, and the first test would catch exactly
# that regression.
netbird_fixture() { # netbird_fixture <dir>
	mkdir -p "$1/deploy/caddy/conf.d-authelia"
	cat >"$1/deploy/caddy/Caddyfile.netbird" <<'EOF'
{
	auto_https disable_redirects
}

(origin-routes) {
	@minting path /oauth/token /auth/token /auth/revoke
	handle @minting {
		reverse_proxy gateway:8000
	}
	handle /chat/* {
		uri strip_prefix /chat
		reverse_proxy chat:3000
	}
	handle {
		reverse_proxy gateway:8000
	}
}

# The edge's hop: plain HTTP, TLS already handled upstream.
:8443 {
	import origin-routes
}

cerea.example {
	tls internal
	import origin-routes
}
EOF
	printf 'handle /authelia/* {\n\treverse_proxy authelia:9091\n}\n' \
		>"$1/deploy/caddy/conf.d-authelia/20-authelia.caddy"
}

run_ensure() { # run_ensure <pystino-root> — drives the real function
	IDP_BUNDLED=authelia EXPOSURE=edge DRY_RUN=0 PYSTINO_ROOT="$1" bash -c '
		source ./lib/term.sh
		VALUES[IDP_BUNDLED]=authelia
		'"$(sed -n '/^ensure_edge_idp_route() {/,/^}/p' ./install.sh)"'
		ensure_edge_idp_route
		echo "EDGE_ROUTE_WRITTEN=${EDGE_ROUTE_WRITTEN:-0}"
	' 2>&1
}

# ---- 1: the snippet lands above the first site, and both sites import it
netbird_fixture "$TMPD/p1"
out1="$(run_ensure "$TMPD/p1")"
nb="$TMPD/p1/deploy/caddy/Caddyfile.netbird"
snippet_line="$(grep -n '^(idp-routes) {$' "$nb" | cut -d: -f1 | head -1)"
site_line="$(grep -nE '^:8443 \{$' "$nb" | cut -d: -f1 | head -1)"
assert_eq "the (idp-routes) snippet sits above the :8443 site" "above" "$([ -n "$snippet_line" ] && [ -n "$site_line" ] && [ "$snippet_line" -lt "$site_line" ] && echo above || echo below)"
imports="$(grep -c $'^\timport idp-routes$' "$nb")"
assert_eq "both sites import idp-routes" "2" "$imports"
assert_eq "the auto_https block is intact" "1" "$(sed -n '1,3p' "$nb" | grep -c 'auto_https disable_redirects')"
assert_eq "the marker line travels with the snippet" "1" "$(grep -c 'installer: bundled authelia route' "$nb")"
# The origin-routes snippet must appear exactly once — a bad split point
# would duplicate the file body.
assert_eq "(origin-routes) appears exactly once" "1" "$(grep -c '^(origin-routes) {$' "$nb")"
assert_eq "the file has exactly two site blocks" "2" "$(grep -cE '^(:8443|cerea\.example) \{$' "$nb")"
# A caller (the resume/fresh-install branches in install.sh) decides whether
# to restart the already-running proxy from this: a real write must report 1.
assert_contains "a real write reports EDGE_ROUTE_WRITTEN=1" "EDGE_ROUTE_WRITTEN=1" "$out1"

# ---- 2: idempotent — a re-run finds the marker and touches nothing, and
# reports nothing written (so a caller does not restart the proxy for no
# reason on every resume)
cp "$nb" "$TMPD/p1/before"
out2="$(run_ensure "$TMPD/p1")"
assert_eq "a second run leaves the file byte-identical" "$(cat "$TMPD/p1/before")" "$(cat "$nb")"
assert_contains "a no-op re-run reports EDGE_ROUTE_WRITTEN=0" "EDGE_ROUTE_WRITTEN=0" "$out2"

# ---- 3: the crash-loop shape would have been caught — no site opener, refuse
mkdir -p "$TMPD/p3/deploy/caddy/conf.d-authelia"
printf '(origin-routes) {\n\thandle {\n\t\treverse_proxy gateway:8000\n\t}\n}\n' >"$TMPD/p3/deploy/caddy/Caddyfile.netbird"
printf 'handle /authelia/* {\n}\n' >"$TMPD/p3/deploy/caddy/conf.d-authelia/20-authelia.caddy"
if run_ensure "$TMPD/p3" >/dev/null 2>&1; then
	assert_eq "a netbird with no site opener is refused" "refused" "accepted"
else
	assert_eq "a netbird with no site opener is refused" "refused" "refused"
fi

# ---- 4: ensure_edge_relay_route reports the same way ensure_edge_idp_route
# does. Its snippet lives under CEREA_ROOT, not PYSTINO_ROOT — the two roots
# are deliberately different tmp dirs here so a function that reached for
# the wrong one would fail loudly instead of happening to find a file.
run_ensure_relay() { # run_ensure_relay <pystino-root> <cerea-root>
	CODE_AGENTS_ENABLED=true EXPOSURE=edge DRY_RUN=0 PYSTINO_ROOT="$1" CEREA_ROOT="$2" bash -c '
		source ./lib/term.sh
		VALUES[CODE_AGENTS_ENABLED]=true
		'"$(sed -n '/^ensure_edge_relay_route() {/,/^}/p' ./install.sh)"'
		ensure_edge_relay_route
		echo "EDGE_ROUTE_WRITTEN=${EDGE_ROUTE_WRITTEN:-0}"
	' 2>&1
}

netbird_fixture "$TMPD/p4"
mkdir -p "$TMPD/cerea/deploy/caddy/conf.d-code-relay"
printf 'handle /ws {\n\treverse_proxy relay:8080\n}\n' >"$TMPD/cerea/deploy/caddy/conf.d-code-relay/20-relay.caddy"
out4="$(run_ensure_relay "$TMPD/p4" "$TMPD/cerea")"
nb4="$TMPD/p4/deploy/caddy/Caddyfile.netbird"
assert_contains "the relay route's real write reports EDGE_ROUTE_WRITTEN=1" "EDGE_ROUTE_WRITTEN=1" "$out4"
assert_eq "both sites import relay-routes" "2" "$(grep -c $'^\timport relay-routes$' "$nb4")"
assert_eq "the marker line travels with the relay snippet" "1" "$(grep -c 'installer: relay /ws route' "$nb4")"

cp "$nb4" "$TMPD/p4/before"
out5="$(run_ensure_relay "$TMPD/p4" "$TMPD/cerea")"
assert_eq "a second relay-route run leaves the file byte-identical" "$(cat "$TMPD/p4/before")" "$(cat "$nb4")"
assert_contains "a no-op relay-route re-run reports EDGE_ROUTE_WRITTEN=0" "EDGE_ROUTE_WRITTEN=0" "$out5"

summary "test-netbird.sh"
