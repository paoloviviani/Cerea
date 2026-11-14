# The `--upgrade` half of install.sh (POSIX sh), spliced in by renderInstallScript
# (galopinDist.ts) between the helper functions and the download. It only defines
# functions; the installer calls them in this order:
#
#   upgrade_precheck    enrollment present? which engine? where is galopin?
#   upgrade_stop        systemd user unit / foreground `galopin run` / refuse
#   upgrade_backup      galopin's state and opencode's database
#   (the installer's own download, checksum check and install follow)
#   upgrade_engines     decide whether opencode / goose need installing
#   upgrade_finish      browser runtime, a health check, restart, summary
#
# `upgrade_on_exit` is the EXIT trap: after the stop, a failure prints how to roll back.
# Placeholders in @...@ are filled in by the renderer.
#
# shellcheck shell=sh disable=SC2034,SC2154

say() { printf '%s\n' "$*"; }

stopped=
unit_was_running=
fg_stopped=
fgpids=
replaced=
prev_made=
oc_replaced=
upgraded=
backup=
state=
oldver=
ocdata=
oc_pinned=@OPENCODE_VERSION@
goose_pinned=@GOOSE_VERSION@

unit_active() { systemctl --user is-active --quiet galopin.service >/dev/null 2>&1; }

# The pids of this user's own `galopin run`: the process list's first word is a path
# ending in galopin and the second is `run`. Matching fields, never a bare `pgrep -f`
# (which matches this very script's command line).
upgrade_fg_pids() {
	ps -U "$(id -un)" -o pid= -o args= 2>/dev/null | awk '
		{
			pid = $1
			c = $0
			sub(/^[ \t]*[0-9]+[ \t]+/, "", c)
			n = split(c, a, " ")
			if (n >= 2 && a[1] ~ /(^|\/)galopin$/ && a[2] == "run") print pid
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

# Running and not a zombie (a stopped child nobody has waited for yet).
upgrade_alive() {
	kill -0 "$1" 2>/dev/null || return 1
	case "$(ps -o stat= -p "$1" 2>/dev/null)" in Z*) return 1 ;; esac
	return 0
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

	# The galopin being replaced: the one on PATH, unless GALOPIN_INSTALL_DIR says where.
	if [ -z "${GALOPIN_INSTALL_DIR:-}" ]; then
		found=$(command -v galopin 2>/dev/null || true)
		case "$found" in
			/*) if [ -x "$found" ]; then dir=$(dirname "$found"); fi ;;
		esac
	fi
	if [ -x "$dir/galopin" ]; then
		oldver=$("$dir/galopin" version 2>/dev/null </dev/null | head -n 1 || true)
		[ -n "$oldver" ] || oldver="older than 'galopin version'"
	else
		oldver="not installed in $dir"
	fi

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

	[ -d "$dir" ] && [ -w "$dir" ] || fail "cannot write to $dir; run this as the user who installed galopin, or set GALOPIN_INSTALL_DIR"

	if [ "$os" = linux ] && command -v systemctl >/dev/null 2>&1 && unit_active; then
		unit_was_running=1
	else
		fgpids=$(upgrade_fg_pids)
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
	elif [ -n "$fgpids" ]; then
		if [ -z "$stopfg" ]; then
			say "galopin run is running here (pid $fgpids): stop it (Ctrl-C in its terminal), then run this again."
			say "Or add --stop to let this installer send it SIGTERM."
			exit 1
		fi
		say "Stopping galopin run (pid $fgpids)..."
		stopped=1
		fg_stopped=1
		# shellcheck disable=SC2086
		kill -TERM $fgpids || fail "could not stop galopin run (pid $fgpids)"
		n=0
		while :; do
			alive=
			for p in $fgpids; do
				if upgrade_alive "$p"; then alive=1; fi
			done
			[ -n "$alive" ] || break
			n=$((n + 1))
			[ "$n" -le 30 ] || fail "galopin run (pid $fgpids) did not stop within 30 seconds"
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
	# galopin's config and state, without its own backups and the browser runtime's big directories.
	for f in "$state"/* "$state"/.[!.]*; do
		[ -e "$f" ] || continue
		case "$(basename "$f")" in backups | browser | ms-playwright | node_modules | cache | tmp) continue ;; esac
		cp -Rp "$f" "$backup/galopin/" || fail "could not back up $f"
	done
	say "Backed up galopin's configuration and state to $backup/galopin"
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

# opencode (and goose) at the version this Cerea pins: installed when missing or
# different and galopin's own install; one installed elsewhere is left alone.
upgrade_engines() {
	if [ "$engine" = opencode ]; then
		mine="$HOME/.opencode/bin/opencode"
		if [ -x "$mine" ]; then
			now=$("$mine" --version 2>/dev/null </dev/null | head -n 1 || true)
			if [ "$now" = "$oc_pinned" ]; then
				say "opencode $now is already the version this Cerea pins."
			else
				withopencode=1
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
			case "$now" in *"$goose_pinned"*) dogoose=; say "goose $goose_pinned is already installed." ;; esac
		elif command -v goose >/dev/null 2>&1; then
			dogoose=
			say "Note: goose at $(command -v goose) was not installed by galopin, so it is left alone; the version this Cerea pins is $goose_pinned."
		fi
	fi
}

upgrade_finish() {
	newver=$("$dir/galopin" version 2>/dev/null </dev/null | head -n 1 || true)
	[ -n "$newver" ] || fail "the new galopin does not run on this computer"
	if [ -f "$state/browser/browser.json" ]; then
		say "Refreshing the browser runtime..."
		"$dir/galopin" browser setup --creds "$creds" </dev/null || say "Warning: the browser runtime could not be refreshed; run 'galopin browser setup' to see why."
	fi
	"$dir/galopin" auth status --creds "$creds" >/dev/null 2>&1 </dev/null || say "Warning: 'galopin auth status' reports a problem; run it to see what."
	if [ -n "$unit_was_running" ]; then
		systemctl --user start galopin.service || fail "could not start the galopin unit again"
		sleep 1
		unit_active || say "Warning: galopin.service is not active; see: systemctl --user status galopin"
		say "Restarted galopin.service."
	elif [ -n "$fg_stopped" ]; then
		say "Start galopin again: galopin run"
	fi
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
		printf 'The old galopin is still in place at %s/galopin and nothing else was changed.\n' "$dir" >&2
		if [ -n "$unit_was_running" ]; then
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
	if [ -n "$prev_made" ]; then printf '  mv -f "%s/galopin.prev" "%s/galopin"\n' "$dir" "$dir" >&2; fi
	if [ -n "$oc_replaced" ]; then printf '  mv -f "%s/.opencode/bin/opencode.prev" "%s/.opencode/bin/opencode"\n' "$HOME" "$HOME" >&2; fi
	if [ -d "$backup/opencode" ]; then
		printf '  rm -f "%s/opencode.db" "%s/opencode.db-wal" "%s/opencode.db-shm"\n' "$ocdata" "$ocdata" "$ocdata" >&2
		printf '  cp -p "%s"/opencode/opencode.db* "%s/"\n' "$backup" "$ocdata" >&2
	fi
	if [ -n "$unit_was_running" ]; then
		printf '  systemctl --user start galopin     # only after the steps above\n' >&2
	else
		printf '  galopin run                        # only after the steps above\n' >&2
	fi
	printf 'The backup is in %s\n' "$backup" >&2
}

upgrade_on_exit() {
	rc=$?
	rm -rf "$tmp"
	if [ "$rc" -ne 0 ] && [ -n "$stopped" ] && [ -z "$upgraded" ]; then upgrade_failed || true; fi
	exit "$rc"
}
