#!/bin/bash
# Runs the generated install.sh in --upgrade mode against a temporary HOME with a fake
# enrollment, a fake `systemctl --user` and `systemd-run`, and downloads served from a local
# directory (a stub curl), then asserts what an upgrade promises: everything downloaded before the
# stop, the backup, the atomic swap with galopin.prev kept, settings untouched, the service
# restarted, the refusals, the detached run from inside galopin, and every way back after a
# failure. The shell under test is $UPGRADE_TEST_SH (default sh; the spec also runs busybox ash).
# Usage: upgrade_test.sh <install.sh> <pinned opencode version>
set -euo pipefail
script=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
ocver=$2
SH=${UPGRADE_TEST_SH:-sh}
t=$(mktemp -d); trap 'rm -rf "$t"; jobs -p | xargs -r kill 2>/dev/null || true' EXIT
fail() { echo "FAIL: $*" >&2; [ -f "$t/out" ] && { echo "--- output"; cat "$t/out"; }; exit 1; }
has() { grep -qF -- "$2" "$1" || fail "expected '$2' in $1"; }
hasnt() { if grep -qF -- "$2" "$1"; then fail "unexpected '$2' in $1"; fi; }

case "$(uname -m)" in x86_64 | amd64) arch=amd64 ;; *) arch=arm64 ;; esac
os=$(uname -s | tr '[:upper:]' '[:lower:]')
[ "$os" = linux ] || { echo "skipped: the systemd upgrade test runs on Linux"; exit 0; }
name=galopin-$os-$arch

export HOME=$t/home
unset XDG_CONFIG_HOME XDG_DATA_HOME GALOPIN_INSTALL_DIR GALOPIN_ENGINE GALOPIN_UPGRADE GALOPIN_CREDS GALOPIN_TERMINAL
export GALOPIN_CONTAINER_FILE=$t/not-a-container
export GALOPIN_CGROUP_FILE=$t/cgroup; echo "0::/user.slice/session-1.scope" > "$t/cgroup"
mkdir -p "$t/stubs" "$t/serve"
cfg=$HOME/.config/galopin
bin=$HOME/.local/bin

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
	is-enabled) [ -f "$ENABLED" ] ;;
	stop) echo "stop" >> "$CALLS"; rm -f "$UNIT"; if [ -n "${STOP_SIGNAL:-}" ]; then kill -"$STOP_SIGNAL" "$PPID"; fi ;;
	start) if [ -f "$START_FAILS" ]; then echo "start-failed" >> "$CALLS"; exit 1; fi; echo "start" >> "$CALLS"; : > "$UNIT" ;;
	*) echo "unexpected systemctl $*" >> "$CALLS"; exit 1 ;;
esac
S
# systemd-run --user --collect --unit U -E K=V ... -p StandardOutput=append:LOG ... cmd args: run it in the background
cat > "$t/stubs/systemd-run" <<'S'
#!/bin/sh
echo "systemd-run $*" >> "$CALLS"
envs=; log=/dev/null
while [ $# -gt 0 ]; do
	case "$1" in
		--user | --collect) shift ;;
		--unit) shift 2 ;;
		-E) envs="$envs $2"; shift 2 ;;
		-p) case "$2" in StandardOutput=append:*) log=${2#StandardOutput=append:} ;; esac; shift 2 ;;
		*) break ;;
	esac
done
# shellcheck disable=SC2086
(env -u GALOPIN_TERMINAL $envs "$@" >> "$log" 2>&1 </dev/null &)
S
# ps: GALOPIN_USE_PS forces it. -U is rejected, or a process list is printed, as the test says.
cat > "$t/stubs/ps" <<'S'
#!/bin/sh
for a in "$@"; do [ "$a" = -p ] && exec /bin/ps "$@"; done
for a in "$@"; do [ "$a" = -U ] && [ -n "${PS_REJECTS_U:-}" ] && { echo "ps: invalid option -- 'U'" >&2; exit 1; }; done
[ -n "${PS_OUTPUT:-}" ] && printf '%s\n' "$PS_OUTPUT"
exit 0
S
chmod +x "$t/stubs/"*
export SERVE=$t/serve UNIT=$t/unit-active ENABLED=$t/unit-enabled START_FAILS=$t/start-fails CALLS=$t/calls
export PATH=$t/stubs:$bin:$PATH

