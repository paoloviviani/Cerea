# Functions dev/build.sh sources; kept apart so kit/tests can exercise them.

# resolve_ref <dir> <ref>: prints the commit a ref means in a fetched clone.
# A branch name means the remote branch (the local one of a reused clone is
# stale), then a tag, then a commit.
resolve_ref() {
  local dir=$1 ref=$2 sha
  for cand in "refs/remotes/origin/$ref" "refs/tags/$ref" "$ref"; do
    if sha=$(git -C "$dir" rev-parse -q --verify "$cand^{commit}" 2>/dev/null); then
      echo "$sha"
      return 0
    fi
  done
  return 1
}

# profile_images <compose.yaml>: lines "<profile> <image-anchor>" for every
# service that has profiles and takes a locally built image (anchor
# gateway-image, redaction-image or cerea-image).
profile_images() {
  awk '
    /^  [A-Za-z0-9_-]+:[ ]*$/ { profs = ""; next }
    /^    profiles:/ { p = $0; sub(/^[^[]*\[/, "", p); sub(/\].*/, "", p); gsub(/[ ]/, "", p); profs = p; next }
    /^    image: \*[a-z]+-image/ {
      a = $2; sub(/^\*/, "", a)
      n = split(profs, ps, ",")
      for (i = 1; i <= n; i++) if (ps[i] != "") print ps[i], a
    }
  ' "$1" | sort -u
}
