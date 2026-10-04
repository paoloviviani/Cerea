#!/bin/sh
# Move the pinned opencode release: rewrites agent/packaging/opencode-version
# (embedded into galopin, installed by CI) and OPENCODE_VERSION in
# src/lib/codeEnrollCommand.ts (the panel's install line), then prints what to
# run before committing. See "opencode releases" in agent/README.md.
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
printf '%s\n' "$version" > "$root/agent/packaging/opencode-version"
sed -i "s/^export const OPENCODE_VERSION = \"[0-9.]*\";\$/export const OPENCODE_VERSION = \"$version\";/" "$ts"
echo "pinned opencode $version in:"
echo "  agent/packaging/opencode-version"
echo "  src/lib/codeEnrollCommand.ts"
cat <<MSG

Before committing, prove it locally (real opencode, one at a time on a shared box):
  npm i -g opencode-ai@$version && opencode --version
  cd agent && GALOPIN_OPENCODE_IT=1 GALOPIN_ACP_IT=1 go test -count=1 -v -timeout 25m ./...
  cd .. && npx vitest run --project=server src/lib/codeEnrollCommand.spec.ts

Then update the prose that names the release if it changed behaviour
(docs/agent-machines.md, agent/PROTOCOL.md "verified against" notes) and
commit with the pipeline's issue number.
MSG