# galopin builds: the old one installed, the new one served (good, or broken).
cat > "$t/old-galopin" <<'S'
#!/bin/sh
case "$1" in version) echo 0.1.0 ;; browser) echo "old browser $*" >> "$CALLS" ;; esac
S
good_new() {
	cat > "$SERVE/$name" <<'S'
#!/bin/sh
case "$1" in version) echo 9.9.9 ;; browser) echo "new browser $*" >> "$CALLS" ;; esac
S
	(cd "$SERVE" && sha256sum "$name" > SHA256SUMS)
}
broken_new() {
	printf '#!/bin/sh\nexit 1\n' > "$SERVE/$name"
	(cd "$SERVE" && sha256sum "$name" > SHA256SUMS)
}
good_new

# A fresh machine: old galopin, enrollment, settings, opencode data, service running.
fresh() {
	rm -rf "$HOME" "$UNIT" "$ENABLED" "$START_FAILS" "$CALLS"
	mkdir -p "$bin" "$cfg/browser/runtime" "$cfg/opencode-tools" "$HOME/.opencode/bin" "$HOME/.local/share/opencode"
	cp "$t/old-galopin" "$bin/galopin"; chmod 755 "$bin/galopin"
	printf '{\n  "refresh_token": "SECRET-RT",\n  "cerea_origin": "https://cerea.example"\n}\n' > "$cfg/credentials.json"
	chmod 600 "$cfg/credentials.json"
	echo '{"keep":"me"}' > "$cfg/policy.json"
	echo '{}' > "$cfg/browser/browser.json"; echo big > "$cfg/browser/runtime/huge.bin"; echo big > "$cfg/opencode-tools/x"
	printf '#!/bin/sh\necho %s\n' "$ocver" > "$HOME/.opencode/bin/opencode"; chmod 755 "$HOME/.opencode/bin/opencode"
	echo db1 > "$HOME/.local/share/opencode/opencode.db"; echo wal1 > "$HOME/.local/share/opencode/opencode.db-wal"
	rm -rf "$t/cfg-before"; cp -R "$cfg" "$t/cfg-before"
	: > "$UNIT"; : > "$CALLS"
	good_new
}
# shellcheck disable=SC2086
run() { set +e; $SH "$script" "$@" > "$t/out" 2>&1; rc=$?; set -e; }
mkdir -p "$bin"; here=$(cd "$bin" && pwd -P)
settings_untouched() {
	cmp "$cfg/credentials.json" "$t/cfg-before/credentials.json" || fail "credentials were touched"
	cmp "$cfg/policy.json" "$t/cfg-before/policy.json" || fail "policy was touched"
}

# 1. No enrollment: refuse, change nothing.
fresh; rm -rf "$cfg"
run --upgrade
[ "$rc" -ne 0 ] || fail "an upgrade without an enrollment must refuse"
has "$t/out" "nothing to upgrade, run the normal install"
[ ! -e "$bin/galopin.prev" ] || fail "refusal must change nothing"
[ -f "$UNIT" ] || fail "refusal must not stop the service"
echo "ok 1: refuses without an enrollment"

