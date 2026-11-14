#!/bin/bash
# Runs the generated install.sh in --upgrade mode against a temporary HOME with a
# fake enrollment, a fake `systemctl --user`, and downloads served from a local
# directory (a stub curl), then asserts what an upgrade promises: the backup, the
# new binary with galopin.prev kept, settings untouched, the service restarted, and
# the refusals and rollback hints. Usage: upgrade_test.sh <install.sh> <pinned opencode version>
set -euo pipefail
script=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
ocver=$2
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*" >&2; [ -f "$t/out" ] && { echo "--- output"; cat "$t/out"; }; exit 1; }
has() { grep -qF -- "$2" "$1" || fail "expected '$2' in $1"; }
hasnt() { if grep -qF -- "$2" "$1"; then fail "unexpected '$2' in $1"; fi; }

case "$(uname -m)" in x86_64 | amd64) arch=amd64 ;; *) arch=arm64 ;; esac
os=$(uname -s | tr '[:upper:]' '[:lower:]')
[ "$os" = linux ] || { echo "skipped: the systemd upgrade test runs on Linux"; exit 0; }
name=galopin-$os-$arch

export HOME=$t/home
unset XDG_CONFIG_HOME XDG_DATA_HOME GALOPIN_INSTALL_DIR GALOPIN_ENGINE GALOPIN_UPGRADE GALOPIN_CREDS
export GALOPIN_CONTAINER_FILE=$t/not-a-container
mkdir -p "$t/stubs" "$t/serve"
cfg=$HOME/.config/galopin

cat > "$t/stubs/curl" <<'S'
#!/bin/sh
out=
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
f="$SERVE/$(basename "$url")"
[ -f "$f" ] || exit 22
cp "$f" "$out"
S
cat > "$t/stubs/systemctl" <<'S'
#!/bin/sh
# systemctl --user <verb> ...
shift
case "$1" in
	is-active) [ -f "$UNIT" ] ;;
	stop) echo "stop" >> "$CALLS"; rm -f "$UNIT" ;;
	start) echo "start" >> "$CALLS"; : > "$UNIT" ;;
	*) echo "unexpected systemctl $*" >> "$CALLS"; exit 1 ;;
esac
S
chmod +x "$t/stubs/curl" "$t/stubs/systemctl"
export SERVE=$t/serve UNIT=$t/unit-active CALLS=$t/calls
export PATH=$t/stubs:$HOME/.local/bin:$PATH

# galopin builds: the old one installed, the new one served.
cat > "$t/old-galopin" <<'S'
#!/bin/sh
case "$1" in version) echo 0.1.0 ;; browser) echo "old browser $*" >> "$CALLS" ;; esac
S
cat > "$SERVE/$name" <<'S'
#!/bin/sh
case "$1" in version) echo 9.9.9 ;; browser) echo "new browser $*" >> "$CALLS" ;; esac
S
(cd "$SERVE" && sha256sum "$name" > SHA256SUMS)

# A fresh machine: old galopin, enrollment, settings, opencode data, service running.
fresh() {
	rm -rf "$HOME" "$UNIT" "$CALLS"
	mkdir -p "$HOME/.local/bin" "$cfg/browser/runtime" "$HOME/.opencode/bin" "$HOME/.local/share/opencode"
	cp "$t/old-galopin" "$HOME/.local/bin/galopin"; chmod 755 "$HOME/.local/bin/galopin"
	printf '{\n  "refresh_token": "SECRET-RT",\n  "cerea_origin": "https://cerea.example"\n}\n' > "$cfg/credentials.json"
	chmod 600 "$cfg/credentials.json"
	echo '{"keep":"me"}' > "$cfg/policy.json"
	echo '{}' > "$cfg/browser/browser.json"; echo big > "$cfg/browser/runtime/huge.bin"
	printf '#!/bin/sh\necho %s\n' "$ocver" > "$HOME/.opencode/bin/opencode"; chmod 755 "$HOME/.opencode/bin/opencode"
	echo db1 > "$HOME/.local/share/opencode/opencode.db"; echo wal1 > "$HOME/.local/share/opencode/opencode.db-wal"
	cp -R "$cfg" "$t/cfg-before"
	: > "$UNIT"; : > "$CALLS"
}
run() { set +e; sh "$script" "$@" > "$t/out" 2>&1; rc=$?; set -e; }
rm_before() { rm -rf "$t/cfg-before"; }

# 1. No enrollment: refuse, change nothing.
fresh; rm -rf "$cfg"
run --upgrade
[ "$rc" -ne 0 ] || fail "an upgrade without an enrollment must refuse"
has "$t/out" "nothing to upgrade, run the normal install"
[ ! -e "$HOME/.local/bin/galopin.prev" ] || fail "refusal must change nothing"
[ -f "$UNIT" ] || fail "refusal must not stop the service"
echo "ok 1: refuses without an enrollment"

