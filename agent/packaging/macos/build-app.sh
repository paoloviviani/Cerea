#!/bin/sh
# Assemble "Cerea connector.app" for one architecture and zip it.
#
#   build-app.sh --arch arm64|amd64 --version V --tray BIN --cli BIN \
#                --node-dir DIR --icns FILE --out DIR
#
# --node-dir is an unpacked official Node tarball (bin/, lib/, ...). Inside the
# bundle: Contents/{Info.plist, MacOS/galopin-tray, Resources/{galopin, node/,
# icon.icns, THIRD_PARTY_LICENSES*}}. On a Mac it signs the bundle ad hoc (no
# Apple account: Apple Silicon needs a signature, not a notarized one). Writes
# OUT/Cerea-connector-macos-ARCH.zip and its .sha256.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
arch='' version='' tray='' cli='' node='' icns='' out=''
while [ $# -gt 0 ]; do
    case $1 in
    --arch) arch=$2 ;; --version) version=$2 ;; --tray) tray=$2 ;; --cli) cli=$2 ;;
    --node-dir) node=$2 ;; --icns) icns=$2 ;; --out) out=$2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
    esac
    shift 2
done
for v in arch version tray cli node icns out; do
    eval "val=\$$v"
    [ -n "$val" ] || { echo "missing --$v" >&2; exit 2; }
done
case $arch in arm64 | amd64) ;; *) echo "--arch must be arm64 or amd64" >&2; exit 2 ;; esac
[ -x "$node/bin/node" ] || { echo "$node/bin/node not found" >&2; exit 1; }

mkdir -p "$out"; out=$(cd "$out" && pwd)
app="$out/Cerea connector.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
sed "s/@VERSION@/$version/g" "$here/Info.plist" > "$app/Contents/Info.plist"
cp "$tray" "$app/Contents/MacOS/galopin-tray"
cp "$cli" "$app/Contents/Resources/galopin"
chmod 755 "$app/Contents/MacOS/galopin-tray" "$app/Contents/Resources/galopin"
cp "$icns" "$app/Contents/Resources/icon.icns"
cp -R "$node" "$app/Contents/Resources/node"
# Only what running Node and npm needs: no docs, headers or man pages.
rm -rf "$app/Contents/Resources/node/include" "$app/Contents/Resources/node/share"
cp "$here/../../THIRD_PARTY_LICENSES" "$app/Contents/Resources/THIRD_PARTY_LICENSES"
cp "$here/../../cmd/galopin-tray/THIRD_PARTY_LICENSES" "$app/Contents/Resources/THIRD_PARTY_LICENSES.tray"

if command -v codesign >/dev/null 2>&1; then
    codesign --force --deep -s - "$app"
fi

zip="$out/Cerea-connector-macos-$arch.zip"
rm -f "$zip"
# -y keeps symlinks (node/bin/npm is one); -X drops extra file attributes.
(cd "$out" && zip -qryX "$zip" "Cerea connector.app")
if command -v shasum >/dev/null 2>&1; then sum=$(shasum -a 256 "$zip"); else sum=$(sha256sum "$zip"); fi
echo "${sum%% *}  $(basename "$zip")" > "$zip.sha256"
echo "wrote $zip"