# 2. The upgrade: stop, back up, install, refresh the browser, restart.
fresh
run --upgrade
[ "$rc" -eq 0 ] || fail "upgrade failed ($rc)"
[ "$("$bin/galopin" version)" = 9.9.9 ] || fail "the new galopin is not installed"
[ "$("$bin/galopin.prev" version)" = 0.1.0 ] || fail "galopin.prev is not the old binary"
ls "$bin" | grep -q '\.new\.' && fail "a temporary copy was left behind"
bk=$(ls -d "$cfg"/backups/pre-upgrade-*)
cmp "$bk/galopin/credentials.json" "$t/cfg-before/credentials.json" || fail "credentials not backed up"
cmp "$bk/galopin/policy.json" "$t/cfg-before/policy.json" || fail "policy not backed up"
[ "$("$bk/galopin.old" version)" = 0.1.0 ] || fail "the old binary is not in the backup"
[ "$(cat "$bk/opencode/opencode.db")" = db1 ] && [ "$(cat "$bk/opencode/opencode.db-wal")" = wal1 ] || fail "opencode db not backed up"
[ ! -e "$bk/galopin/browser" ] || fail "the browser directory must not be in the backup"
[ ! -e "$bk/galopin/opencode-tools" ] || fail "opencode-tools must not be in the backup"
[ "$(stat -c %a "$bk")" = 700 ] || fail "the backup must be private"
settings_untouched
[ "$(cat "$HOME/.local/share/opencode/opencode.db")" = db1 ] || fail "opencode db was touched"
[ "$(sed -n '1p;$p' "$CALLS" | tr '\n' ' ')" = "stop start " ] || fail "expected stop then start, got: $(tr '\n' ' ' < "$CALLS")"
has "$CALLS" "new browser browser setup --creds $cfg/credentials.json"
[ -f "$UNIT" ] || fail "the service was not restarted"
[ ! -e "$bk/was-running" ] || fail "the was-running marker must go after a success"
has "$t/out" "0.1.0 -> 9.9.9"
has "$t/out" "Enrollment and settings kept; backup in $bk"
hasnt "$t/out" SECRET-RT
echo "ok 2: upgrade backs up, installs, keeps galopin.prev, restarts"

# 3. Idempotent: again is fine, with a second backup, and galopin.prev stays the old binary.
run --upgrade
[ "$rc" -eq 0 ] || fail "second upgrade failed ($rc)"
[ "$(ls -d "$cfg"/backups/pre-upgrade-* | wc -l)" -eq 2 ] || fail "expected a second backup"
[ "$("$bin/galopin.prev" version)" = 0.1.0 ] || fail "a rerun must not overwrite galopin.prev with the incoming binary"
for _ in 1 2 3; do run --upgrade; sleep 1; done
[ "$(ls -d "$cfg"/backups/pre-upgrade-* | wc -l)" -le 3 ] || fail "only the last 3 backups are kept"
echo "ok 3: idempotent, prev kept, 3 backups kept"

# 4. A bad checksum: found before anything is stopped.
fresh
(cd "$SERVE" && echo "0000000000000000000000000000000000000000000000000000000000000000  $name" > SHA256SUMS)
run --upgrade
[ "$rc" -ne 0 ] || fail "a checksum mismatch must fail"
has "$t/out" "checksum mismatch"
[ ! -s "$CALLS" ] || fail "nothing may be stopped before the downloads are verified: $(cat "$CALLS")"
[ "$("$bin/galopin" version)" = 0.1.0 ] || fail "the old galopin must be untouched"
[ -f "$UNIT" ] || fail "the service must still run"
[ ! -d "$cfg/backups" ] || fail "no backup before the stop"
echo "ok 4: bad checksum changes nothing"

# 5. An outdated opencode that cannot be downloaded: also before the stop.
fresh
printf '#!/bin/sh\necho 0.0.1\n' > "$HOME/.opencode/bin/opencode"
run --upgrade
[ "$rc" -ne 0 ] || fail "an opencode download failure must fail"
has "$t/out" "could not download opencode"
[ ! -s "$CALLS" ] || fail "the engine is downloaded before the stop"
[ -f "$UNIT" ] || fail "the service must still run"
echo "ok 5: engine download failure changes nothing"

# 5b. A newer opencode than the pin is not downgraded.
fresh
printf '#!/bin/sh\necho 99.0.0\n' > "$HOME/.opencode/bin/opencode"
run --upgrade
[ "$rc" -eq 0 ] || fail "upgrade with a newer opencode failed ($rc)"
has "$t/out" "is newer than the $ocver this Cerea pins"
[ "$("$HOME/.opencode/bin/opencode" --version)" = 99.0.0 ] || fail "opencode was downgraded"
echo "ok 5b: no opencode downgrade"

