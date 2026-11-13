#!/bin/bash
# Tests build-app.sh and install.sh on any machine, in a temporary HOME, with
# codesign, launchctl, open, xattr and pkill stubbed. Run: sh install_test.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
has() { grep -qF -- "$2" "$1" || { echo "--- $1"; cat "$1"; fail "expected '$2' in $1"; }; }

# A fake tray that does what the real one does for --install-agents.
mkdir -p "$t/in/node/bin" "$t/stubs" "$t/home"
cat > "$t/in/tray" <<'T'
#!/bin/sh
[ "$1" = "--install-agents" ] || exit 0
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Application Support/galopin"
: > "$HOME/Library/LaunchAgents/org.cerea.connector.plist"
: > "$HOME/Library/Application Support/galopin/org.cerea.galopin.plist"
T
printf '#!/bin/sh\necho galopin\n' > "$t/in/cli"
printf '#!/bin/sh\necho v22\n' > "$t/in/node/bin/node"; ln -s node "$t/in/node/bin/nodelink"
chmod +x "$t/in/tray" "$t/in/cli" "$t/in/node/bin/node"
: > "$t/in/icon.icns"
for s in codesign launchctl open xattr pkill; do
    printf '#!/bin/sh\necho "%s $*" >> "%s/calls"\n' "$s" "$t" > "$t/stubs/$s"
    chmod +x "$t/stubs/$s"
done

# This box may have no zip/unzip: stand-ins (python zipfile, symlinks kept) for the few options used.
if ! command -v zip >/dev/null || ! command -v unzip >/dev/null; then
    cat > "$t/stubs/zip" <<'Z'
#!/usr/bin/env python3
import os, stat, sys, zipfile
zp, top = sys.argv[2], sys.argv[3]
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
    for d, dirs, files in os.walk(top):
        for n in dirs + files:
            p = os.path.join(d, n)
            st = os.lstat(p)
            if os.path.isdir(p) and not os.path.islink(p):
                continue
            i = zipfile.ZipInfo(p)
            i.external_attr = (st.st_mode & 0xFFFF) << 16
            z.writestr(i, os.readlink(p) if os.path.islink(p) else open(p, "rb").read())
Z
    cat > "$t/stubs/unzip" <<'Z'
#!/usr/bin/env python3
import os, stat, sys, zipfile
a = sys.argv[1:]
if a[0] == "-l":
    for n in zipfile.ZipFile(a[1]).namelist(): print(n)
    sys.exit(0)
zp, dest = a[1], a[3]
with zipfile.ZipFile(zp) as z:
    for i in z.infolist():
        p = os.path.join(dest, i.filename); mode = i.external_attr >> 16
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if stat.S_ISLNK(mode): os.symlink(z.read(i).decode(), p)
        else:
            open(p, "wb").write(z.read(i)); os.chmod(p, mode & 0o777 or 0o644)
Z
    chmod +x "$t/stubs/zip" "$t/stubs/unzip"
fi
export PATH="$t/stubs:$PATH"

# build-app.sh
sh "$here/build-app.sh" --arch amd64 --version 9.9.9 --tray "$t/in/tray" --cli "$t/in/cli" \
    --node-dir "$t/in/node" --icns "$t/in/icon.icns" --out "$t/out" >/dev/null
zip="$t/out/Cerea-connector-macos-amd64.zip"
[ -f "$zip" ] && [ -f "$zip.sha256" ] || fail "no zip or checksum"
unzip -l "$zip" > "$t/list"
for f in "Contents/Info.plist" "Contents/MacOS/galopin-tray" "Contents/Resources/galopin" \
    "Contents/Resources/node/bin/node" "Contents/Resources/icon.icns" "Contents/Resources/THIRD_PARTY_LICENSES"; do
    has "$t/list" "Cerea connector.app/$f"
done
has "$t/out/Cerea connector.app/Contents/Info.plist" "<key>LSUIElement</key><true/>"
has "$t/out/Cerea connector.app/Contents/Info.plist" "9.9.9"
mkdir "$t/unz"; unzip -q "$zip" -d "$t/unz"
[ -L "$t/unz/Cerea connector.app/Contents/Resources/node/bin/nodelink" ] || fail "symlink not kept in the zip"

run() { HOME="$t/home" PATH="$t/stubs:$PATH" CEREA_ALLOW_NON_MAC=1 sh "$here/install.sh" "$@"; }
app="$t/home/Applications/Cerea connector.app"

# install from a local zip (checksum from ZIP.sha256)
: > "$t/calls"
run "$zip" > "$t/o1"
[ -x "$app/Contents/MacOS/galopin-tray" ] || fail "app not installed"
has "$t/calls" "codesign --force --deep -s - $app"
has "$t/calls" "open $app"
has "$t/calls" "launchctl bootout gui/$(id -u)/org.cerea.galopin"
[ -f "$t/home/Library/LaunchAgents/org.cerea.connector.plist" ] || fail "login item not installed"
has "$t/o1" "is installed"

# upgrade in place (and a leftover manual-install LaunchAgent goes)
: > "$t/home/Library/LaunchAgents/org.cerea.galopin.plist"
echo stale > "$app/stale-file"
run "$zip" > "$t/o2"
has "$t/o2" "is updated"
[ ! -e "$app/stale-file" ] || fail "upgrade kept stale files"
[ ! -e "$t/home/Library/LaunchAgents/org.cerea.galopin.plist" ] || fail "legacy plist kept"

# a wrong checksum installs nothing
rm -rf "$t/home/Applications"
if run "$zip" --sha256 0000 > "$t/o3" 2>&1; then fail "bad checksum accepted"; fi
has "$t/o3" "checksum mismatch"
[ ! -e "$app" ] || fail "installed despite bad checksum"

# a zip without a checksum is installed with a note
cp "$zip" "$t/bare.zip"
run "$t/bare.zip" > "$t/o4"
has "$t/o4" "not verified"
[ -d "$app" ] || fail "bare zip not installed"

# uninstall keeps the pairing, --purge removes it
mkdir -p "$t/home/Library/Application Support/galopin"; echo x > "$t/home/Library/Application Support/galopin/credentials.json"
: > "$t/calls"
run --uninstall > "$t/o5"
[ ! -e "$app" ] || fail "app kept"
[ ! -e "$t/home/Library/LaunchAgents/org.cerea.connector.plist" ] || fail "login item kept"
[ -f "$t/home/Library/Application Support/galopin/credentials.json" ] || fail "pairing removed without --purge"
has "$t/calls" "-x galopin-tray"
run --uninstall --purge > "$t/o6"
[ ! -e "$t/home/Library/Application Support/galopin" ] || fail "--purge kept the pairing"

# refuses a non-Mac without the test switch
if HOME="$t/home" sh "$here/install.sh" --uninstall >/dev/null 2>&1 && [ "$(uname -s)" != Darwin ]; then fail "ran on a non-Mac"; fi
echo "install_test: ok"
