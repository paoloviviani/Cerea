#!/bin/sh
# get-kit.sh: install, upgrade or migrate the Cerea deploy kit.
#
# The kit lives in the kit/ directory of the Cerea repository; one Cerea tag
# vX.Y.Z is the kit's version. This script fetches just that directory (a
# shallow, blob-filtered, sparse checkout: a few hundred kilobytes) and nothing
# else. It needs only git and sh. Read it before you run it; it never runs
# docker and never touches a file it did not create, except the operator files
# --from copies into the new checkout.
#
#   curl -fsSL https://raw.githubusercontent.com/paoloviviani/Cerea/stable/kit/get-kit.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/paoloviviani/Cerea/stable/kit/get-kit.sh | sh -s -- --help

set -eu

REPO_DEFAULT=https://github.com/paoloviviani/Cerea
SELF=get-kit.sh

# Never wait for a password prompt that a pipe cannot answer.
GIT_TERMINAL_PROMPT=0
export GIT_TERMINAL_PROMPT

usage() {
	cat <<'EOF'
Usage: get-kit.sh [options]

Install the Cerea deploy kit into DIR/kit, or upgrade or migrate one.

  --version REF   the release to install: a tag vX.Y.Z, or a branch such as
                  "stable". Default: the release tag the stable branch points
                  at (the newest vX.Y.Z tag if the repository has no stable).
  --dir PATH      where the checkout goes. Default: ./cerea
                  It must not exist or be empty (unless --upgrade).
  --repo URL      the repository to fetch from. Default:
                  https://github.com/paoloviviani/Cerea
                  A local path or a file:// URL works too (tests, forks).
  --upgrade       move an existing checkout made by this script to --version.
                  Run it inside the checkout, or name it with --dir. Files git
                  does not track (.env, compose.override.yaml, proxy.d/*.caddy,
                  first-sign-in.txt, backups) stay exactly as they are.
  --from PATH     migrate an install made by cloning the old cerea-deploy
                  repository: install as usual, then copy PATH's .env,
                  compose.override.yaml, proxy.d/*.caddy and first-sign-in.txt
                  into the new kit and pin its compose project name, so Docker
                  finds the same volumes. Prints the two steps left to you.
  -h, --help      show this text

The operator's directory is DIR/kit: cd there, then ./configure and docker
compose, exactly as the kit's README says. DIR itself is a git checkout
(sparse: only kit/ is present) that this script manages.

Exit status: 0 on success, 1 on any failure, 2 on a usage error.
EOF
}

die() {
	printf '%s: error: %s\n' "$SELF" "$*" >&2
	exit 1
}

usage_error() {
	printf '%s: %s\n' "$SELF" "$*" >&2
	printf "Try '%s --help'.\n" "$SELF" >&2
	exit 2
}

say() {
	printf '%s\n' "$*"
}

VERSION=
DIR=
REPO=$REPO_DEFAULT
UPGRADE=0
FROM=

while [ $# -gt 0 ]; do
	case $1 in
	--version | --dir | --repo | --from)
		[ $# -ge 2 ] || usage_error "$1 needs a value"
		case $1 in
		--version) VERSION=$2 ;;
		--dir) DIR=$2 ;;
		--repo) REPO=$2 ;;
		--from) FROM=$2 ;;
		esac
		shift 2
		;;
	--version=* | --dir=* | --repo=* | --from=*)
		case ${1%%=*} in
		--version) VERSION=${1#*=} ;;
		--dir) DIR=${1#*=} ;;
		--repo) REPO=${1#*=} ;;
		--from) FROM=${1#*=} ;;
		esac
		shift
		;;
	--upgrade)
		UPGRADE=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*) usage_error "unknown option: $1" ;;
	esac
done

[ -z "$FROM" ] || [ "$UPGRADE" -eq 0 ] || usage_error "--from and --upgrade cannot be combined"
command -v git >/dev/null 2>&1 || die "git is required and was not found on the PATH"

# A plain path becomes a file:// URL: a bare path makes git do a local clone,
# which ignores --depth and --filter.
if [ -d "$REPO" ]; then
	REPO=file://$(cd "$REPO" && pwd -P)
fi

# Absolute, with no trailing slash and no ./ parts, so messages and cleanup are
# unambiguous.
absolute() {
	case $1 in
	/*) p=$1 ;;
	*) p=$PWD/$1 ;;
	esac
	while :; do
		q=$(printf '%s\n' "$p" | sed -e 's#/\./#/#g' -e 's#//*#/#g' -e 's#/\.$##')
		[ "$q" != "$p" ] || break
		p=$q
	done
	while [ "${p%/}" != "$p" ] && [ "$p" != / ]; do p=${p%/}; done
	printf '%s\n' "$p"
}

# The release to install by default: the vX.Y.Z tag that the `stable` branch
# points at. `stable` moves only once a release has passed its checks, so a tag
# pushed a few minutes earlier is never picked up half-proven. A repository
# with no `stable` branch (a fork, a test remote) falls back to its newest
# vX.Y.Z tag. ls-remote needs no token and has no rate limit, unlike the API.
latest_tag() {
	refs=$(git ls-remote "$REPO" refs/heads/stable 'refs/tags/v*') || die "cannot list the refs of $REPO"
	stable=$(printf '%s\n' "$refs" | sed -n 's#^\([0-9a-f]*\)[[:space:]]*refs/heads/stable$#\1#p')
	if [ -n "$stable" ]; then
		# An annotated tag's commit is on its peeled `^{}` line; a lightweight
		# tag's on its own line.
		best=$(printf '%s\n' "$refs" |
			sed -n "s#^${stable}[[:space:]]*refs/tags/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)\(\^{}\)\{0,1\}\$#\1#p" |
			sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
		[ -n "$best" ] || die "the stable branch of $REPO is not at a release tag; name one with --version"
	else
		best=$(printf '%s\n' "$refs" |
			sed -n 's#^.*refs/tags/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p' |
			sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
		[ -n "$best" ] || die "no release tag vX.Y.Z found in $REPO; name one with --version"
	fi
	printf 'v%s\n' "$best"
}

# Fail early, with a useful message, for a ref the repository does not have.
check_ref() {
	if ! found=$(git ls-remote "$REPO" "refs/tags/$1" "refs/heads/$1" 2>/dev/null) || [ -z "$found" ]; then
		recent=$(git ls-remote --tags --refs "$REPO" 2>/dev/null |
			sed -n 's#^.*refs/tags/\(v[0-9][0-9.]*\)$#\1#p' |
			sort -t. -k1,1n -k2,2n -k3,3n | tail -n 5 | tr '\n' ' ')
		die "$REPO has no tag or branch '$1'${recent:+ (newest tags: $recent)}"
	fi
}

# The checkout must really carry the kit: a tag from before the kit moved into
# this repository checks out to an empty directory.
check_kit_present() {
	if ! { [ -f "$1/kit/compose.yaml" ] && [ -f "$1/kit/configure" ]; }; then
		die "'$2' does not contain the deploy kit (kit/ first appears in the release that moved it here); pick a newer --version"
	fi
}

# A checkout this script made carries a marker in its git config. The directory
# may be named as the checkout or as its kit/ inside, or be the working directory.
managed_root() {
	top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 1
	[ "$(git -C "$top" config --local --get cerea.getkit 2>/dev/null || true)" = 1 ] || return 1
	printf '%s\n' "$top"
}

current_version() {
	git -C "$1" describe --tags --exact-match HEAD 2>/dev/null ||
		git -C "$1" rev-parse --short HEAD
}

# Fetch REF (a tag, else a branch) shallow and without blobs; TARGET is the ref
# to check out afterwards.
fetch_ref() { # root ref
	if git -C "$1" ls-remote --exit-code --tags origin "refs/tags/$2" >/dev/null 2>&1; then
		git -C "$1" fetch --quiet --depth 1 --filter=blob:none --no-tags origin "+refs/tags/$2:refs/tags/$2" ||
			return 1
		TARGET=refs/tags/$2
	else
		git -C "$1" fetch --quiet --depth 1 --filter=blob:none --no-tags origin "+refs/heads/$2:refs/remotes/origin/$2" ||
			return 1
		TARGET=refs/remotes/origin/$2
	fi
}

# --------------------------------------------------------------------- upgrade
if [ "$UPGRADE" -eq 1 ]; then
	ROOT=
	if [ -n "$DIR" ]; then
		[ -d "$DIR" ] || die "--dir $DIR does not exist; nothing to upgrade"
		ROOT=$(managed_root "$DIR") || die "$DIR is not a checkout made by $SELF; refusing to touch it"
	else
		ROOT=$(managed_root "$PWD") || ROOT=
		if [ -z "$ROOT" ] && [ -d ./cerea ]; then
			ROOT=$(managed_root ./cerea) || ROOT=
		fi
		[ -n "$ROOT" ] || die "not inside a checkout made by $SELF (and no ./cerea here); run it inside the checkout, or name it with --dir"
	fi

	# A repository other than the one it was made from is a different kit:
	# --repo says where to fetch, and defaults to the one on record.
	if [ "$REPO" = "$REPO_DEFAULT" ]; then
		recorded=$(git -C "$ROOT" config --get remote.origin.url 2>/dev/null || true)
		[ -z "$recorded" ] || REPO=$recorded
	fi
	git -C "$ROOT" remote set-url origin "$REPO"

	[ -n "$VERSION" ] || VERSION=$(latest_tag) || exit 1
	check_ref "$VERSION"
	OLD=$(current_version "$ROOT")

	if [ "$OLD" = "$VERSION" ]; then
		say "Already at $VERSION: nothing to do."
		say "Operator directory: $ROOT/kit"
		exit 0
	fi

	fetch_ref "$ROOT" "$VERSION" || die "could not fetch $VERSION from $REPO"
	git -C "$ROOT" checkout --quiet --detach "$TARGET" ||
		die "could not check out $VERSION: you have edited a file git tracks. See 'git -C $ROOT status'; put your changes in compose.override.yaml or proxy.d/ instead, or 'git -C $ROOT checkout -- .' to drop them, then run this again"
	check_kit_present "$ROOT" "$VERSION"

	say "Upgraded $OLD -> $VERSION in $ROOT"
	say
	say "Next (read kit/CHANGELOG.md first; it says when a release needs more from you):"
	say "  cd $ROOT/kit"
	say "  docker compose pull"
	say "  docker compose up -d"
	say
	say "Back up before an upgrade: database migrations only go forward (see 'Backup and restore' in kit/README.md)."
	exit 0
fi

# --------------------------------------------------------------- fresh install
[ -n "$DIR" ] || DIR=./cerea
DIR=$(absolute "$DIR")

if [ -e "$DIR" ] || [ -L "$DIR" ]; then
	[ -d "$DIR" ] || die "$DIR exists and is not a directory"
	if [ -n "$(ls -A "$DIR")" ]; then
		if managed_root "$DIR" >/dev/null 2>&1; then
			die "$DIR is already a checkout made by $SELF; run '$SELF --upgrade --dir $DIR' to move it to a newer release"
		fi
		die "$DIR is not empty and is not a checkout made by $SELF; refusing to write into it (choose another --dir)"
	fi
fi

if [ -n "$FROM" ]; then
	[ -d "$FROM" ] || die "--from $FROM is not a directory"
	FROM=$(cd "$FROM" && pwd -P)
	if ! { [ -f "$FROM/compose.yaml" ] && [ -f "$FROM/configure" ]; }; then
		die "--from $FROM does not look like a cerea-deploy install (no compose.yaml and configure)"
	fi
	[ -f "$FROM/.env" ] || die "--from $FROM has no .env: it was never configured, so there is nothing to migrate; install fresh instead (leave out --from)"
	[ "$FROM" != "$(absolute "$DIR")" ] || die "--from and --dir are the same directory"
fi

[ -n "$VERSION" ] || VERSION=$(latest_tag) || exit 1
check_ref "$VERSION"

made_dir=0
[ -e "$DIR" ] || made_dir=1
cleanup() {
	status=$?
	if [ "$status" -ne 0 ] && [ "${started:-0}" -eq 1 ]; then
		if [ "$made_dir" -eq 1 ]; then
			rm -rf "$DIR"
		else
			# it was an empty directory: leave it empty again
			rm -rf "${DIR:?}"/* "${DIR:?}"/.[!.]* "${DIR:?}"/..?* 2>/dev/null || true
		fi
	fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

say "Fetching $VERSION from $REPO into $DIR (only kit/ is checked out) ..."
started=1
# (git 2.53 warns "refs/tags/vX is not a commit!" for a --no-checkout clone of an
# annotated tag; the checkout below is fine, so that one line is not shown.)
if ! out=$(git clone --quiet --filter=blob:none --no-checkout --depth 1 --branch "$VERSION" "$REPO" "$DIR" 2>&1); then
	printf '%s\n' "$out" >&2
	die "git clone failed"
fi
printf '%s\n' "$out" | grep -v '^warning: refs/tags/.* is not a commit!$' || true
git -C "$DIR" config --local cerea.getkit 1
# Non-cone mode on purpose: cone mode also checks out every file in the
# repository's top directory, and the operator needs kit/ and nothing else.
git -C "$DIR" sparse-checkout set --no-cone '/kit/' ||
	die "git sparse-checkout failed (git 2.25 or newer is needed)"
git -C "$DIR" checkout --quiet || die "git checkout failed"
check_kit_present "$DIR" "$VERSION"

KIT=$DIR/kit
say "Installed $(current_version "$DIR") in $KIT"

# ------------------------------------------------------------------- migration
if [ -n "$FROM" ]; then
	say
	say "Migrating the operator's files from $FROM ..."
	copied=
	copy_one() { # relative path
		if [ -f "$FROM/$1" ]; then
			mkdir -p "$KIT/$(dirname "$1")"
			cp -p "$FROM/$1" "$KIT/$1"
			copied="$copied $1"
		fi
	}
	copy_one .env
	copy_one compose.override.yaml
	copy_one compose.override.yml
	copy_one first-sign-in.txt
	for f in "$FROM"/.env.bak-* "$FROM"/proxy.d/*.caddy; do
		[ -f "$f" ] || continue
		copy_one "${f#"$FROM"/}"
	done
	say "  copied:$copied"

	# The project name decides the volume names. Pin it in the new .env: the
	# value the old .env had (copied already), else the default its compose.yaml
	# carries (`name: ${COMPOSE_PROJECT_NAME:-cerea}`), else, for a compose file
	# without a name, the directory's name as Compose derives it.
	if grep -q '^COMPOSE_PROJECT_NAME=' "$KIT/.env"; then
		project=$(sed -n "s/^COMPOSE_PROJECT_NAME=//p" "$KIT/.env" | tail -n 1 | tr -d "'\"")
		say "  compose project: $project (from the old .env)"
	else
		# shellcheck disable=SC2016 # the ${...} is text to match, not to expand
		project=$(sed -n 's/^name:[[:space:]]*\${COMPOSE_PROJECT_NAME:-\([^}]*\)}.*$/\1/p' "$FROM/compose.yaml" | head -n 1)
		if [ -z "$project" ]; then
			project=$(sed -n 's/^name:[[:space:]]*\([A-Za-z0-9_-][A-Za-z0-9_-]*\)[[:space:]]*$/\1/p' "$FROM/compose.yaml" | head -n 1)
		fi
		if [ -z "$project" ]; then
			project=$(basename "$FROM" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')
		fi
		[ -n "$project" ] || die "cannot work out the old compose project name; set COMPOSE_PROJECT_NAME in $KIT/.env by hand"
		# keep a final newline in front of the new line
		[ -z "$(tail -c 1 "$KIT/.env")" ] || printf '\n' >>"$KIT/.env"
		printf "COMPOSE_PROJECT_NAME='%s'\n" "$project" >>"$KIT/.env"
		say "  compose project: $project (the old .env had none; pinned now in the new .env)"
	fi

	# Things a migration cannot carry; say so rather than lose them quietly.
	if [ -d "$FROM/.git" ] && [ -n "$(git -C "$FROM" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
		say "  warning: $FROM has local edits to files the kit tracks (git -C $FROM status);"
		say "           they are NOT migrated. Put such changes in compose.override.yaml or proxy.d/*.caddy."
	fi
	if grep -Eq '^(CEREA|PYSTINO)_(VERSION|REGISTRY)=|^(GATEWAY|REDACTION|CEREA)_IMAGE=' "$KIT/.env"; then
		say "  warning: the .env pins an image version, registry or image of its own, which overrides the kit's"
		say "           pin; remove it with ./configure --unset if you want the release's tested versions."
	fi
	found_backups=$(find "$FROM" -maxdepth 1 -name 'backup-*' 2>/dev/null | head -n 1)
	if [ -n "$found_backups" ]; then
		say "  note: backup-* directories in $FROM were not copied (they can be large); move them if you want them here."
	fi
	if [ -f "$KIT/compose.override.yaml" ] || [ -f "$KIT/compose.override.yml" ]; then
		say "  note: relative paths in the compose override now resolve against $KIT."
	fi

	say
	say "Two steps are left, and they are yours (this script never runs docker):"
	say "  1. In the OLD directory, stop the stack WITHOUT -v (-v deletes the data):"
	say "       cd $FROM && docker compose down"
	say "  2. In the NEW directory, start it; Docker finds the same volumes by project name '$project':"
	say "       cd $KIT && docker compose up -d --wait"
	say "     then, to see that nothing is off: ./configure --check (it asks the running stack, so it needs it up)."
	say
	say "Prefer a clean start instead? 'docker compose down -v' in the old directory deletes its"
	say "volumes (every conversation, account and key), then run ./configure fresh in $KIT."
	exit 0
fi

say
say "Next:"
say "  cd $KIT"
say "  ./configure                  # asks a few questions, writes .env"
say "  docker compose up -d"
say
say "Needs Docker Engine with Compose 2.24 or newer and Python 3.9 or newer (for ./configure only)."
say "To upgrade later: sh $KIT/get-kit.sh --upgrade"
