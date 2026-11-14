# The `--upgrade` half of install.sh (POSIX sh: dash, bash and busybox ash), spliced in
# by renderInstallScript (galopinDist.ts) inside main(), after the installer's helper
# functions. It only defines functions; galopinInstall.sh calls them in this order:
#
#   upgrade_precheck    enrollment present? engine? where is galopin? what is running?
#                       (refuses, gives advice, or re-runs itself detached)
#   upgrade_engines     which of opencode / goose to install
#   (downloads and checksum checks, all before anything is stopped)
#   upgrade_stop        systemd user unit / the user's own foreground `galopin run`
#   upgrade_backup      galopin's state, the old binary, opencode's database
#   (atomic install of galopin; upgrade_check_new puts the old one back when it does not run)
#   (atomic install of opencode / goose)
#   upgrade_finish      browser runtime, a health check, start, summary
#
# `upgrade_on_exit` is the EXIT trap: after the stop, a failure or a signal restarts the old
# galopin when nothing was replaced yet, and otherwise prints how to roll back.
# Placeholders in @...@ are filled in by the renderer.
#
# shellcheck shell=sh disable=SC2034,SC2154

say() { printf '%s\n' "$*"; }

stopped=
unit_was_running=
start_unit=
fg_stopped=
fgmine=
fgother=
replaced=
prev_made=
oc_replaced=
upgraded=
backup=
state=
oldver=
newver=
ocdata=
oc_pinned=@OPENCODE_VERSION@
goose_pinned=@GOOSE_VERSION@

unit_active() { systemctl --user is-active --quiet galopin.service >/dev/null 2>&1; }
unit_enabled() { systemctl --user is-enabled --quiet galopin.service >/dev/null 2>&1; }

# True when $1 (a version) is newer than $2; an unreadable $2 counts as older.
upgrade_newer() {
	awk -v a="$1" -v b="$2" 'BEGIN {
		split(a, x, /[.-]/); split(b, y, /[.-]/)
		for (i = 1; i <= 3; i++) if (x[i] + 0 != y[i] + 0) exit !(x[i] + 0 > y[i] + 0)
		exit 1
	}'
}

# One line per process of this user: "<pid> <executable> <argv0> <argv1> ...". The executable
# is "-" when it cannot be known. GALOPIN_PS replaces the lister (tests); GALOPIN_USE_PS=1
# forces ps even where /proc is there (tests). On Linux /proc is read directly: busybox ps
# and procps do not agree on flags.
upgrade_proc_list() {
	if [ -n "${GALOPIN_PS:-}" ]; then
		sh -c "$GALOPIN_PS"
		return
	fi
	if [ "$os" = linux ] && [ -d /proc/self ] && [ -z "${GALOPIN_USE_PS:-}" ]; then
		me=$(id -u)
		for d in /proc/[0-9]*; do
			[ -r "$d/cmdline" ] || continue
			uid=$(ls -dn "$d" 2>/dev/null | awk '{ print $3 }')
			[ "$uid" = "$me" ] || continue
			exe=$(readlink "$d/exe" 2>/dev/null || true)
			exe=${exe% (deleted)}
			args=$({ tr '\0' ' ' <"$d/cmdline"; } 2>/dev/null || true)
			[ -n "$args" ] || continue
			printf '%s %s %s\n' "${d#/proc/}" "${exe:--}" "$args"
		done
		return 0
	fi
	# BSD and macOS: -x includes processes without a terminal; comm is the executable's path.
	ps -x -U "$(id -un)" -o pid= -o comm= -o args=
}

# "<pid> mine" for this user's `galopin run` that is $dir/galopin, "<pid> other" for any other.
upgrade_fg_scan() {
	here=$(cd "$dir" 2>/dev/null && pwd -P) || here=$dir
	list=$(upgrade_proc_list) || return 1
	printf '%s\n' "$list" | awk -v want="$here/galopin" '
		NF >= 4 {
			n = split($3, p, "/")
			if (p[n] == "galopin" && $4 == "run") print $1, ($2 == want ? "mine" : "other")
		}'
}

# A value of the credentials file, by key; never printed, only compared.
upgrade_cred() {
	sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$creds" | head -n 1
}

# GALOPIN_CONTAINER_FILE replaces the markers Docker and Podman leave (tests only).
upgrade_in_container() {
	if [ -n "${GALOPIN_CONTAINER_FILE:-}" ]; then [ -f "$GALOPIN_CONTAINER_FILE" ]; else [ -f /.dockerenv ] || [ -f /run/.containerenv ]; fi
}