# 2. The upgrade: stop, back up, install, refresh the browser, restart.
fresh
run --upgrade
[ "$rc" -eq 0 ] || fail "upgrade failed ($rc)"
[ "$("$HOME/.local/bin/galopin" version)" = 9.9.9 ] || fail "the new galopin is not installed"
[ "$("$HOME/.local/bin/galopin.prev" version)" = 0.1.0 ] || fail "galopin.prev is not the old binary"
bk=$(ls -d "$cfg"/backups/pre-upgrade-*)
cmp "$bk/galopin/credentials.json" "$t/cfg-before/credentials.json" || fail "credentials not backed up"
cmp "$bk/galopin/policy.json" "$t/cfg-before/policy.json" || fail "policy not backed up"
[ "$(cat "$bk/opencode/opencode.db")" = db1 ] && [ "$(cat "$bk/opencode/opencode.db-wal")" = wal1 ] || fail "opencode db not backed up"
[ ! -e "$bk/galopin/browser" ] || fail "the browser directory must not be in the backup"
[ "$(stat -c %a "$bk")" = 700 ] || fail "the backup must be private"
cmp "$cfg/credentials.json" "$t/cfg-before/credentials.json" || fail "credentials were touched"
cmp "$cfg/policy.json" "$t/cfg-before/policy.json" || fail "policy was touched"
[ "$(cat "$HOME/.local/share/opencode/opencode.db")" = db1 ] || fail "opencode db was touched"
[ "$(sed -n '1p;$p' "$CALLS" | tr '\n' ' ')" = "stop start " ] || fail "expected stop then start, got: $(tr '\n' ' ' < "$CALLS")"
has "$CALLS" "new browser browser setup --creds $cfg/credentials.json"
[ -f "$UNIT" ] || fail "the service was not restarted"
has "$t/out" "0.1.0 -> 9.9.9"
has "$t/out" "Enrollment and settings kept; backup in $bk"
hasnt "$t/out" SECRET-RT
echo "ok 2: upgrade backs up, installs, keeps galopin.prev, restarts"

# 3. Idempotent: again is fine, with a second backup.
run --upgrade
[ "$rc" -eq 0 ] || fail "second upgrade failed ($rc)"
[ "$(ls -d "$cfg"/backups/pre-upgrade-* | wc -l)" -eq 2 ] || fail "expected a second backup"
echo "ok 3: idempotent"

# 4. A bad checksum after the stop: the old galopin is still in place and is started again.
fresh
(cd "$SERVE" && echo "0000000000000000000000000000000000000000000000000000000000000000  $name" > SHA256SUMS)
run --upgrade
[ "$rc" -ne 0 ] || fail "a checksum mismatch must fail"
has "$t/out" "checksum mismatch"
has "$t/out" "The old galopin is still in place"
[ "$("$HOME/.local/bin/galopin" version)" = 0.1.0 ] || fail "the old galopin must be untouched"
[ -f "$UNIT" ] || fail "the old service must be started again"
(cd "$SERVE" && sha256sum "$name" > SHA256SUMS)
echo "ok 4: failure before the swap restarts the old galopin"

# 5. A failure after the swap (an outdated opencode that cannot be downloaded): rollback
# steps are printed and the service is not started.
fresh
printf '#!/bin/sh\necho 0.0.1\n' > "$HOME/.opencode/bin/opencode"
run --upgrade
[ "$rc" -ne 0 ] || fail "an opencode download failure must fail"
has "$t/out" "could not download opencode"
has "$t/out" "To roll back"
has "$t/out" "galopin.prev"
has "$t/out" "opencode.db-wal"
has "$t/out" "systemctl --user start galopin     # only after the steps above"
[ ! -f "$UNIT" ] || fail "the service must not be restarted with a half upgrade"
[ -f "$HOME/.local/bin/galopin.prev" ] || fail "galopin.prev must exist for the rollback"
echo "ok 5: failure after the swap prints the rollback"

# 6. A foreground galopin run: refused without --stop, stopped with it.
fresh; rm -f "$UNIT"
bash -c 'exec -a "galopin run" sleep 60' &
fg=$!
sleep 1
run --upgrade
[ "$rc" -ne 0 ] || fail "a running galopin run must be refused without --stop"
has "$t/out" "galopin run is running here"
kill -0 "$fg" 2>/dev/null || fail "it must not have been stopped"
run --upgrade --stop
[ "$rc" -eq 0 ] || fail "upgrade --stop failed ($rc)"
st=$(ps -o stat= -p "$fg" 2>/dev/null || true)
case "$st" in "" | Z*) ;; *) fail "galopin run was not stopped" ;; esac
has "$t/out" "Start galopin again: galopin run"
wait "$fg" 2>/dev/null || true
echo "ok 6: foreground galopin run needs --stop"

# 7. Docker: advice only.
fresh
: > "$t/container"
GALOPIN_CONTAINER_FILE=$t/container run --upgrade
[ "$rc" -eq 0 ] || fail "container advice exits 0"
has "$t/out" "docker pull"
[ ! -e "$HOME/.local/bin/galopin.prev" ] || fail "the container path must change nothing"
echo "ok 7: container advice"
echo "all upgrade tests passed"
