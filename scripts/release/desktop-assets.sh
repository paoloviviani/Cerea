#!/usr/bin/env bash
# desktop-assets.sh vX.Y.Z: attach the desktop app's preview builds to the GitHub release vX.Y.Z and
# add the "Cerea Desktop: preview" section to its notes. Idempotent: files are re-uploaded with
# --clobber and the notes section is added only once. release.sh runs it after creating the release;
# run it alone to retry (`scripts/release/desktop-assets.sh vX.Y.Z`).
#
# The builds come from the `desktop` workflow run on the tag's commit; when a path filter skipped it,
# from the newest successful run on main whose commit is an ancestor of the tag, provided nothing the
# build reads changed in between. When there is no usable run (none, or its artifacts expired: they
# are kept 90 days), the script dispatches `desktop` on the tag and waits for it.
#
# Needs: gh (authenticated, with workflow and contents write), git, python3, sha256sum.
set -uo pipefail
T=${1:?usage: desktop-assets.sh vX.Y.Z}
[[ $T == v*.*.* ]] || { echo "usage: desktop-assets.sh vX.Y.Z (got '$T')" >&2; exit 2; }
cd "$(git rev-parse --show-toplevel)" || exit 1
REPO=${CEREA_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}
stop() { echo "desktop-assets: $*" >&2; exit 1; }
# Everything the build reads (the paths of .github/workflows/desktop.yml). package.json: the build is
# stamped with its version, so a build from before a version bump is not reused.
PATHS=(desktop browser-runtime agent/internal package.json .github/workflows/desktop.yml)