# This shell runs inside galopin: Cerea's terminal (GALOPIN_TERMINAL) or the galopin.service cgroup.
upgrade_inside_galopin() {
	if [ -n "${GALOPIN_TERMINAL:-}" ]; then return 0; fi
	grep -q '/galopin\.service' "${GALOPIN_CGROUP_FILE:-/proc/self/cgroup}" 2>/dev/null
}

# Running and not a zombie (a stopped child nobody has waited for yet).
upgrade_alive() {
	kill -0 "$1" 2>/dev/null || return 1
	if [ -r "/proc/$1/stat" ]; then
		st=$(sed 's/^[^)]*) //' "/proc/$1/stat" 2>/dev/null | cut -c1)
	else
		st=$(ps -o stat= -p "$1" 2>/dev/null || true)
	fi
	case "$st" in Z*) return 1 ;; esac
	return 0
}

# Stopping galopin would kill this very shell (the unit's own terminal): run the upgrade as a
# transient systemd user unit of its own, which outlives galopin's restart.
upgrade_detach() {
	command -v systemd-run >/dev/null 2>&1 || fail "this shell runs inside galopin, which the upgrade stops; systemd-run is not available to carry on without it. Run the upgrade from a terminal outside galopin (ssh or a local terminal)"
	ts=$(date +%Y%m%d-%H%M%S)
	(umask 077 && mkdir -p "$state/backups") || fail "could not create $state/backups"
	saved="$state/backups/upgrade-$ts.sh"
	log="$state/backups/upgrade-$ts.log"
	# The script may have come from a pipe: keep a file of it for the detached run.
	if [ -f "$0" ] && grep -q '^# galopin, the Cerea machine agent: installer served by' "$0" 2>/dev/null; then
		cp "$0" "$saved" || fail "could not save the installer to $saved"
	else
		fetch "$origin/galopin/install.sh" "$saved" || fail "could not save the installer to $saved"
	fi
	set -- systemd-run --user --collect --unit "galopin-upgrade-$ts" -E GALOPIN_UPGRADE_DETACHED=1 -E "PATH=$PATH" -E "GALOPIN_INSTALL_DIR=$dir" -p "StandardOutput=append:$log" -p "StandardError=append:$log" sh "$saved" --upgrade --creds "$creds"
	if [ -n "$engine_set" ]; then set -- "$@" --engine "$engine"; fi
	if [ -n "$withopencode" ]; then set -- "$@" --with-opencode; fi
	"$@" </dev/null >/dev/null 2>&1 || fail "could not start the detached upgrade with systemd-run"
	say "Upgrade continues in the background; this terminal will close when galopin restarts; log: $log"
	exit 0
}

