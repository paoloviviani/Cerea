#!/bin/sh
# Move the pinned goose release (ADR 0110): downloads the four official release
# archives, records their sha256 (upstream publishes none) in
# agent/packaging/goose-sha256, writes agent/packaging/goose-version, and
# rewrites GOOSE_VERSION / GOOSE_SHA256 in src/lib/gooseVersion.ts (the served
# install script's copy). Prints what to run before committing.
#
#   agent/packaging/bump-goose.sh <version>      e.g. 1.57.0
#
# GOOSE_DL_BASE overrides the download base (tests); default
# https://github.com/block/goose/releases/download.
set -eu
case "${1:-}" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "usage: $0 <version>   (MAJOR.MINOR.PATCH, e.g. 1.57.0)" >&2; exit 2 ;;
esac
case "$1" in *[!0-9.]*) echo "version must be MAJOR.MINOR.PATCH digits only: $1" >&2; exit 2 ;; esac
version=$1
root=$(cd "$(dirname "$0")/../.." && pwd)
ts="$root/src/lib/gooseVersion.ts"
base=${GOOSE_DL_BASE:-https://github.com/block/goose/releases/download}
grep -q '^export const GOOSE_VERSION = "[0-9.]*";$' "$ts" || {
    echo "GOOSE_VERSION line not found in $ts" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
: > "$tmp/sums"
for target in aarch64-apple-darwin aarch64-unknown-linux-gnu x86_64-apple-darwin x86_64-unknown-linux-gnu; do
    name="goose-$target.tar.gz"
    echo "downloading $name ..." >&2
    curl -fsSL -o "$tmp/$name" "$base/v$version/$name"
    sum=$(sha256sum "$tmp/$name" | cut -d ' ' -f 1)
    printf '%s  %s\n' "$sum" "$name" >> "$tmp/sums"
done
printf '%s\n' "$version" > "$root/agent/packaging/goose-version"
cp "$tmp/sums" "$root/agent/packaging/goose-sha256"
# The TS copy: GOOSE_SHA256 block between its marker lines.
node -e '
const fs = require("fs");
const [ts, sums, version] = process.argv.slice(1);
let src = fs.readFileSync(ts, "utf8");
const lines = fs.readFileSync(sums, "utf8").trim().split("\n").map((l) => l.split(/\s+/));
const block = lines.map(([h, n]) => `\t"${n}": "${h}",`).join("\n");
src = src.replace(/^export const GOOSE_VERSION = "[0-9.]*";$/m, `export const GOOSE_VERSION = "${version}";`);
src = src.replace(/(export const GOOSE_SHA256: Record<string, string> = \{\n)[\s\S]*?(\n\};)/, `$1${block}$2`);
fs.writeFileSync(ts, src);
' "$ts" "$tmp/sums" "$version"
echo "pinned goose $version in:"
echo "  agent/packaging/goose-version"
echo "  agent/packaging/goose-sha256"
echo "  src/lib/gooseVersion.ts"
cat <<MSG

Before committing, prove it locally (real goose, one at a time on a shared box):
  put the goose $version binary on PATH, then
  cd agent && GALOPIN_GOOSE_IT=1 go test -count=1 -v -timeout 15m -run Goose ./...
  cd .. && npx vitest run --project=server src/lib/gooseVersion.spec.ts
Then update prose that names the release (docs/agent-machines-reference.md) and commit.
MSG
