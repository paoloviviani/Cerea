#!/usr/bin/env bash
# galopin-last-changed.sh X.Y.Z [--check]
# Keeps agent/LAST_CHANGED (the last Cerea version that changed galopin) true for the release
# commit of X.Y.Z. If galopin's sources changed since the previous release tag (agent/ outside
# docs and *_test.go), the file must say X.Y.Z; otherwise it is left alone. Idempotent.
#   (no flag)  write the file when it needs X.Y.Z; run it before the release commit
#   --check    change nothing; exit 1 if the file is wrong (release.sh runs this)
# Env: REF (default HEAD) is the commit to compare; PREV overrides the previous tag.
set -euo pipefail
V=${1:?usage: galopin-last-changed.sh X.Y.Z [--check]}
MODE=${2:-write}
cd "$(git rev-parse --show-toplevel)"
REF=${REF:-HEAD}
PREV=${PREV:-$(git tag --list 'v[0-9]*' --sort=-v:refname | grep -vx "v$V" | head -1)}
FILE=agent/LAST_CHANGED
changed=0
if [ -z "$PREV" ] || [ -n "$(git diff --name-only "$PREV" "$REF" -- agent ':!agent/**/*.md' ':!agent/*.md' ':!agent/**/*_test.go' ':!agent/*_test.go' ":!$FILE")" ]; then
	changed=1
fi
if [ "$changed" = 1 ]; then want=$V; else want=$(git show "$REF:$FILE" 2>/dev/null | tr -d '[:space:]' || true); fi
have=$(git show "$REF:$FILE" 2>/dev/null | tr -d '[:space:]' || true)
if [ "$MODE" = "--check" ]; then
	[ "$have" = "$want" ] || { echo "$FILE says '$have', should say '$want' (run scripts/release/galopin-last-changed.sh $V)"; exit 1; }
	exit 0
fi
[ -n "$want" ] && printf '%s\n' "$want" >"$FILE"
echo "$FILE: $want"
