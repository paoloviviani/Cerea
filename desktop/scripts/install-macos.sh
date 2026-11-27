#!/bin/sh
# Install or update the Cerea desktop app (preview) on macOS from a Cerea release, without the
# Gatekeeper prompt. The preview is not signed or notarised, so a downloaded copy is quarantined and
# macOS asks before the first start; this script installs exactly the release's build, after its
# checksum matches, and clears the quarantine flag on it.
#
#   sh install-macos.sh            the latest release
#   sh install-macos.sh v0.67.1    a given release
#
# It picks the build for this Mac's chip, quits a running Cerea, replaces /Applications/Cerea.app
# and opens it. The app's settings (profiles, pairings) live in ~/Library/Application Support and
# are kept. Attached to every Cerea release as Cerea-Desktop-PREVIEW-install-macos.sh.
set -eu

REPO=paoloviviani/Cerea
APP=/Applications/Cerea.app

[ "$(uname -s)" = Darwin ] || {
	echo "this script is for macOS; on Linux use the AppImage or the .deb" >&2
	exit 1
}

if [ $# -gt 0 ]; then
	TAG=$1
else
	TAG=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed 's#.*/tag/##')
fi
case "$TAG" in
v[0-9]*.[0-9]*.[0-9]*) ;;
*)
	echo "not a release tag: $TAG (expected vX.Y.Z)" >&2
	exit 1
	;;
esac
V=${TAG#v}

case "$(uname -m)" in
arm64) ARCH=apple-silicon ;;
x86_64) ARCH=intel ;;
*)
	echo "unsupported Mac: $(uname -m)" >&2
	exit 1
	;;
esac

ZIP="Cerea-Desktop-PREVIEW-$V-macos-$ARCH.zip"
SUMS="Cerea-Desktop-PREVIEW-$V-SHA256SUMS.txt"
BASE="https://github.com/$REPO/releases/download/$TAG"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $ZIP ($TAG)"
curl -fL --progress-bar -o "$TMP/$ZIP" "$BASE/$ZIP"
curl -fsSL -o "$TMP/$SUMS" "$BASE/$SUMS"
grep " $ZIP\$" "$TMP/$SUMS" >"$TMP/sum" || {
	echo "$ZIP is not listed in $SUMS: not installing" >&2
	exit 1
}
(cd "$TMP" && shasum -a 256 -c sum) || {
	echo "checksum mismatch: not installing" >&2
	exit 1
}

ditto -x -k "$TMP/$ZIP" "$TMP/app"
[ -d "$TMP/app/Cerea.app" ] || {
	echo "Cerea.app is not in $ZIP" >&2
	exit 1
}

# Quit a running Cerea so its files can be replaced; it stops its galopin and starts it again.
osascript -e 'quit app "Cerea"' >/dev/null 2>&1 || true
i=0
while pgrep -xq Cerea && [ $i -lt 20 ]; do
	sleep 1
	i=$((i + 1))
done

rm -rf "$APP"
ditto "$TMP/app/Cerea.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "Installed Cerea $V in /Applications."
open "$APP"
