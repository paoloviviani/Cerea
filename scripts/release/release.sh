#!/usr/bin/env bash
# release.sh X.Y.Z: publish a release whose release commit is already on main
# (package.json at X.Y.Z, `kit/tools/pin --cerea X.Y.Z`, a `## vX.Y.Z` entry in
# kit/CHANGELOG.md). Every step is checked and the script stops at the first
# failure; `stable` moves only after the fresh-kit test printed E2E_OK. See
# AGENTS.md "Releasing".
#
# Needs: gh (authenticated, with workflow and contents write), git, docker.
set -uo pipefail
V=${1:?usage: release.sh X.Y.Z}
T=v$V
cd "$(git rev-parse --show-toplevel)" || exit 1
REPO=${CEREA_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}
stop() { echo "STOP: $*"; exit 1; }

git fetch -q origin || stop "fetch"
SHA=$(git rev-parse origin/main)
[ "$(git show "$SHA:package.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')" = "$V" ] ||
	stop "origin/main's package.json is not $V: push the release commit first"
# No -q on purpose: grep -q exits at the first match while git show is still
# writing the blob into the pipe, and under pipefail the writer's SIGPIPE
# fails the pipeline even though the entry is there (it stopped a release
# one time in two). Without -q grep reads to EOF, so the check is
# deterministic.
git show "$SHA:kit/CHANGELOG.md" | grep "^## $T " >/dev/null || stop "kit/CHANGELOG.md has no '## $T' entry"
git ls-remote --exit-code origin "refs/tags/$T" >/dev/null && stop "$T already exists"
echo "releasing $T at $SHA"

# 1. CI green on the release commit.
for wf in ci.yml kit.yml; do
	id=""
	for _ in $(seq 1 40); do
		id=$(gh run list -R "$REPO" --workflow "$wf" --limit 20 --json databaseId,headSha -q "[.[]|select(.headSha==\"$SHA\")][0].databaseId")
		[ -n "$id" ] && break
		sleep 15
	done
	[ -n "$id" ] || { echo "$wf: no run for this commit (path filter), skipping"; continue; }
	until s=$(gh run view -R "$REPO" "$id" --json status,conclusion -q '.status+" "+.conclusion' 2>/dev/null) && [[ $s == completed* ]]; do sleep 30; done
	echo "$wf $s"
	[[ $s == *success ]] || stop "$wf failed: gh run view -R $REPO $id --log-failed"
done

# 2. Tag (falls back to the API when git push hits a GitHub 5xx).
git tag -a "$T" -m "$T" "$SHA" || stop "local tag"
ok=0
for _ in 1 2 3 4 5; do git push -q origin "$T" 2>/dev/null && { ok=1; break; }; sleep 30; done
[ $ok = 1 ] || gh api "repos/$REPO/git/refs" -f "ref=refs/tags/$T" -f "sha=$SHA" >/dev/null || stop "tag push"
git ls-remote --exit-code origin "refs/tags/$T" >/dev/null || stop "tag not on the remote"

# 3. Images.
ok=0
for _ in $(seq 1 10); do gh workflow run -R "$REPO" images.yml --ref "$T" 2>/dev/null && { ok=1; break; }; sleep 60; done
[ $ok = 1 ] || stop "images dispatch"
id=""
for _ in $(seq 1 20); do
	sleep 15
	id=$(gh run list -R "$REPO" --workflow images.yml --limit 5 --json databaseId,headBranch -q "[.[]|select(.headBranch==\"$T\")][0].databaseId")
	[ -n "$id" ] && break
done
[ -n "$id" ] || stop "no images run"
until s=$(gh run view -R "$REPO" "$id" --json status,conclusion -q '.status+" "+.conclusion' 2>/dev/null) && [[ $s == completed* ]]; do sleep 30; done
echo "images $s"
[[ $s == *success ]] || stop "image build: gh run view -R $REPO $id --log-failed"

# 4. Pullable with no registry login.
anon=$(mktemp -d) && echo '{}' >"$anon/config.json"
owner=${REPO%%/*}
DOCKER_CONFIG=$anon docker manifest inspect "ghcr.io/${owner,,}/cerea:$V" >/dev/null ||
	stop "image not pullable anonymously"
rm -rf "$anon"
echo "anonymous pull OK"

# 5. Fresh-kit test.
log=$(mktemp)
scripts/release/fresh-kit-check.sh "$T" >"$log" 2>&1
grep -qx E2E_OK "$log" || { tail -30 "$log"; stop "fresh-kit test (full log: $log)"; }
grep -E "^(chat|gateway) " "$log"
echo E2E_OK

# 6. stable, then the GitHub release from the changelog entry.
gh api -X PATCH "repos/$REPO/git/refs/heads/stable" -f "sha=$SHA" >/dev/null || stop "stable"
[ "$(git ls-remote origin refs/heads/stable | cut -c1-40)" = "$SHA" ] || stop "stable not moved"
echo "stable -> $T"
notes=$(mktemp)
git show "$SHA:kit/CHANGELOG.md" | awk -v t="## $T " 'index($0,t)==1{f=1;next} /^## v/{f=0} f' >"$notes"
gh release create -R "$REPO" "$T" --title "$T" --notes-file "$notes" --verify-tag || stop "GitHub release"
rm -f "$notes"
echo "released $T"