# 6. A new galopin that does not run: the old one is put back at once, and the service restarted.
fresh; broken_new
run --upgrade
[ "$rc" -ne 0 ] || fail "a broken new galopin must fail the upgrade"
has "$t/out" "the previous one is back in place"
[ "$("$bin/galopin" version)" = 0.1.0 ] || fail "the old galopin must be back"
[ -f "$UNIT" ] || fail "the old service must be started again"
has "$t/out" "Started the old galopin again"
settings_untouched
echo "ok 6: a broken new binary rolls back automatically"

# 7. A rerun after a failure that left the service stopped: the marker in the last backup starts it.
fresh; broken_new; : > "$START_FAILS"
run --upgrade
[ "$rc" -ne 0 ] || fail "must fail"
[ ! -f "$UNIT" ] || fail "the unit should be stopped (its start failed)"
has "$t/out" "Start it again: systemctl --user start galopin"
good_new; rm -f "$START_FAILS"
sleep 1
run --upgrade
[ "$rc" -eq 0 ] || fail "the rerun failed ($rc)"
[ -f "$UNIT" ] || fail "the rerun must start the unit the failed run stopped"
[ "$("$bin/galopin" version)" = 9.9.9 ] || fail "the rerun must install the new galopin"
echo "ok 7: rerun after a failure starts the unit"

# 7b. A unit that is enabled but stopped is started at the end.
fresh; rm -f "$UNIT"; : > "$ENABLED"
run --upgrade
[ "$rc" -eq 0 ] || fail "failed ($rc)"
[ -f "$UNIT" ] || fail "an enabled unit must be started"
echo "ok 7b: enabled unit started"

# 8. HUP and INT after the stop: the old galopin is started again.
for sig in HUP INT; do
	fresh
	export STOP_SIGNAL=$sig
	run --upgrade
	unset STOP_SIGNAL
	[ "$rc" -ne 0 ] || fail "$sig must end the upgrade"
	[ -f "$UNIT" ] || fail "after $sig the unit must be started again"
	[ "$("$bin/galopin" version)" = 0.1.0 ] || fail "after $sig the old galopin must be in place"
	has "$CALLS" "start"
done
echo "ok 8: HUP and INT restart the unit"

# 9. A foreground galopin run, listed by the GALOPIN_PS hook: refused without --stop, stopped
# with it, and refused for a process that is not $dir/galopin.
fresh; rm -f "$UNIT"
sleep 60 & fg=$!
export GALOPIN_PS="echo $fg $here/galopin $here/galopin run; echo 1 /bin/sh sh -c nothing"
run --upgrade
[ "$rc" -ne 0 ] || fail "a running galopin run must be refused without --stop"
has "$t/out" "galopin run is running here"
kill -0 "$fg" 2>/dev/null || fail "it must not have been stopped"
export GALOPIN_PS="echo $fg /opt/other/galopin galopin run"
run --upgrade --stop
[ "$rc" -ne 0 ] || fail "--stop must refuse another galopin"
has "$t/out" "but not as $here/galopin"
kill -0 "$fg" 2>/dev/null || fail "another galopin must not be stopped"
export GALOPIN_PS="echo $fg $here/galopin $here/galopin run"
run --upgrade --stop
[ "$rc" -eq 0 ] || fail "upgrade --stop failed ($rc)"
st=$(ps -o stat= -p "$fg" 2>/dev/null || true)
case "$st" in "" | Z*) ;; *) fail "galopin run was not stopped" ;; esac
has "$t/out" "Start galopin again: galopin run"
wait "$fg" 2>/dev/null || true
unset GALOPIN_PS
echo "ok 9: foreground galopin run needs --stop, and only its own binary"

