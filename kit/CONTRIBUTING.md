# Contributing and development

cerea-deploy is the deployment kit for [Cerea](https://github.com/paoloviviani/Cerea)
(the chat) and [Pystino](https://github.com/paoloviviani/Pystino) (the gateway
and console): one `compose.yaml`, one documented `.env.example`, the proxy and
identity-provider configuration, and `./configure`. It holds no application
code. The README is the operator's runbook; this file is for changing the kit.

- **Bugs and ideas:** open an issue. For a bug, attach `tools/diagnose`'s
  report (read it first: [Reporting a problem](README.md#reporting-a-problem)).
- **Changes:** open a pull request against `main`, focused on one thing, saying
  what problem it solves and how you checked it.
- **Security issues** go to [SECURITY.md](SECURITY.md), not to a public issue.

By contributing you agree that your contribution is licensed under the Apache
License 2.0, the licence of this repository. The kit contains no third-party
code; it references stock images that its users pull from their publishers.

## Setup

There is nothing to install. The kit has no package manager, no build step, no
formatter, no linter and no git hooks (there is no `.pre-commit-config.yaml`).

| Tool | Version | Used for |
|---|---|---|
| Python | 3.9 or newer (CI runs 3.10) | `./configure`, `tools/pin`, `tools/diagnose` and the tests: standard library only |
| Docker Engine with Compose | Compose 2.24 or newer | `docker compose config`, the tests that start a container, `dev/build.sh`, running a stack |
| `openssl` | any | one Authelia test (skipped without it) |
| PyYAML | any | one Authelia test (skipped without it) |

```sh
git clone https://github.com/paoloviviani/cerea-deploy && cd cerea-deploy
./configure --help        # every flag; ./configure writes .env, never overwrites it
```

Layout:

| Path | What it is |
|---|---|
| `compose.yaml` | the whole stack; every service names an image, nothing builds on `up` |
| `.env.example` | every setting, explained; `./configure` fills it in |
| `configure` | one standard-library Python script: writes `.env`, or checks it (`--check`) |
| `caddy/`, `authelia/`, `proxy.d/` | the proxy's and the identity provider's configuration, mounted read-only into stock images |
| `tools/pin` | keeps the image pins and the `cerea.config-rev` labels in step (see Releasing) |
| `tools/diagnose` | the redacted report operators send with a bug |
| `tools/backup/` | the optional restic backup sidecar, built on the operator's machine |
| `dev/build.sh`, `dev/smoke.yaml` | building the images from source, and a fake upstream for a stack with no real provider |
| `tests/` | the unit tests |

`.env.example` and `./configure` are one interface: a new setting goes into
both, and `tests/test_configure.py` reads `.env.example` as its template. If you
change `caddy/` or `authelia/`, run `tools/pin` afterwards: compose cannot see a
change inside a mounted file, so each of those services carries a digest of its
directory as a label.

## Running a stack from your checkout

```sh
./configure                      # asks a few questions, writes .env (mode 0600)
./configure --check              # reports everything wrong at once; changes nothing
docker compose up -d
```

For a throwaway stack on one machine, a scripted run with Caddy's own
certificate authority works without DNS:

```sh
./configure --non-interactive --origin https://cerea.example.test:8443 \
  --admin-email ops@example.test --tls internal --https-port 8443 \
  --preset homelab --idp authelia
```

The origin's name has to resolve to the machine (an `/etc/hosts` line is
enough), and the bundled Authelia needs a dotted name or an IP address. To run
commits that have no published image yet, `dev/build.sh` clones Pystino and
Cerea into `dev/src/`, builds both images and points `.env` at them;
`dev/build.sh --reset` goes back to the published ones. It builds the chat image
(about 2 GB of memory) and leaves the images in your local Docker, so prune them
when you are done. `docker compose -f compose.yaml -f dev/smoke.yaml up -d --wait`
adds a fake OpenAI-compatible upstream, so the gateway answers `/v1` without a
real provider. On a host that serialises heavy jobs, set `BUILD_LOCK` to a lock
file and `dev/build.sh` takes it around each docker build itself; do not wrap
the script in a `flock` of the same file, which would deadlock.

## Testing

```sh
python3 -m unittest discover -s tests -v     # 149 tests; about three minutes
tools/pin --check                            # exits 1 if a pin or a config label is stale
bash -n dev/build.sh                         # the script parses
```

The unit tests cover `./configure` (answers, `--check`, `--break-glass`, the
identity-provider scopes, the written `.env`), `tools/diagnose`, the backup
sidecar's script, the Authelia configuration and the Caddyfile. The Authelia
and Caddyfile tests start containers and so pull their images the first time,
and one `./configure` test runs `docker compose config`; each skips itself when
`docker` is not on the PATH. A mocked
`docker compose` call in `./configure`'s tests is deliberate: they check what
`./configure` runs, not Docker.

CI runs the same commands plus two configuration checks you can run by hand:

```sh
# compose.yaml resolves with .env.example, for every profile. The example
# leaves each secret empty, which compose refuses, so fill them in a copy:
sed -E "s/^([A-Z_]*(PASSWORD|SECRET|KEY|DIGEST)[A-Z_]*)=''$/\1='ci-placeholder'/" .env.example > .env
COMPOSE_PROFILES=gateway,chat,authelia,redaction,fetch docker compose config -q
PYSTINO_REGISTRY=local PYSTINO_VERSION=ci docker compose -f compose.yaml -f dev/smoke.yaml config -q
rm .env

# the Caddyfile is valid in all three TLS modes
for mode in "https://cerea.example.org|" "https://cerea.example.org|tls internal" "http://:80|"; do
  docker run --rm -v "$PWD/caddy:/etc/caddy:ro" -v "$PWD/proxy.d:/etc/caddy.d:ro" \
    -e SITE_ADDRESS="${mode%%|*}" -e TLS_DIRECTIVE="${mode#*|}" -e PROXY_DEFAULT=gateway \
    caddy:2.11-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
done
```

(Run the first block in a scratch checkout: it writes `.env`.)

A change to `./configure` needs a test in `tests/test_configure.py`, and a change
that a stack must prove, such as one to the proxy, the identity provider or the
bootstrap service, needs a real bring-up. The release procedure below runs one.
A step you could not run is reported as not run, never as passed.

## CI

One workflow, `.github/workflows/check.yml` (`check`), on every push to `main`
and every pull request. It pulls and builds no images of the kit; it runs the
unit tests, `tools/pin --check`, `bash -n dev/build.sh`, the `docker compose
config` resolutions and the Caddyfile validation above. The full bring-up is
Pystino's `stack` workflow, which runs on Pystino's release tags and checks out
this repository's `main`.

## Releasing

A release of the kit names one tested pair: a Pystino release and the Cerea
release it was tested with. The component releases come first: see
[Cerea's](https://github.com/paoloviviani/Cerea/blob/main/CONTRIBUTING.md#releasing)
and
[Pystino's](https://github.com/paoloviviani/Pystino/blob/main/CONTRIBUTING.md#releasing)
guides. When both images are published:

1. **Pin.** `tools/pin --pystino 0.3.2 --cerea 0.4.8`. It rewrites the version
   defaults in `compose.yaml` (`${PYSTINO_VERSION:-…}`, `${CEREA_VERSION:-…}`),
   the commented examples in `.env.example`, and the config labels. Then
   `tools/pin --check`. A `sha-<hex>` tag also works, for a commit with no
   release.
2. **Unit tests:** `python3 -m unittest discover -s tests`.
3. **Fresh-kit test.** In a clean copy of the kit (not your working checkout):
   `./configure` with a scratch origin and project name, `docker compose pull`
   with an empty Docker login (`DOCKER_CONFIG` pointing at an empty directory:
   the images are public), `docker compose up -d --wait`, and a check that the
   running containers carry the new tags. Then a real sign-in through the
   identity provider, the gateway and the chat:
   `uv run python deploy/ci/e2e_login.py <kit dir> <first-sign-in password> --chat`
   from a Pystino checkout prints `E2E_OK` when it works. Remove the scratch
   stack and its volumes and check they are gone.
4. **CHANGELOG.md.** Newest first, one section per release, dated, headed
   `## vX.Y.Z — YYYY-MM-DD`, with a `Pins:` line (Cerea, Pystino, Authelia).
   Say what a person running the kit sees, and any step an upgrade needs on
   their side (re-running the install line on agent machines, pressing Save
   once, and so on).
5. **Commit, tag, push.** The release commit touches `compose.yaml`,
   `.env.example` and `CHANGELOG.md` and is named `vX.Y.Z: Cerea A.B.C (what
   changed)`; the tag is annotated (`vX.Y.Z — Cerea A.B.C, Pystino P.Q.R`).
   Versions are `MAJOR.MINOR.PATCH` and the kit's own: since v0.4.0 they have
   matched the Cerea release pinned, but a kit-only fix (v0.3.6, v0.3.7) takes
   the next patch number with the pins unchanged.

The kit is published as a git tag and nothing else: operators `git pull`, then
`docker compose pull` and `up -d`.

## Documentation

`README.md` is the operator's runbook, and it is also a page of Cerea's
documentation site: Cerea's `docs/deploy-kit.md` includes it, and Cerea's
`docs` workflow downloads this repository's `main` README when it builds. So a
README change reaches the published site at the next Cerea docs build, which a
push to this repository does not trigger; run Cerea's `docs` workflow by hand
for an immediate republish. Keep the README's links absolute (`https://github.com/…`)
for files outside it, because relative ones break on that site. Cerea's
`mkdocs build --strict` fails on a broken anchor, so check the sections you link to.

## Conventions

- **Everything the operator needs is in this repository and readable before it
  runs.** No downloads at `up`, nothing built on `up`, no secret in git. `.env`,
  `compose.override.yaml`, `proxy.d/*.caddy` and `first-sign-in.txt` are git-ignored
  and belong to the operator (see "Adding your own services" in the README).
- **`./configure` never overwrites** an existing `.env`; it keeps secrets and
  unknown keys, and saves the previous file as `.env.bak-<time>`.
- **Standard library only** for `./configure`, `tools/pin` and `tools/diagnose`.
- **`tools/diagnose` must never print a secret.** A new `.env` key shows as
  `<redacted>` unless it is on the short list of version, profile and flag keys.
- **Licences.** Apache-2.0 for everything first-party. A new image or tool is
  named, with its licence, in the README's "Third-party software".
- **Commit messages** carry the reasoning: why, and the failure a decision
  prevents. [AI-DISCLOSURE.md](AI-DISCLOSURE.md) says how this kit was written.