git fetch -q origin "refs/tags/$T:refs/tags/$T" 2>/dev/null || git rev-parse -q --verify "refs/tags/$T" >/dev/null || stop "no tag $T (fetch failed)"
git fetch -q origin main || stop "fetch main"
SHA=$(git rev-parse "$T^{commit}") || stop "cannot resolve $T"
gh release view -R "$REPO" "$T" >/dev/null 2>&1 || stop "no GitHub release $T on $REPO: create it first"
# The app is built with the Cerea version (desktop/scripts/package.mjs), so its files are named with it.
V=$(git show "$SHA:package.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])') ||
	stop "cannot read package.json at $T"
[ "v$V" = "$T" ] || stop "package.json at $T says $V, not ${T#v}"

# unchanged RUNSHA: the build inputs are the same at RUNSHA and at the tag. agent/*.go is checked by glob.
unchanged() {
	git diff --quiet "$1" "$SHA" -- "${PATHS[@]}" ':(glob)agent/*.go'
}

# Print a run id whose three artifacts are all present and unexpired, or nothing.
usable_run() {
	local id=$1 n
	n=$(gh api "repos/$REPO/actions/runs/$id/artifacts" --paginate -q '.artifacts[]|select(.expired==false)|.name' 2>/dev/null |
		grep -cE '^cerea-desktop-(linux|macos-arm64|macos-x64)$')
	[ "$n" = 3 ]
}

find_run() {
	local runs c id
	runs=$(gh run list -R "$REPO" --workflow desktop.yml --limit 100 --json databaseId,headSha,conclusion,headBranch \
		-q '.[]|select(.conclusion=="success")|.headSha+" "+(.databaseId|tostring)+" "+.headBranch') || return 1
	# 1. A run on the tag's own commit; 2. the newest earlier commit on main that had one.
	for c in $(git rev-list --max-count=200 "$SHA"); do
		id=$(awk -v c="$c" '$1==c && ($3=="main" || c==s){print $2; exit}' s="$SHA" <<<"$runs")
		[ -n "$id" ] || continue
		if [ "$c" != "$SHA" ]; then
			unchanged "$c" || { echo "desktop-assets: the newest desktop build (on ${c:0:8}) is older than a change to ${PATHS[*]} agent/*.go" >&2; return 2; }
			echo "desktop: no run for $SHA (path filter); using the one on ${c:0:8}, with no desktop change since" >&2
		fi
		usable_run "$id" || { echo "desktop-assets: run $id has no usable artifacts (expired after 90 days?)" >&2; return 2; }
		echo "$id"
		return 0
	done
	return 2
}

# The release commit changes package.json, so its push started a desktop build: wait for it rather
# than dispatching a second one.
inflight=$(gh run list -R "$REPO" --workflow desktop.yml --commit "$SHA" --limit 20 --json databaseId,status \
	-q '[.[]|select(.status!="completed")][0].databaseId // empty' 2>/dev/null) || inflight=""
if [ -n "$inflight" ]; then
	echo "desktop: waiting for the desktop build already running on ${SHA:0:8} (run $inflight)" >&2
	deadline=$(( $(date +%s) + 90*60 ))
	until s=$(gh run view -R "$REPO" "$inflight" --json status -q .status 2>/dev/null) && [ "$s" = completed ]; do
		[ "$(date +%s)" -ge "$deadline" ] && stop "the desktop build already running on ${SHA:0:8} (run $inflight) did not finish in 90 minutes"
		sleep 30
	done
fi

run=$(find_run); rc=$?
if [ $rc -ne 0 ] || [ -z "$run" ]; then
	echo "desktop: no usable desktop build for $T; running the desktop workflow on $T and waiting (about 15 minutes)" >&2
	before=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	gh workflow run -R "$REPO" desktop.yml --ref "$T" 2>/dev/null ||
		stop "cannot dispatch desktop.yml on $T. Run it on main (gh workflow run desktop.yml --ref main), wait, and rerun this script"
	run=""
	for _ in $(seq 1 20); do
		sleep 15
		run=$(gh run list -R "$REPO" --workflow desktop.yml --event workflow_dispatch --limit 10 --json databaseId,headSha,createdAt \
			-q "[.[]|select(.headSha==\"$SHA\" and .createdAt>=\"$before\")][0].databaseId")
		[ -n "$run" ] && break
	done
	[ -n "$run" ] || stop "the dispatched desktop run did not appear"
	deadline=$(( $(date +%s) + 90*60 ))
	until s=$(gh run view -R "$REPO" "$run" --json status,conclusion -q '.status+" "+.conclusion' 2>/dev/null) && [[ $s == completed* ]]; do
		[ "$(date +%s)" -ge "$deadline" ] && stop "the dispatched desktop run (run $run) did not finish in 90 minutes"
		sleep 30
	done
	[[ $s == *success ]] || stop "desktop build failed: gh run view -R $REPO $run --log-failed"
fi
echo "desktop: using run $run (desktop app $V)"

tmp=$(mktemp -d) || stop "mktemp"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/dl" "$tmp/out"
for a in cerea-desktop-macos-arm64 cerea-desktop-macos-x64 cerea-desktop-linux; do
	gh run download -R "$REPO" "$run" -n "$a" -D "$tmp/dl/$a" || stop "cannot download artifact $a of run $run"
done

# one FILE: the single file in $1/<dir> matching the glob; fails unless there is exactly one.
one() {
	local f
	f=$(compgen -G "$tmp/dl/$1/$2") || true
	[ "$(wc -l <<<"$f")" = 1 ] && [ -n "$f" ] || stop "expected exactly one $2 in artifact $1, got: ${f:-none}"
	echo "$f"
}
P=Cerea-Desktop-PREVIEW-$V
cp "$(one cerea-desktop-macos-arm64 "Cerea-$V-arm64-mac.zip")" "$tmp/out/$P-macos-apple-silicon.zip" || stop "copy"
cp "$(one cerea-desktop-macos-x64 "Cerea-$V-mac.zip")" "$tmp/out/$P-macos-intel.zip" || stop "copy"
cp "$(one cerea-desktop-linux "Cerea-$V.AppImage")" "$tmp/out/$P-linux-x86_64.AppImage" || stop "copy"
cp "$(one cerea-desktop-linux "cerea-desktop_${V}_amd64.deb")" "$tmp/out/cerea-desktop-preview_${V}_amd64.deb" || stop "copy"
# The macOS installer (no Gatekeeper prompt), from the tagged commit; unversioned, so the latest
# release's download link stays the same.
git show "$SHA:desktop/scripts/install-macos.sh" >"$tmp/out/Cerea-Desktop-PREVIEW-install-macos.sh" ||
	stop "no desktop/scripts/install-macos.sh at $T"
(cd "$tmp/out" && sha256sum -- * >"$tmp/SHA256SUMS.txt") || stop "sha256sum"
mv "$tmp/SHA256SUMS.txt" "$tmp/out/$P-SHA256SUMS.txt"
ls -l "$tmp/out"

gh release upload -R "$REPO" "$T" --clobber "$tmp/out"/* || stop "upload to $T failed"

# Notes: add the section once.
body=$(gh release view -R "$REPO" "$T" --json body -q .body) || stop "cannot read the notes of $T"
if grep -qx '## Cerea Desktop: preview' <<<"$body"; then
	echo "notes of $T already have the desktop preview section"
else
	tmpl=scripts/release/desktop-notes.md.tmpl
	[ -f "$tmpl" ] || tmpl=$tmp/tmpl
	[ "$tmpl" != "$tmp/tmpl" ] || git show "$SHA:scripts/release/desktop-notes.md.tmpl" >"$tmpl" || stop "no notes template"
	{ printf '%s\n\n---\n\n' "$body"; sed "s/@V@/$V/g" "$tmpl"; } >"$tmp/notes.md"
	gh release edit -R "$REPO" "$T" --notes-file "$tmp/notes.md" || stop "cannot update the notes of $T"
	echo "notes of $T: desktop preview section added"
fi
echo "desktop preview attached to $T ($V)"
