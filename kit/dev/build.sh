#!/usr/bin/env bash
# Build the stack's images from source, and point .env at them.
#
#   dev/build.sh                       the Pystino and Cerea commits compose.yaml pins
#   dev/build.sh --pystino-ref main --cerea-ref 1a2b3c4d
#   dev/build.sh --ner                 also the NER redaction image (never published)
#   dev/build.sh --reset               drop the overrides: back to the pinned images
#
# For development, and for running before the images are published. An
# operator installing a release never needs it.
#
# What it does:
#   1. clones Pystino and Cerea into dev/src/ (or fetches, if already there)
#      and checks out the refs: by default the ones compose.yaml pins, where
#      tag `sha-<hex>` means commit <hex> and tag `X.Y.Z` means git tag vX.Y.Z;
#   2. builds each image only when `local/<name>:sha-<7>` is missing; an image
#      already built from the same commit (its org.opencontainers.image.revision
#      label names it) is re-tagged instead of rebuilt;
#   3. writes PYSTINO_REGISTRY/PYSTINO_VERSION/CEREA_REGISTRY/CEREA_VERSION
#      into .env through ./configure --set, so `docker compose up -d` runs them.
#
# Only the images .env's COMPOSE_PROFILES need are built (gateway always,
# redaction with the redaction profile, cerea with the chat profile); --all
# builds every one. Scratch files go to dev/src/tmp, not /tmp.
#
# Environment:
#   PYSTINO_REPO, CEREA_REPO   clone URLs (default: github.com/paoloviviani/…)
#   BUILD_LOCK                 a file to `flock` around each docker build, for
#                              hosts that serialise heavy jobs
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/dev/src"
PYSTINO_REPO=${PYSTINO_REPO:-https://github.com/paoloviviani/Pystino.git}
CEREA_REPO=${CEREA_REPO:-https://github.com/paoloviviani/Cerea.git}

pystino_ref="" cerea_ref="" ner=0 all=0 reset=0 write_env=1
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case $1 in
    --pystino-ref) pystino_ref=${2:?}; shift 2 ;;
    --cerea-ref) cerea_ref=${2:?}; shift 2 ;;
    --ner) ner=1; shift ;;
    --all) all=1; shift ;;
    --reset) reset=1; shift ;;
    --no-env) write_env=0; shift ;;
    -h|--help) usage 0 ;;
    *) echo "build.sh: unknown argument $1" >&2; usage 2 >&2 ;;
  esac
done

say() { printf 'build.sh: %s\n' "$*"; }
die() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

if [ "$reset" = 1 ]; then
  "$ROOT/configure" --unset PYSTINO_REGISTRY PYSTINO_VERSION CEREA_REGISTRY CEREA_VERSION REDACTION_IMAGE
  say "overrides removed: compose.yaml's pinned images apply again"
  exit 0
fi

command -v git >/dev/null || die "needs git"
docker info >/dev/null 2>&1 || die "needs a running Docker daemon"

# --- which refs -----------------------------------------------------------------
pin_to_ref() {  # sha-e251ba7 -> e251ba7 ; 0.2.0 -> v0.2.0
  case $1 in
    sha-*) echo "${1#sha-}" ;;
    [0-9]*.[0-9]*.[0-9]*) echo "v$1" ;;
    *) die "cannot map the pinned tag '$1' to a git ref; pass --pystino-ref/--cerea-ref" ;;
  esac
}
pins=$("$ROOT/tools/pin" --show)
[ -n "$pystino_ref" ] || pystino_ref=$(pin_to_ref "$(sed -n 's/^pystino=//p' <<<"$pins")")
[ -n "$cerea_ref" ] || cerea_ref=$(pin_to_ref "$(sed -n 's/^cerea=//p' <<<"$pins")")

# --- which images ---------------------------------------------------------------
profiles=""
if [ -f "$ROOT/.env" ]; then
  profiles=$(sed -n "s/^COMPOSE_PROFILES=//p" "$ROOT/.env" | tr -d "'\"")
fi
wants() { [ "$all" = 1 ] || [ -z "$profiles" ] || [[ ",$profiles," == *",$1,"* ]]; }
build_gateway=1 build_redaction=0 build_cerea=0
wants redaction && build_redaction=1
wants chat && build_cerea=1
[ "$ner" = 1 ] && build_redaction=1

# --- sources --------------------------------------------------------------------
mkdir -p "$SRC/tmp"
export TMPDIR="$SRC/tmp"