upgrade_precheck() {
	if [ -z "$creds" ]; then
		if [ "$os" = darwin ]; then
			cdir="$HOME/Library/Application Support"
		else
			cdir="${XDG_CONFIG_HOME:-$HOME/.config}"
		fi
		creds="$cdir/galopin/credentials.json"
	fi
	[ -f "$creds" ] || fail "nothing to upgrade, run the normal install (no enrollment found at $creds)"
	state=$(dirname "$creds")

	if [ -z "$engine_set" ]; then
		case "$(upgrade_cred engine)" in goose) engine=goose ;; *) engine=opencode ;; esac
	fi
	if [ "$(upgrade_cred mode)" = connectors ]; then engine=none; fi

	# Where galopin is managed by something else, say what to do there and change nothing.
	if upgrade_in_container; then
		say "This is a Docker container: do not upgrade galopin inside it."
		say "Pull the new image and recreate the container (its pairing lives in the volume you mounted, if any):"
		say ""
		say "  docker pull @DOCKER_IMAGE@"
		say "  docker stop <container> && docker rm <container>"
		say "  # then run the same docker command from the Pair a computer dialog again"
		exit 0
	fi
	if [ "$os" = darwin ]; then
		for label in org.cerea.galopin org.cerea.connector; do
			if [ -e "$HOME/Library/LaunchAgents/$label.plist" ] || launchctl list "$label" >/dev/null 2>&1; then
				say "galopin runs under launchd here ($label)."
				say "If the Cerea connector app installed it, upgrade through the app: install the new connector from this deployment's release page and open it."
				say "If you set the launch agent up yourself: launchctl bootout gui/$(id -u)/org.cerea.galopin, run this again, then launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.cerea.galopin.plist."
				exit 0
			fi
		done
	fi

	# What runs galopin: the systemd user unit, or a foreground `galopin run`.
	if [ "$os" = linux ] && command -v systemctl >/dev/null 2>&1; then
		if unit_active; then
			unit_was_running=1
			start_unit=1
		elif unit_enabled; then
			start_unit=1
		else
			# A run that failed after stopping the unit left a marker in its backup.
			last=$(ls -d "$state"/backups/pre-upgrade-* 2>/dev/null | sort | tail -n 1 || true)
			if [ -n "$last" ] && [ -f "$last/was-running" ]; then start_unit=1; fi
		fi
	fi

	# The galopin being replaced: the unit's own ($HOME/.local/bin/galopin) when it is running,
	# else the one on PATH, unless GALOPIN_INSTALL_DIR says where.
	found=$(command -v galopin 2>/dev/null || true)
	case "$found" in /*) ;; *) found= ;; esac
	if [ -z "${GALOPIN_INSTALL_DIR:-}" ]; then
		if [ -n "$unit_was_running" ]; then
			if [ -n "$found" ] && [ "$(dirname "$found")" != "$dir" ]; then
				say "Note: the galopin on PATH is $found, but the unit runs $dir/galopin; upgrading that one."
			fi
		elif [ -n "$found" ] && [ -x "$found" ]; then
			dir=$(dirname "$found")
		fi
	fi
	if [ -x "$dir/galopin" ]; then
		oldver=$("$dir/galopin" version 2>/dev/null </dev/null | head -n 1 || true)
		[ -n "$oldver" ] || oldver="older than 'galopin version'"
	else
		oldver="not installed in $dir"
	fi
	[ -d "$dir" ] && [ -w "$dir" ] || fail "cannot write to $dir; run this as the user who installed galopin, or set GALOPIN_INSTALL_DIR"

	if [ -z "$unit_was_running" ]; then
		fgscan=$(upgrade_fg_scan) || fail "could not list processes; stop galopin first (the unit, or the galopin run in its terminal), then run this again"
		fgmine=$(printf '%s\n' "$fgscan" | awk '$2 == "mine" { printf "%s ", $1 }')
		fgother=$(printf '%s\n' "$fgscan" | awk '$2 == "other" { printf "%s ", $1 }')
		if [ -n "$fgmine$fgother" ]; then
			if [ -n "$fgother" ]; then
				say "galopin run is running here, but not as $dir/galopin (pid ${fgother}): stop it yourself, then run this again."
				exit 1
			fi
			if [ -z "$stopfg" ]; then
				say "galopin run is running here (pid ${fgmine}): stop it (Ctrl-C in its terminal), then run this again."
				say "Or add --stop to let this installer send it SIGTERM."
				exit 1
			fi
		fi
	fi

	# Stopping galopin must not take this very shell down with it.
	if { [ -n "$unit_was_running" ] || [ -n "$fgmine" ]; } && [ -z "${GALOPIN_UPGRADE_DETACHED:-}" ] && upgrade_inside_galopin; then
		if [ -n "$unit_was_running" ]; then
			upgrade_detach
		fi
		fail "this terminal is inside galopin, and stopping galopin would close it half way through the upgrade. Run the upgrade from a terminal outside galopin (ssh or a local terminal)"
	fi
	say "Upgrading galopin ($oldver) at $dir/galopin; engine: $engine; enrollment: $creds"
}

upgrade_stop() {
	if [ -n "$unit_was_running" ]; then
		say "Stopping galopin (systemd user unit galopin.service)..."
		stopped=1
		systemctl --user stop galopin.service || fail "could not stop the galopin unit"
		n=0
		while unit_active; do
			n=$((n + 1))
			[ "$n" -le 30 ] || fail "galopin did not stop within 30 seconds"
			sleep 1
		done
	elif [ -n "$fgmine" ]; then
		say "Stopping galopin run (pid ${fgmine})..."
		stopped=1
		fg_stopped=1
		# shellcheck disable=SC2086
		kill -TERM $fgmine || fail "could not stop galopin run (pid ${fgmine})"
		n=0
		while :; do
			alive=
			for p in $fgmine; do
				if upgrade_alive "$p"; then alive=1; fi
			done
			[ -n "$alive" ] || break
			n=$((n + 1))
			[ "$n" -le 30 ] || fail "galopin run (pid ${fgmine}) did not stop within 30 seconds"
			sleep 1
		done
	else
		say "galopin is not running; nothing to stop."
	fi
}

upgrade_backup() {
	ts=$(date +%Y%m%d-%H%M%S)
	backup="$state/backups/pre-upgrade-$ts"
	i=1
	while [ -e "$backup" ]; do
		backup="$state/backups/pre-upgrade-$ts-$i"
		i=$((i + 1))
	done
	# 0700: the backup holds the credentials.
	(umask 077 && mkdir -p "$backup/galopin") || fail "could not create $backup"
	if [ -n "$start_unit" ]; then echo unit >"$backup/was-running"; fi
	# galopin's configuration and state, without its own backups and the big directories
	# (the browser runtime and profile, opencode's tools and temporary files).
	for f in "$state"/* "$state"/.[!.]*; do
		[ -e "$f" ] || continue
		case "$(basename "$f")" in backups | browser | ms-playwright | node_modules | cache | tmp | opencode-tools | opencode-tmp) continue ;; esac
		cp -Rp "$f" "$backup/galopin/" || fail "could not back up $f"
	done
	if [ -f "$dir/galopin" ]; then cp -p "$dir/galopin" "$backup/galopin.old" || fail "could not back up $dir/galopin"; fi
	say "Backed up galopin's configuration, state and binary to $backup"
	if [ "$engine" = opencode ]; then
		# opencode 2 migrates a 1.x database in place, so keep the old one.
		ocdata="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
		if [ -f "$ocdata/opencode.db" ]; then
			mkdir -p "$backup/opencode" || fail "could not create $backup/opencode"
			for f in opencode.db opencode.db-wal opencode.db-shm; do
				if [ -f "$ocdata/$f" ]; then cp -p "$ocdata/$f" "$backup/opencode/$f" || fail "could not back up $ocdata/$f"; fi
			done
			say "Backed up opencode's database to $backup/opencode"
		fi
	fi
}

# opencode (and goose) at the version this Cerea pins: installed when missing or older and
# galopin's own install; never downgraded; one installed elsewhere is left alone.
upgrade_engines() {
	if [ "$engine" = opencode ]; then
		mine="$HOME/.opencode/bin/opencode"
		if [ -n "$withopencode" ]; then
			say "Installing opencode $oc_pinned as asked."
		elif [ -x "$mine" ]; then
			now=$("$mine" --version 2>/dev/null </dev/null | head -n 1 || true)
			if [ "$now" = "$oc_pinned" ]; then
				say "opencode $now is already the version this Cerea pins."
			elif upgrade_newer "$oc_pinned" "$now"; then
				withopencode=1
			else
				say "opencode $now is newer than the $oc_pinned this Cerea pins; it is left alone (add --with-opencode to install the pinned one)."
			fi
		elif other=$(command -v opencode 2>/dev/null) && [ -n "$other" ]; then
			now=$("$other" --version 2>/dev/null </dev/null | head -n 1 || true)
			if [ "$now" = "$oc_pinned" ]; then
				say "opencode $now ($other) is already the version this Cerea pins."
			else
				say "Note: opencode ${now:-of unknown version} at $other is not the version this Cerea pins ($oc_pinned). It was not installed by galopin, so it is left alone: update it the way you installed it (for npm: npm install -g opencode-ai@$oc_pinned), or run this again with --with-opencode to install the pinned one into ~/.opencode/bin."
			fi
		else
			withopencode=1
		fi
	fi
	if [ "$engine" = goose ]; then
		mine="$dir/galopin-goose/goose"
		dogoose=1
		if [ -x "$mine" ]; then
			now=$("$mine" --version 2>/dev/null </dev/null | head -n 1 || true)
			nowv=$(printf '%s' "$now" | grep -o '[0-9][0-9.]*' | head -n 1 || true)
			if [ "$nowv" = "$goose_pinned" ]; then
				dogoose=
				say "goose $goose_pinned is already installed."
			elif [ -n "$nowv" ] && ! upgrade_newer "$goose_pinned" "$nowv"; then
				dogoose=
				say "goose $nowv is newer than the $goose_pinned this Cerea pins; it is left alone."
			fi
		elif command -v goose >/dev/null 2>&1; then
			dogoose=
			say "Note: goose at $(command -v goose) was not installed by galopin, so it is left alone; the version this Cerea pins is $goose_pinned."
		fi
	fi
}

# The new galopin must run here; if it does not, the old one goes back at once.
upgrade_check_new() {
	newver=$("$dir/galopin" version 2>/dev/null </dev/null | head -n 1 || true)
	[ -z "$newver" ] || return 0
	say "The new galopin does not run on this computer; putting the old one back."
	if [ -f "$backup/galopin.old" ]; then
		install_bin "$backup/galopin.old" "$dir/galopin" || true
	else
		rm -f "$dir/galopin"
	fi
	replaced=
	fail "the new galopin does not run on this computer; the previous one is back in place"
}

upgrade_prune_backups() {
	ls -d "$state"/backups/pre-upgrade-* 2>/dev/null | sort -r | {
		n=0
		while IFS= read -r b; do
			n=$((n + 1))
			if [ "$n" -gt 3 ]; then rm -rf "$b"; fi
		done
	}
}

upgrade_finish() {
	if [ -f "$state/browser/browser.json" ]; then
		say "Refreshing the browser runtime..."
		"$dir/galopin" browser setup --creds "$creds" </dev/null || say "Warning: the browser runtime could not be refreshed; run 'galopin browser setup' to see why."
	fi
	"$dir/galopin" auth status --creds "$creds" >/dev/null 2>&1 </dev/null || say "Warning: 'galopin auth status' reports a problem; run it to see what."
	if [ -n "$start_unit" ]; then
		systemctl --user start galopin.service || fail "could not start the galopin unit again"
		sleep 1
		unit_active || say "Warning: galopin.service is not active; see: systemctl --user status galopin"
		say "Started galopin.service."
	elif [ -n "$fg_stopped" ]; then
		say "Start galopin again: galopin run"
	fi
	rm -f "$backup/was-running"
	upgrade_prune_backups || true
	upgraded=1
	say ""
	say "galopin: $oldver -> $newver"
	if [ "$engine" = opencode ]; then
		if [ -x "$HOME/.opencode/bin/opencode" ]; then say "opencode: $("$HOME/.opencode/bin/opencode" --version 2>/dev/null </dev/null | head -n 1 || true) (~/.opencode/bin)"; fi
	fi
	say "Enrollment and settings kept; backup in $backup"
}

upgrade_failed() {
	printf '\ngalopin upgrade failed after galopin was stopped.\n' >&2
	if [ -z "$replaced" ]; then
		printf 'The old galopin is in place at %s/galopin and nothing else was changed.\n' "$dir" >&2
		if [ -n "$start_unit" ]; then
			if systemctl --user start galopin.service >/dev/null 2>&1; then
				printf 'Started the old galopin again (galopin.service).\n' >&2
			else
				printf 'Start it again: systemctl --user start galopin\n' >&2
			fi
		else
			printf 'Start it again: galopin run\n' >&2
		fi
		return 0
	fi
	printf 'To roll back (galopin and your settings are not touched by these steps):\n' >&2
	if [ -f "$backup/galopin.old" ]; then printf '  cp -p "%s/galopin.old" "%s/galopin"\n' "$backup" "$dir" >&2; fi
	if [ -n "$oc_replaced" ]; then printf '  mv -f "%s/.opencode/bin/opencode.prev" "%s/.opencode/bin/opencode"\n' "$HOME" "$HOME" >&2; fi
	if [ -d "$backup/opencode" ]; then
		printf '  rm -f "%s/opencode.db" "%s/opencode.db-wal" "%s/opencode.db-shm"\n' "$ocdata" "$ocdata" "$ocdata" >&2
		printf '  cp -p "%s"/opencode/opencode.db* "%s/"\n' "$backup" "$ocdata" >&2
	fi
	if [ -n "$start_unit" ]; then
		printf '  systemctl --user start galopin     # only after the steps above\n' >&2
	else
		printf '  galopin run                        # only after the steps above\n' >&2
	fi
	if [ -n "$prev_made" ]; then printf '(the previous binary is also kept as %s/galopin.prev)\n' "$dir" >&2; fi
	printf 'The backup is in %s\n' "$backup" >&2
}

upgrade_on_exit() {
	rc=$?
	rm -rf "$tmp"
	if [ "$rc" -ne 0 ] && [ -n "$stopped" ] && [ -z "$upgraded" ]; then upgrade_failed || true; fi
	exit "$rc"
}
