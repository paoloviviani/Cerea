#!/usr/bin/env bash
# Build the stack's images from source, and point .env at them.
#
#   dev/build.sh                       the Pystino and Cerea commits compose.yaml pins
#   dev/build.sh --pystino-ref main --cerea-ref 1a2b3c4d
#   dev/build.sh --ner                 also the NER redaction image (never published)
#   dev/build.sh --ner --ner-models "it_core_news_md" --redaction-only
#                                      only the NER redaction image, with other models
#   dev/build.sh --docling             only the Docling extractor image (built locally)
#   dev/build.sh --ocr                 only the OCR extractor image (built locally)
#   dev/build.sh --dry-run ...         print what would be built and written, then stop
#   dev/build.sh --reset               drop the overrides: back to the pinned images
#
# For development, and for running before the images are published. An
# operator installing a release never needs it.
#
# --ner-models "<models>"  space-separated spaCy models for the NER image
#   (default en_core_web_lg; the medium it_core_news_md / en_core_web_md need
#   Pystino 0.30.0 or later). The models are recorded in an image label, so an
#   image built with other models is never reused.
# --redaction-only  builds only the NER redaction image (implies --ner), from the
#   Pystino ref compose.yaml pins, and writes only REDACTION_IMAGE to .env: the
#   gateway and chat stay on their pinned published images.
#
# --docling  builds only the Docling document-reader image
#   (pystino-redaction:<sha>-docling: layout, tables, RapidOCR; about 4 GB), from
#   the Pystino ref compose.yaml pins, and writes only EXTRACTOR_IMAGE to .env.
#   The build prints the weights' licences: the table-structure model is under
#   CDLA-Permissive-2.0 (permissive, redistributable), and the image carries
#   its text and a NOTICE.md. Built locally for now; it may be published later.
#   It is a separate image from the NER redaction one (the extractor needs no
#   spaCy, and the redaction service no torch), so
#   `--docling --ner` builds both and writes both lines. Then
#   `./configure --extractor docling` switches the engine on.
# --ocr  the same for the OCR variant (RapidOCR for scans; all Apache-2.0).
#
# What it does:
#   1. clones Pystino and Cerea into dev/src/ (or fetches, if already there)
#      and checks out the refs: by default the ones compose.yaml pins, where
#      tag `sha-<hex>` means commit <hex> and tag `X.Y.Z` means git tag vX.Y.Z;
#   2. builds each image only when `local/<name>:sha-<7>` is missing; an image
#      already built from the same commit (its org.opencontainers.image.revision
#      label names it) is re-tagged instead of rebuilt;
#   3. writes PYSTINO_REGISTRY/PYSTINO_VERSION/CEREA_REGISTRY/CEREA_VERSION
#      into .env through ./configure --set, so `docker compose up -d` runs them, with
#      a matching <NAME>_PULL_POLICY=never so `docker compose pull` skips local/ images.
#
# Only the images .env's COMPOSE_PROFILES need are built (gateway always;
# compose.yaml says which profile takes which image: redaction for the
# redaction and documents profiles, cerea and cerea-documents for chat); --all builds every one.
# A ref names the remote branch first, then a tag, then a commit. Scratch files go to dev/src/tmp, not /tmp.
#
# Environment:
#   PYSTINO_REPO, CEREA_REPO   clone URLs (default: github.com/paoloviviani/…)
#   BUILD_LOCK                 a file to `flock` around each docker build, for
#                              hosts that serialise heavy jobs
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/dev/build-lib.sh"
SRC="$ROOT/dev/src"
PYSTINO_REPO=${PYSTINO_REPO:-https://github.com/paoloviviani/Pystino.git}
CEREA_REPO=${CEREA_REPO:-https://github.com/paoloviviani/Cerea.git}

pystino_ref="" cerea_ref="" ner=0 ner_models="en_core_web_lg" redaction_only=0 dry_run=0 all=0 reset=0 write_env=1
docling=0 ocr=0
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case $1 in
    --pystino-ref) pystino_ref=${2:?}; shift 2 ;;
    --cerea-ref) cerea_ref=${2:?}; shift 2 ;;
    --ner) ner=1; shift ;;
    --ner-models) ner_models=${2:?}; shift 2 ;;
    --redaction-only) redaction_only=1; ner=1; shift ;;
    --docling) docling=1; shift ;;
    --ocr) ocr=1; shift ;;
    --dry-run) dry_run=1; shift ;;
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
  "$ROOT/configure" --unset PYSTINO_REGISTRY PYSTINO_VERSION CEREA_REGISTRY CEREA_VERSION REDACTION_IMAGE EXTRACTOR_IMAGE \
    GATEWAY_PULL_POLICY REDACTION_PULL_POLICY EXTRACTOR_PULL_POLICY CEREA_PULL_POLICY DOCUMENTS_PULL_POLICY SANDBOX_PULL_POLICY
  say "overrides removed: compose.yaml's pinned images apply again"
  exit 0