checkout() {  # <dir> <url> <ref> -> prints the full commit
  local dir=$1 url=$2 ref=$3
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch -q --tags origin >&2
  else
    # A real clone, never a worktree: Cerea's image build runs git inside the
    # context, and a worktree's .git points outside it.
    git clone -q --no-hardlinks "$url" "$dir" >&2
  fi
  git -C "$dir" -c advice.detachedHead=false checkout -q --detach "$ref" 2>/dev/null \
    || git -C "$dir" -c advice.detachedHead=false checkout -q --detach "origin/$ref" \
    || die "$ref is not a commit, tag or branch of $url"
  [ -z "$(git -C "$dir" status --porcelain)" ] || die "$dir has local changes; the image would not match its commit"
  git -C "$dir" rev-parse HEAD
}

locked() {
  if [ -n "${BUILD_LOCK:-}" ]; then flock "$BUILD_LOCK" "$@"; else "$@"; fi
}

# ensure <image:tag> <full-sha> <docker build args…>: build unless present.
ensure() {
  local image=$1 sha=$2; shift 2
  local repo=${image%:*}
  if docker image inspect "$image" >/dev/null 2>&1; then
    say "$image present"
    return
  fi
  # Built before under another tag, from the same commit? Re-tag it.
  local candidate rev
  while read -r candidate; do
    [ -n "$candidate" ] || continue
    rev=$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$candidate" 2>/dev/null || true)
    if [ ${#rev} -ge 7 ] && [[ $sha == "$rev"* ]]; then
      if [[ $image == *-pattern || $image == *-ner ]] && [[ $candidate != *"${image##*-}" ]]; then continue; fi
      docker tag "$candidate" "$image"
      say "$image re-tagged from $candidate (built from the same commit)"
      return
    fi
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' "$repo" | grep -v ':<none>$' || true)
  say "building $image"
  locked docker build -q --label "org.opencontainers.image.revision=$sha" -t "$image" "$@" >/dev/null || return 1
  say "$image built"
}

p_sha=$(checkout "$SRC/pystino" "$PYSTINO_REPO" "$pystino_ref")
p_tag="sha-${p_sha:0:7}"
say "Pystino $pystino_ref = ${p_sha:0:12}"

ensure "local/pystino-gateway:$p_tag" "$p_sha" \
  --build-arg INCLUDE_CONSOLE=true --build-arg CONSOLE_BUILD_SHA="${p_sha:0:7}" \
  -f "$SRC/pystino/apps/gateway/Dockerfile" "$SRC/pystino"
if [ "$build_redaction" = 1 ]; then
  ensure "local/pystino-redaction:$p_tag-pattern" "$p_sha" \
    --build-arg SPACY_MODELS= -f "$SRC/pystino/services/redaction/Dockerfile" "$SRC/pystino"
fi
if [ "$ner" = 1 ]; then
  ensure "local/pystino-redaction:$p_tag-ner" "$p_sha" \
    --build-arg SPACY_MODELS=en_core_web_lg -f "$SRC/pystino/services/redaction/Dockerfile" "$SRC/pystino"
fi

env_items=(PYSTINO_REGISTRY=local "PYSTINO_VERSION=$p_tag")
[ "$ner" = 1 ] && env_items+=("REDACTION_IMAGE=local/pystino-redaction:$p_tag-ner")

if [ "$build_cerea" = 1 ]; then
  c_sha=$(checkout "$SRC/cerea" "$CEREA_REPO" "$cerea_ref")
  c_tag="sha-${c_sha:0:7}"
  say "Cerea $cerea_ref = ${c_sha:0:12}"
  # The chat's base path is compile-time: the image serves /chat and nothing else.
  # One retry: its `npm ci` step has died once under memory pressure.
  if ! ensure "local/cerea:$c_tag" "$c_sha" \
      --build-arg APP_BASE=/chat --build-arg PUBLIC_COMMIT_SHA="${c_sha:0:8}" "$SRC/cerea"; then
    say "cerea build failed; retrying once"
    ensure "local/cerea:$c_tag" "$c_sha" \
      --build-arg APP_BASE=/chat --build-arg PUBLIC_COMMIT_SHA="${c_sha:0:8}" "$SRC/cerea"
  fi
  env_items+=(CEREA_REGISTRY=local "CEREA_VERSION=$c_tag")
fi

if [ "$write_env" = 1 ]; then
  [ -f "$ROOT/.env" ] || die "no .env yet: run ./configure first, then dev/build.sh"
  "$ROOT/configure" --set "${env_items[@]}"
  say "wrote ${env_items[*]} into .env"
else
  say "not touching .env; the overrides would be: ${env_items[*]}"
fi
say "next: docker compose up -d --wait"