# 10. A process list that cannot be had: refuse. A ps that rejects -U, and one that lists it.
fresh; rm -f "$UNIT"
export GALOPIN_PS='exit 1'
run --upgrade
[ "$rc" -ne 0 ] || fail "an unlisted process table must refuse"
has "$t/out" "could not list processes; stop galopin first"
unset GALOPIN_PS
export GALOPIN_USE_PS=1 PS_REJECTS_U=1
run --upgrade
[ "$rc" -ne 0 ] || fail "a ps that rejects -U must refuse"
has "$t/out" "could not list processes; stop galopin first"
unset PS_REJECTS_U
# (busybox ash runs its own ps applet, so a stub on PATH is not seen there)
if [ "${SH%% *}" != busybox ]; then
	sleep 60 & fg=$!
	export PS_OUTPUT="$fg $here/galopin $here/galopin run"
	run --upgrade
	[ "$rc" -ne 0 ] || fail "a galopin run listed by ps must be refused without --stop"
	run --upgrade --stop
	[ "$rc" -eq 0 ] || fail "--stop with a stubbed ps failed ($rc)"
	wait "$fg" 2>/dev/null || true
fi
unset GALOPIN_USE_PS PS_OUTPUT
echo "ok 10: ps trouble refuses; a stubbed ps is read"

# 11. From inside galopin (Cerea's terminal, or the unit's cgroup): the upgrade re-runs detached.
for how in terminal cgroup; do
	fresh
	if [ "$how" = terminal ]; then export GALOPIN_TERMINAL=1; else echo "0::/user.slice/app.slice/galopin.service" > "$GALOPIN_CGROUP_FILE"; fi
	run --upgrade
	unset GALOPIN_TERMINAL; echo "0::/user.slice/session-1.scope" > "$GALOPIN_CGROUP_FILE"
	[ "$rc" -eq 0 ] || fail "the detaching run failed ($rc)"
	has "$t/out" "Upgrade continues in the background; this terminal will close when galopin restarts; log: "
	has "$CALLS" "systemd-run --user --collect --unit galopin-upgrade-"
	log=$(ls "$cfg"/backups/upgrade-*.log)
	[ -f "$(ls "$cfg"/backups/upgrade-*.sh)" ] || fail "the installer was not saved for the detached run"
	for _ in $(seq 1 60); do grep -q "Enrollment and settings kept" "$log" 2>/dev/null && break; sleep 0.5; done
	has "$log" "Enrollment and settings kept"
	[ "$("$bin/galopin" version)" = 9.9.9 ] || fail "the detached upgrade did not install ($how)"
	[ -f "$UNIT" ] || fail "the detached upgrade did not restart the unit ($how)"
done
echo "ok 11: inside galopin the upgrade continues detached"

# 11b. A foreground galopin run in its own terminal cannot stop itself: refuse.
fresh; rm -f "$UNIT"
sleep 60 & fg=$!
export GALOPIN_TERMINAL=1 GALOPIN_PS="echo $fg $here/galopin $here/galopin run"
run --upgrade --stop
unset GALOPIN_TERMINAL GALOPIN_PS
[ "$rc" -ne 0 ] || fail "--stop from galopin's own terminal must refuse"
has "$t/out" "this terminal is inside galopin"
kill -0 "$fg" 2>/dev/null || fail "it must not have been stopped"
kill "$fg"; wait "$fg" 2>/dev/null || true
echo "ok 11b: --stop from galopin's own terminal is refused"

# 12. Docker: advice only.
fresh
: > "$t/container"
GALOPIN_CONTAINER_FILE=$t/container run --upgrade
[ "$rc" -eq 0 ] || fail "container advice exits 0"
has "$t/out" "docker pull"
[ ! -e "$bin/galopin.prev" ] || fail "the container path must change nothing"
echo "ok 12: container advice"

# 13. A truncated installer does nothing (everything is inside main).
head -c 400 "$script" > "$t/cut.sh"
fresh
set +e; $SH "$t/cut.sh" --upgrade > "$t/out" 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] || fail "a truncated installer must not succeed"
[ -f "$UNIT" ] && [ "$("$bin/galopin" version)" = 0.1.0 ] || fail "a truncated installer must change nothing"
echo "ok 13: truncated installer is inert"
echo "all upgrade tests passed"