fi

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
# compose.yaml says which profile needs which local image.
build_gateway=1 build_redaction=0 build_cerea=0 build_documents=0 build_sandbox=0
while read -r prof anchor; do
  wants "$prof" || continue
  case $anchor in
    gateway-image) build_gateway=1 ;;
    redaction-image) build_redaction=1 ;;
    extractor-image) build_redaction=1 ;;
    cerea-image) build_cerea=1 ;;
    documents-image) build_documents=1 ;;
    sandbox-image) build_sandbox=1 ;;
  esac
done < <(profile_images "$ROOT/compose.yaml")
[ "$ner" = 1 ] && build_redaction=1
# Each of these names the images it wants and nothing else (with --ner, the NER one too).
if [ "$redaction_only" = 1 ] || [ "$docling" = 1 ] || [ "$ocr" = 1 ]; then
  build_gateway=0 build_cerea=0 build_documents=0 build_sandbox=0
  [ "$ner" = 1 ] || [ "$redaction_only" = 1 ] || build_redaction=0
fi
only=0
{ [ "$redaction_only" = 1 ] || [ "$docling" = 1 ] || [ "$ocr" = 1 ]; } && only=1
[ "$ner" = 1 ] || [ "$ner_models" = en_core_web_lg ] || die "--ner-models needs --ner"

if [ "$dry_run" = 1 ]; then
  say "dry run: Pystino ref $pystino_ref, Cerea ref $cerea_ref"
  say "would build: gateway=$build_gateway redaction-pattern=$([ "$only" = 1 ] && echo 0 || echo "$build_redaction") ner=$ner docling=$docling ocr=$ocr cerea=$build_cerea documents=$build_documents"
  [ "$docling" = 1 ] && say "would write EXTRACTOR_IMAGE=local/pystino-redaction:<sha>-docling into .env$([ "$ner" = 1 ] && echo " and REDACTION_IMAGE" || echo " and nothing else") (weights licences printed at build)"
  [ "$ocr" = 1 ] && say "would write EXTRACTOR_IMAGE=local/pystino-redaction:<sha>-ocr into .env$([ "$ner" = 1 ] && echo " and REDACTION_IMAGE" || echo " and nothing else")"
  [ "$ner" = 1 ] && say "NER models: $ner_models"
  [ "$redaction_only" = 1 ] && say "would write only REDACTION_IMAGE=local/pystino-redaction:<sha>-ner into .env"
  exit 0
fi

