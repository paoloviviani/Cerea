# The body of install.sh (POSIX sh), after the helper functions and galopinUpgrade.sh, inside
# main(). renderInstallScript (galopinDist.ts) fills the @...@ placeholders. Everything is
# downloaded and checksum-verified into $tmp before anything is stopped or replaced, and each
# binary goes in with a copy beside it and a rename, so a failure never leaves half a file.
#
# shellcheck shell=sh disable=SC2034,SC2154

install_bin() {
	ib_new="$(dirname "$2")/.$(basename "$2").new.$$"
	cp "$1" "$ib_new" || return 1
	chmod 755 "$ib_new" || return 1
	if [ "$os" = darwin ] && command -v xattr >/dev/null 2>&1; then
		xattr -d com.apple.quarantine "$ib_new" 2>/dev/null || true
	fi
	mv -f "$ib_new" "$2"
}

trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap upgrade_on_exit EXIT

oc_ready=
goose_ready=

if [ -n "$upgrade" ]; then
	upgrade_precheck
	case "$engine" in opencode | goose | none) ;; *) fail "--engine must be opencode or goose" ;; esac
	upgrade_engines
fi

fetch "$origin/galopin/$name" "$tmp/$name" || fail "could not download $name from $origin"
fetch "$origin/galopin/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download SHA256SUMS from $origin"

want=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || fail "SHA256SUMS lists no $name"
got=$(sha256 "$tmp/$name")
[ "$got" = "$want" ] || fail "checksum mismatch for $name (expected $want, got $got); nothing installed"
chmod 755 "$tmp/$name"

if [ "$engine" = opencode ] && [ -n "$withopencode" ]; then
	# The same variant choice opencode's own installer makes: the -baseline build
	# for a CPU without AVX2, the -musl build on Alpine or another musl system.
	musl=
	baseline=
	if [ "$os" = linux ]; then
		[ -f /etc/alpine-release ] && musl=-musl
		if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then musl=-musl; fi
		if [ "$arch" = amd64 ] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then baseline=-baseline; fi
	fi
	ocarch=$arch
	if [ "$os" = darwin ]; then
		[ "$arch" = amd64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ] && ocarch=arm64
		if [ "$ocarch" = amd64 ] && [ "$(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 0)" != 1 ]; then baseline=-baseline; fi
	fi
	case "$ocarch" in amd64) ocarch=x64 ;; esac
	ext=.tar.gz
	[ "$os" = darwin ] && ext=.zip
	archive="opencode-$os-$ocarch$baseline$musl$ext"
	case "$archive" in
@OPENCODE_SUMS@
		*) fail "opencode publishes no $archive build for this computer: install opencode yourself, then run galopin enroll" ;;
	esac
	fetch "https://github.com/anomalyco/opencode/releases/download/v@OPENCODE_VERSION@/$archive" "$tmp/$archive" || fail "could not download opencode @OPENCODE_VERSION@ ($archive)"
	got=$(sha256 "$tmp/$archive")
	[ "$got" = "$want" ] || fail "checksum mismatch for $archive (expected $want, got $got); opencode not installed"
	mkdir -p "$tmp/oc-x"
	case "$archive" in
		*.zip) command -v unzip >/dev/null 2>&1 || fail "needs unzip to unpack $archive"; unzip -q -o "$tmp/$archive" -d "$tmp/oc-x" || fail "could not unpack $archive" ;;
		*) tar -xzf "$tmp/$archive" -C "$tmp/oc-x" || fail "could not unpack $archive" ;;
	esac
	[ -f "$tmp/oc-x/opencode" ] || fail "$archive holds no opencode binary"
	chmod 755 "$tmp/oc-x/opencode"
	# never report success for a binary that cannot run here (a wrong CPU or libc build)
	"$tmp/oc-x/opencode" --version >/dev/null 2>&1 || fail "the opencode build $archive does not run on this computer; opencode not installed. Install opencode yourself, then run galopin enroll"
	oc_ready=1
fi

if [ "$engine" = goose ] && [ -n "$dogoose" ]; then
	case "$os-$arch" in
		linux-amd64) target=x86_64-unknown-linux-gnu ;;
		linux-arm64) target=aarch64-unknown-linux-gnu ;;
		darwin-amd64) target=x86_64-apple-darwin ;;
		darwin-arm64) target=aarch64-apple-darwin ;;
	esac
	archive="goose-$target.tar.gz"
	case "$archive" in
@GOOSE_SUMS@
		*) fail "no recorded checksum for $archive" ;;
	esac
	fetch "https://github.com/block/goose/releases/download/v@GOOSE_VERSION@/$archive" "$tmp/$archive" || fail "could not download goose @GOOSE_VERSION@ ($archive)"
	got=$(sha256 "$tmp/$archive")
	[ "$got" = "$want" ] || fail "checksum mismatch for $archive (expected $want, got $got); goose not installed"
	mkdir -p "$tmp/goose-x"
	tar -xzf "$tmp/$archive" -C "$tmp/goose-x" || fail "could not unpack $archive"
	[ -f "$tmp/goose-x/goose" ] || fail "$archive holds no goose binary"
	chmod 755 "$tmp/goose-x/goose"
	goose_ready=1
fi

if [ -n "$upgrade" ]; then
	upgrade_stop
	upgrade_backup
fi

mkdir -p "$dir"
if [ -n "$upgrade" ] && [ -f "$dir/galopin" ]; then
	# Keep the binary being replaced as galopin.prev, unless it already is the incoming one
	# (a rerun after a failure must not push the good previous binary out).
	if cmp -s "$dir/galopin" "$tmp/$name" && [ -f "$dir/galopin.prev" ]; then
		:
	else
		cp -p "$dir/galopin" "$dir/galopin.prev" || fail "could not keep the previous galopin as galopin.prev"
	fi
	prev_made=1
fi
install_bin "$tmp/$name" "$dir/galopin" || fail "could not install galopin to $dir"
replaced=1
printf 'Installed galopin to %s/galopin (checksum verified).\n' "$dir"
if [ -n "$upgrade" ]; then upgrade_check_new; fi

if [ -n "$oc_ready" ]; then
	mkdir -p "$HOME/.opencode/bin"
	if [ -n "$upgrade" ] && [ -f "$HOME/.opencode/bin/opencode" ]; then
		cp -p "$HOME/.opencode/bin/opencode" "$HOME/.opencode/bin/opencode.prev" || fail "could not keep the previous opencode as opencode.prev"
		oc_replaced=1
	fi
	install_bin "$tmp/oc-x/opencode" "$HOME/.opencode/bin/opencode" || fail "could not install opencode to $HOME/.opencode/bin"
	printf 'Installed opencode @OPENCODE_VERSION@ to %s/.opencode/bin/opencode (checksum verified; galopin finds it there).\n' "$HOME"
fi

if [ -n "$goose_ready" ]; then
	mkdir -p "$dir/galopin-goose"
	install_bin "$tmp/goose-x/goose" "$dir/galopin-goose/goose" || fail "could not install goose to $dir/galopin-goose"
	printf 'Installed goose @GOOSE_VERSION@ to %s/galopin-goose/goose (checksum verified; a goose you installed yourself is left alone).\n' "$dir"
fi
case ":$PATH:" in
	*":$dir:"*) ;;
	*) printf 'Note: %s is not on your PATH; add it, or run %s/galopin directly.\n' "$dir" "$dir" ;;
esac
if [ -n "$upgrade" ]; then
	upgrade_finish
	exit 0
fi
engineflag=""
[ "$engine" = goose ] && engineflag=" --engine goose"
@NEXT@
