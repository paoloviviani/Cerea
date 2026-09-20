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
	' 2>&1
}

# ---- 1: the snippet lands above the first site, and both sites import it
netbird_fixture "$TMPD/p1"
run_ensure "$TMPD/p1" >/dev/null
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

# ---- 2: idempotent — a re-run finds the marker and touches nothing
cp "$nb" "$TMPD/p1/before"
run_ensure "$TMPD/p1" >/dev/null
assert_eq "a second run leaves the file byte-identical" "$(cat "$TMPD/p1/before")" "$(cat "$nb")"

# ---- 3: the crash-loop shape would have been caught — no site opener, refuse
mkdir -p "$TMPD/p3/deploy/caddy/conf.d-authelia"
printf '(origin-routes) {\n\thandle {\n\t\treverse_proxy gateway:8000\n\t}\n}\n' >"$TMPD/p3/deploy/caddy/Caddyfile.netbird"
printf 'handle /authelia/* {\n}\n' >"$TMPD/p3/deploy/caddy/conf.d-authelia/20-authelia.caddy"
if run_ensure "$TMPD/p3" >/dev/null 2>&1; then
	assert_eq "a netbird with no site opener is refused" "refused" "accepted"
else
	assert_eq "a netbird with no site opener is refused" "refused" "refused"
fi

summary "test-netbird.sh"