command -v git >/dev/null || die "needs git"
docker info >/dev/null 2>&1 || die "needs a running Docker daemon"

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
  local want
  want=$(resolve_ref "$dir" "$ref") || die "$ref is not a commit, tag or branch of $url"
  git -C "$dir" -c advice.detachedHead=false checkout -q --detach "$want"
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
  # An NER image is only the same image when it holds the same models.
  local want_models="" have
  if [[ $image == *-ner ]]; then want_models=$ner_models; fi
  models_ok() {
    [ -z "$want_models" ] && return 0
    have=$(docker image inspect -f '{{ index .Config.Labels "dev.cerea.spacy-models" }}' "$1" 2>/dev/null || true)
    [ "$have" = "$want_models" ]
  }
  if docker image inspect "$image" >/dev/null 2>&1 && models_ok "$image"; then
    say "$image present"
    return
  fi
  # Built before under another tag, from the same commit? Re-tag it.
  local candidate rev
  while read -r candidate; do
    [ -n "$candidate" ] || continue
    rev=$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$candidate" 2>/dev/null || true)
    if [ ${#rev} -ge 7 ] && [[ $sha == "$rev"* ]]; then
      if [[ $image == *-pattern || $image == *-ner || $image == *-docling || $image == *-ocr ]] && [[ $candidate != *"${image##*-}" ]]; then continue; fi
      models_ok "$candidate" || continue
      docker tag "$candidate" "$image"
      say "$image re-tagged from $candidate (built from the same commit)"
      return
    fi
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' "$repo" | grep -v ':<none>$' || true)
  say "building $image"
  local extra=()
  [ -z "$want_models" ] || extra=(--label "dev.cerea.spacy-models=$want_models")
  locked docker build -q --label "org.opencontainers.image.revision=$sha" "${extra[@]}" -t "$image" "$@" >/dev/null || return 1
  say "$image built"
}

p_sha=$(checkout "$SRC/pystino" "$PYSTINO_REPO" "$pystino_ref")
p_tag="sha-${p_sha:0:7}"
say "Pystino $pystino_ref = ${p_sha:0:12}"
if [ "$docling$ocr" != 00 ] && ! grep -q '^ARG EXTRACTOR=' "$SRC/pystino/services/redaction/Dockerfile"; then
  die "Pystino $pystino_ref predates the extractor variants (no EXTRACTOR build argument); pass --pystino-ref with a newer ref"
fi

if [ "$build_gateway" = 1 ]; then
  ensure "local/pystino-gateway:$p_tag" "$p_sha" \
    --build-arg INCLUDE_CONSOLE=true --build-arg CONSOLE_BUILD_SHA="${p_sha:0:7}" \
    -f "$SRC/pystino/apps/gateway/Dockerfile" "$SRC/pystino"
fi
if [ "$build_redaction" = 1 ] && [ "$only" = 0 ]; then
  ensure "local/pystino-redaction:$p_tag-pattern" "$p_sha" \
    --build-arg SPACY_MODELS= -f "$SRC/pystino/services/redaction/Dockerfile" "$SRC/pystino"
fi
if [ "$ner" = 1 ]; then
  ensure "local/pystino-redaction:$p_tag-ner" "$p_sha" \
    --build-arg SPACY_MODELS="$ner_models" -f "$SRC/pystino/services/redaction/Dockerfile" "$SRC/pystino"
fi

# The document reader's variants: a separate image from the redaction service's,
# which needs no torch (and the reader no spaCy). Built with no spaCy models.
if [ "$ocr" = 1 ]; then
  ensure "local/pystino-redaction:$p_tag-ocr" "$p_sha" \
    --build-arg SPACY_MODELS= --build-arg EXTRACTOR=ocr \
    --build-arg WEIGHTS_LICENCES="Apache-2.0" -f "$SRC/pystino/services/redaction/Dockerfile" "$SRC/pystino"
fi
if [ "$docling" = 1 ]; then
  cat >&2 <<'NOTICE'

  The Docling image includes model weights under these licences:
    layout (docling-layout-heron) and RapidOCR / PP-OCRv6 ... Apache-2.0
    table structure (docling-models, TableFormer) ... CDLA-Permissive-2.0
      (permissive; its text and a NOTICE.md travel in the image)
  See Pystino docs/extractor-engines.md.

NOTICE
  ensure "local/pystino-redaction:$p_tag-docling" "$p_sha" \
    --build-arg SPACY_MODELS= --build-arg EXTRACTOR=docling \
    --build-arg WEIGHTS_LICENCES="Apache-2.0; CDLA-Permissive-2.0 (TableFormer)" -f "$SRC/pystino/services/redaction/Dockerfile" "$SRC/pystino"
fi

env_items=()
[ "$only" = 1 ] || env_items=(PYSTINO_REGISTRY=local "PYSTINO_VERSION=$p_tag" GATEWAY_PULL_POLICY=never REDACTION_PULL_POLICY=never)
[ "$ner" = 1 ] && env_items+=("REDACTION_IMAGE=local/pystino-redaction:$p_tag-ner" REDACTION_PULL_POLICY=never)
# One extractor image at a time: --docling wins over --ocr if both are given.
[ "$ocr" = 1 ] && env_items+=("EXTRACTOR_IMAGE=local/pystino-redaction:$p_tag-ocr" EXTRACTOR_PULL_POLICY=never)
[ "$docling" = 1 ] && env_items+=("EXTRACTOR_IMAGE=local/pystino-redaction:$p_tag-docling" EXTRACTOR_PULL_POLICY=never)

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
  env_items+=(CEREA_REGISTRY=local "CEREA_VERSION=$c_tag" CEREA_PULL_POLICY=never DOCUMENTS_PULL_POLICY=never SANDBOX_PULL_POLICY=never)
  # The document service lives in the Cerea repository and is versioned with
  # the chat: compose names it cerea-documents:$CEREA_VERSION in the same registry.
  if [ "$build_documents" = 1 ]; then
    ensure "local/cerea-documents:$c_tag" "$c_sha" "$SRC/cerea/documents"
  fi
  # The sandbox manager and its socket proxy (ADR 0115): one image, versioned the same way.
  if [ "$build_sandbox" = 1 ]; then
    ensure "local/cerea-sandbox:$c_tag" "$c_sha" "$SRC/cerea/sandbox"
  fi
fi

if [ "$write_env" = 1 ]; then
  [ -f "$ROOT/.env" ] || die "no .env yet: run ./configure first, then dev/build.sh"
  "$ROOT/configure" --set "${env_items[@]}"
  say "wrote ${env_items[*]} into .env"
else
  say "not touching .env; the overrides would be: ${env_items[*]}"
fi
say "next: docker compose up -d --wait"
