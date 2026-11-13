# Releasing

A Cerea tag `vX.Y.Z` is also the deploy kit's version (`kit/`). A change is
released only when all of these pass, in this order:

1. The release commit: version bumped in `package.json`, the kit pinned
   (`kit/tools/pin --cerea X.Y.Z --pystino P.Q.R`, then `--check`, and the kit's
   unit tests), and the entry written in `kit/CHANGELOG.md`.
2. CI green on that commit (`ci` and `kit`). When `agent/` changed, also the
   `opencode` workflow: `release.sh` does not wait for it.
3. Tag (annotated `vX.Y.Z`), then the `images` workflow green, which publishes
   `ghcr.io/paoloviviani/cerea:X.Y.Z`.
4. The image pulls **with no registry login** (`DOCKER_CONFIG` pointing at an
   empty config).
5. The **fresh-kit test**: `kit/get-kit.sh --version vX.Y.Z` into a scratch
   directory, `./configure`, `docker compose pull`, `up -d --wait`, a check that
   the running containers carry the new tags, and a real sign-in through the
   identity provider, the gateway and the chat to `/chat/code`, which must print
   exactly `E2E_OK`. The test stack is then removed and checked gone. Its full
   output is kept at `~/.cache/cerea-release/vX.Y.Z-fresh-kit.log` (override
   with `CEREA_RELEASE_LOG_DIR`), and the release prints its `seeded …` lines,
   so what the check created can be verified after the release.
6. Only then fast-forward the **`stable`** branch to the tag. Operators follow
   `stable` or a tag, never `main`.

Steps 2–6 and the GitHub release are scripted: after pushing the release
commit to `main`, run

```bash
scripts/release/release.sh X.Y.Z
```

It refuses unless `origin/main` carries `package.json` at X.Y.Z and a
`## vX.Y.Z` changelog entry, waits for `ci` and `kit` on that commit, tags,
dispatches `images` and waits for it, checks the anonymous pull, runs
`scripts/release/fresh-kit-check.sh vX.Y.Z` (needs ports 80/443 free, or `HTTP_PORT`/`HTTPS_PORT`/`GATEWAY_PORT` (8000) set to free ones, docker,
`uv`; `KEEP=1` leaves the stack up), moves `stable`, and creates the GitHub
release from the changelog entry. It stops at the first failed step and says
which; a GitHub 5xx on the tag push falls back to the API. Each step's outcome
is printed: read them, a release is done only when the script prints
`released vX.Y.Z`.

A step that cannot run (no browser, no credentials) is reported as not run,
never as passed.
