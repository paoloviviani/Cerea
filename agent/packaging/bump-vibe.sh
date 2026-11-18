#!/bin/sh
# Move the pinned Mistral Vibe release: resolves mistral-vibe==<version> and every
# dependency for every platform galopin runs on (a universal lock, Python >= 3.12),
# with the sha256 of each file, into agent/packaging/vibe-requirements.txt (the
# --require-hashes format the installer feeds to uv/pip), writes
# agent/packaging/vibe-version, and rewrites VIBE_VERSION / VIBE_LOCK_SHA256 in
# src/lib/vibeVersion.ts (the served install script's copy). Needs `uv` and `node`.
#
#   agent/packaging/bump-vibe.sh <version>      e.g. 3.1.3
#
# VIBE_INDEX_URL overrides the package index (tests); default PyPI.
set -eu
case "${1:-}" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "usage: $0 <version>   (MAJOR.MINOR.PATCH, e.g. 3.1.3)" >&2; exit 2 ;;
esac
case "$1" in *[!0-9.]*) echo "version must be MAJOR.MINOR.PATCH digits only: $1" >&2; exit 2 ;; esac
version=$1
root=$(cd "$(dirname "$0")/../.." && pwd)
ts="$root/src/lib/vibeVersion.ts"
grep -q '^export const VIBE_VERSION = "[0-9.]*";$' "$ts" || {
    echo "VIBE_VERSION line not found in $ts" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
printf 'mistral-vibe==%s\n' "$version" > "$tmp/in.txt"
index=
[ -z "${VIBE_INDEX_URL:-}" ] || index="--index-url $VIBE_INDEX_URL"
# shellcheck disable=SC2086
uv pip compile --universal --generate-hashes --python-version 3.12 --no-header --no-annotate \
    $index "$tmp/in.txt" -o "$tmp/lock.txt" >&2
grep -q "^mistral-vibe==$version " "$tmp/lock.txt" || { echo "the lock does not pin mistral-vibe==$version" >&2; exit 1; }
printf '%s\n' "$version" > "$root/agent/packaging/vibe-version"
cp "$tmp/lock.txt" "$root/agent/packaging/vibe-requirements.txt"
sum=$(sha256sum "$root/agent/packaging/vibe-requirements.txt" | cut -d ' ' -f 1)
node -e '
const fs = require("fs");
const [ts, version, sum] = process.argv.slice(1);
let src = fs.readFileSync(ts, "utf8");
src = src.replace(/^export const VIBE_VERSION = "[0-9.]*";$/m, `export const VIBE_VERSION = "${version}";`);
src = src.replace(/^export const VIBE_LOCK_SHA256 = "[0-9a-f]*";$/m, `export const VIBE_LOCK_SHA256 = "${sum}";`);
fs.writeFileSync(ts, src);
' "$ts" "$version" "$sum"
echo "pinned Mistral Vibe $version in:"
echo "  agent/packaging/vibe-version"
echo "  agent/packaging/vibe-requirements.txt ($sum)"
echo "  src/lib/vibeVersion.ts"
cat <<MSG

Before committing, prove it locally (one at a time on a shared box):
  install it (uv venv V && uv pip install --python V/bin/python --require-hashes --no-deps -r agent/packaging/vibe-requirements.txt), then
  cd agent && GALOPIN_VIBE_IT=1 GALOPIN_VIBE_BIN=V/bin/vibe-acp go test -count=1 -v -timeout 15m -run Vibe ./...
  npx vitest run --project=server src/lib/vibeVersion.spec.ts
Then update prose that names the release (docs/agent-machines-reference.md) and commit.
MSG
