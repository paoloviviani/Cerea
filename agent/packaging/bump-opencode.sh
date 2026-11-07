#!/bin/sh
# Move the pinned opencode release: rewrites agent/packaging/opencode-version
# (embedded into galopin, installed by CI) and OPENCODE_VERSION in
# src/lib/codeEnrollCommand.ts (the panel's install line), then prints what to
# run before committing. It also records the sha256 of the nine release archives (baseline and musl builds included)
# the served installer verifies. See "opencode releases" in agent/README.md.
#
#   agent/packaging/bump-opencode.sh <version>      e.g. 1.18.33
set -eu
case "${1:-}" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "usage: $0 <version>   (MAJOR.MINOR.PATCH, e.g. 1.18.33)" >&2; exit 2 ;;
esac
case "$1" in *[!0-9.]*) echo "version must be MAJOR.MINOR.PATCH digits only: $1" >&2; exit 2 ;; esac
version=$1
root=$(cd "$(dirname "$0")/../.." && pwd)
ts="$root/src/lib/codeEnrollCommand.ts"
grep -q '^export const OPENCODE_VERSION = "[0-9.]*";$' "$ts" || {
    echo "OPENCODE_VERSION line not found in $ts" >&2; exit 1; }
base=${OPENCODE_DL_BASE:-https://github.com/anomalyco/opencode/releases/download}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
: > "$tmp/sums"
for name in opencode-linux-x64.tar.gz opencode-linux-x64-baseline.tar.gz opencode-linux-x64-musl.tar.gz \
    opencode-linux-x64-baseline-musl.tar.gz opencode-linux-arm64.tar.gz opencode-linux-arm64-musl.tar.gz \
    opencode-darwin-x64.zip opencode-darwin-x64-baseline.zip opencode-darwin-arm64.zip; do
    echo "downloading $name ..." >&2
    curl -fsSL -o "$tmp/$name" "$base/v$version/$name"
    sum=$(sha256sum "$tmp/$name" | cut -d ' ' -f 1)
    printf '%s  %s\n' "$sum" "$name" >> "$tmp/sums"
done
cp "$tmp/sums" "$root/agent/packaging/opencode-sha256"
node -e '
const fs = require("fs");
const [file, sums] = process.argv.slice(1);
let src = fs.readFileSync(file, "utf8");
const lines = fs.readFileSync(sums, "utf8").trim().split("\n").map((l) => l.split(/\s+/));
const block = lines.map(([h, n]) => `\t"${n}": "${h}",`).join("\n");
src = src.replace(/(export const OPENCODE_SHA256: Record<string, string> = \{\n)[\s\S]*?(\n\};)/, `$1${block}$2`);
fs.writeFileSync(file, src);
' "$root/src/lib/opencodeVersion.ts" "$tmp/sums"
printf '%s\n' "$version" > "$root/agent/packaging/opencode-version"
sed -i "s/^export const OPENCODE_VERSION = \"[0-9.]*\";\$/export const OPENCODE_VERSION = \"$version\";/" "$ts"
echo "pinned opencode $version in:"
echo "  agent/packaging/opencode-version"
echo "  src/lib/codeEnrollCommand.ts"
echo "  agent/packaging/opencode-sha256, src/lib/opencodeVersion.ts (archive checksums)"
cat <<MSG

Before committing, prove it locally (real opencode, one at a time on a shared box):
  npm i -g opencode-ai@$version && opencode --version
  cd agent && GALOPIN_OPENCODE_IT=1 GALOPIN_ACP_IT=1 go test -count=1 -v -timeout 25m ./...
  cd .. && npx vitest run --project=server src/lib/codeEnrollCommand.spec.ts

Then update the prose that names the release if it changed behaviour
(docs/agent-machines-reference.md, agent/PROTOCOL.md "verified against" notes) and
commit with the pipeline's issue number.
MSG
