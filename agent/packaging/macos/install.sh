#!/bin/sh
# Install, upgrade or remove "Cerea connector", the galopin menu-bar app for macOS.
#
#   curl -fsSL https://github.com/paoloviviani/Cerea/releases/latest/download/install-cerea-connector.sh | sh
#
#   install.sh                     download this Mac's build from the latest release
#   install.sh ZIP_OR_URL          install a given zip (a path or an https URL), for testing
#   install.sh --uninstall [--purge]
#
# Options: --sha256 HEX   the zip's expected SHA-256 (else ZIP.sha256 beside it)
#
# Unpacks into ~/Applications, signs it ad hoc (no Apple account: Apple Silicon
# needs a signature, not a notarized one), writes the LaunchAgent files and
# opens the app. curl sets no quarantine flag, so Gatekeeper does not stop it.
# Run it again to upgrade in place; pairing and settings are kept.
set -eu

APP_NAME="Cerea connector.app"
SERVICE_LABEL=org.cerea.galopin
TRAY_LABEL=org.cerea.connector
BASE_URL=${CEREA_CONNECTOR_BASE_URL:-https://github.com/paoloviviani/Cerea/releases/latest/download}

say() { printf '%s\n' "$*"; }
die() { printf 'Cerea connector: %s\n' "$*" >&2; exit 1; }

uninstall=0 purge=0 src='' want_sha=''
while [ $# -gt 0 ]; do
    case $1 in
    --uninstall) uninstall=1 ;;
    --purge) purge=1 ;;
    --sha256) [ $# -ge 2 ] || die "--sha256 needs a value"; want_sha=$2; shift ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$src" ] || die "one zip only"; src=$1 ;;
    esac
    shift
done

[ -n "${HOME:-}" ] || die "HOME is not set"
if [ "${CEREA_ALLOW_NON_MAC:-}" != 1 ] && [ "$(uname -s)" != Darwin ]; then
    die "this is the macOS app; it only installs on a Mac"
fi
uid=$(id -u)
apps="$HOME/Applications"
app="$apps/$APP_NAME"
agents="$HOME/Library/LaunchAgents"
support="$HOME/Library/Application Support/galopin"

stop_everything() {
    launchctl bootout "gui/$uid/$SERVICE_LABEL" >/dev/null 2>&1 || true
    launchctl bootout "gui/$uid/$TRAY_LABEL" >/dev/null 2>&1 || true
    pkill -x galopin-tray >/dev/null 2>&1 || true
    # Any galopin from the app's bundle still running (a manual run, a crash
    # leftover): stop it, and kill it if it does not go within a few seconds.
    stray="Cerea connector\\.app/Contents/Resources/galopin( |$)"
    pkill -u "$uid" -f "$stray" >/dev/null 2>&1 || true
    n=0
    while pgrep -u "$uid" -f "$stray" >/dev/null 2>&1 && [ $n -lt 10 ]; do sleep 0.5; n=$((n + 1)); done
    pkill -9 -u "$uid" -f "$stray" >/dev/null 2>&1 || true
}

if [ "$uninstall" = 1 ]; then
    say "Removing Cerea connector..."
    stop_everything
    rm -f "$agents/$TRAY_LABEL.plist" "$agents/$SERVICE_LABEL.plist" "$support/$SERVICE_LABEL.plist"
    rm -rf "$app"
    if [ "$purge" = 1 ]; then
        rm -rf "$support" "$HOME/Library/Logs/galopin.log"
        say "Removed its pairing and logs too."
    else
        say "Kept its pairing and logs. To remove those as well, run this again with --purge,"
        say "or delete the folder: $support"
    fi
    say "Also remove this Mac in Cerea (Agents panel) so it is not listed any more."
    say "Done."
    exit 0
fi

case $(uname -m) in
arm64 | aarch64) arch=arm64 ;;
x86_64 | amd64) arch=amd64 ;;
*) die "unsupported processor: $(uname -m)" ;;
esac
[ -z "${CEREA_ARCH:-}" ] || arch=$CEREA_ARCH

work=$(mktemp -d "${TMPDIR:-/tmp}/cerea-connector.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM
zip="$work/connector.zip"

fetch() { # URL DEST
    curl -fsSL --retry 2 -o "$2" "$1" || die "could not download $1"
}
case ${src:-} in
"")
    say "Downloading Cerea connector for this Mac ($arch)..."
    zipname="Cerea-connector-macos-$arch.zip"
    fetch "$BASE_URL/$zipname" "$zip"
    [ -n "$want_sha" ] || { fetch "$BASE_URL/$zipname.sha256" "$work/sum"; want_sha=$(cut -d' ' -f1 "$work/sum"); }
    ;;
http://* | https://*)
    say "Downloading $src..."
    fetch "$src" "$zip"
    [ -n "$want_sha" ] || { fetch "$src.sha256" "$work/sum" 2>/dev/null && want_sha=$(cut -d' ' -f1 "$work/sum"); } || true
    ;;
*)
    [ -f "$src" ] || die "no such file: $src"
    cp "$src" "$zip"
    if [ -z "$want_sha" ] && [ -f "$src.sha256" ]; then want_sha=$(cut -d' ' -f1 "$src.sha256"); fi
    ;;
esac

if command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$zip"); else got=$(sha256sum "$zip"); fi
got=${got%% *}
if [ -n "$want_sha" ]; then
    [ "$got" = "$want_sha" ] || die "the download is damaged or not the expected one (checksum mismatch). Nothing was installed."
else
    say "Note: no checksum to compare with, so the download was not verified."
fi

unzip -q "$zip" -d "$work/unpacked" || die "could not unpack the download"
[ -d "$work/unpacked/$APP_NAME" ] || die "the download does not contain $APP_NAME"

# Upgrade in place: stop the old one first, then replace it.
upgrading=0; [ -d "$app" ] && upgrading=1
stop_everything
# A galopin LaunchAgent from the manual install is replaced by the app's own.
rm -f "$agents/$SERVICE_LABEL.plist"
mkdir -p "$apps"
rm -rf "$app"
mv "$work/unpacked/$APP_NAME" "$app"
xattr -dr com.apple.quarantine "$app" >/dev/null 2>&1 || true
codesign --force --deep -s - "$app" || die "could not sign the app"
"$app/Contents/MacOS/galopin-tray" --install-agents || die "could not set up the LaunchAgents"
open "$app"

if [ "$upgrading" = 1 ]; then say "Cerea connector is updated."; else say "Cerea connector is installed."; fi
say "Look for its icon in the menu bar (top right), then choose \"Pair with Cerea...\"."
