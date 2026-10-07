# Contributing and development

Thanks for helping. Cerea is small and moves quickly, so a short conversation
first saves work on both sides.

- **Bugs and ideas:** open an issue. For a bug, include what you did, what you
  expected, what happened, and your browser and deployment (a deploy-kit
  preset, or your own setup).
- **Changes:** open a pull request against `main`. Keep it focused on one
  thing, and describe the problem it solves and how you checked it. The
  [Verifying a change](#verifying-a-change) rules below say what "checked"
  means here.
- **Security issues** go to [SECURITY.md](https://github.com/paoloviviani/Cerea/blob/main/SECURITY.md),
  not to a public issue.

By contributing you agree that your contribution is licensed under the
Apache License 2.0, the licence of this repository. Cerea began as a fork of
[huggingface/chat-ui](https://github.com/huggingface/chat-ui) (Apache-2.0) and
is now mostly a hard fork; a dependency must be under an OSI-approved licence.

## Setup

| Tool                             | Version                                                                                              | Used for                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Node                             | 24 (what CI and the image use; `package.json` declares no `engines`)                                 | the app, its tests and its build                                                   |
| npm                              | the one that ships with Node (`package-lock.json` is the lockfile; `package.json` names `npm@9.5.0`) | installing and running scripts                                                     |
| Go                               | 1.24 or newer (`agent/go.mod`)                                                                       | galopin, the machine agent in `agent/`                                             |
| [uv](https://docs.astral.sh/uv/) | recent                                                                                               | the documentation build and the live scripts' helpers                              |
| Docker                           | recent                                                                                               | the image, a real MongoDB for the tests, the Playwright image for the client tests |

```sh
npm ci                    # installs the dependencies and, through `prepare`, the git hooks
cp .env .env.local        # then set OPENAI_BASE_URL, OPENAI_API_KEY and friends
npm run dev               # http://localhost:5173
```

`.env` is tracked and lists every variable the app understands, with comments;
`.env.local` is yours and is ignored by git. `OPENAI_BASE_URL` is required (the
app refuses to start without `${OPENAI_BASE_URL}/models`): a Pystino gateway's
`/v1`, or any OpenAI-compatible endpoint. With `MONGODB_URL` unset the app
starts an in-memory MongoDB, which needs a CPU with AVX; otherwise run a real
one (`docker run -d -p 27017:27017 mongo:4.4`) and set `MONGODB_URL`.
`npm run dev`, `build` and `build:static` first run `npm run sync-pyodide`, which
copies the Pyodide runtime from `node_modules` into `static/pyodide/` (git-ignored).

| Path                                 | What it holds                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/server/`                    | the server: text generation, MCP, knowledge, projects, code panel link                                                                                                               |
| `src/lib/components/`, `src/routes/` | Svelte 5 components and SvelteKit routes                                                                                                                                             |
| `agent/`                             | galopin, in Go: [README](https://github.com/paoloviviani/Cerea/blob/main/agent/README.md) and the [wire protocol](https://github.com/paoloviviani/Cerea/blob/main/agent/PROTOCOL.md) |
| `tests/`                             | the Playwright end-to-end specs and their fixtures and mocks                                                                                                                         |
| `scripts/`                           | the live checks against a running stack, the Pyodide sync, and other tools                                                                                                           |
| `docs/`                              | this documentation site (`docs/source/` is upstream chat-ui's, kept as written and not part of the site)                                                                             |
| `kit/`                               | the deploy kit: `compose.yaml`, `./configure`, `get-kit.sh` (see [Deploy kit](#deploy-kit))                                                                                          |
| `deploy/ci/`                         | the gateway version the contract workflow tests against                                                                                                                              |

The production image fixes SvelteKit's base path at build time and builds
galopin too: `docker build --build-arg APP_BASE=/chat -t cerea .`. The first build
needs about 2 GB of memory. galopin alone: `agent/packaging/build-dist.sh
~/galopin-dist` writes static binaries for Linux and macOS with checksums.

## Git hooks

`npm ci` runs the `prepare` script, which is `husky`: it points git's
`core.hooksPath` at `.husky/_` (generated, git-ignored). The tracked hook is
`.husky/pre-commit`, which runs `npx lint-staged --config ./.husky/lint-stage-config.js`
on the staged files:

| Files                            | What runs, in order                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `*.js`, `*.jsx`, `*.ts`, `*.tsx` | `prettier --write`, `eslint --fix`, then `eslint` (a commit is refused if anything is left) |
| `*.json`                         | `prettier --write`                                                                          |

Nothing else runs on commit: **Svelte, CSS, Markdown and Go files are not touched
by the hook**, and neither is the type check. CI covers them (below), so run
`npx prettier --check <your files>` yourself for anything the hook skips, and
`gofmt` for Go. Merges that skip the hook are why CI also runs on every push to
`main`.

## Formatting and linting

- **Prettier** (`.prettierrc`): tabs, `printWidth` 100, `trailingComma: "es5"`, with
  `prettier-plugin-svelte` and `prettier-plugin-tailwindcss` (Tailwind classes
  are sorted). `.prettierignore` leaves out lockfiles, `mkdocs.yml` (hand-laid
  out), and `src/styles/tokens.css` plus `src/styles/fonts/` (a vendored copy that
  must stay byte-identical: see "The shared tokens").
- **ESLint** (`.eslintrc.cjs`): `eslint:recommended`, `@typescript-eslint/recommended`
  and `svelte/recommended`, with `no-explicit-any` and `no-non-null-assertion` as
  errors, unused variables as errors unless prefixed `_`, and `object-shorthand`.
- **TypeScript** is strict. `npm run check` is `svelte-kit sync && svelte-check`.
- **Svelte 5** with runes (`$state`, `$effect`, `$bindable`); no `any`.
- **Go:** `gofmt` and `go vet`, as below.

```sh
npm run check                    # svelte-kit sync + svelte-check
npm run lint                     # prettier --check . && eslint .   (the whole repository, Markdown included)
npm run format                   # prettier --write .
cd agent && test -z "$(gofmt -l .)" && go vet ./...
```

Those are what CI runs: `npm run lint`, `npm run check`, and in `agent/` the
`gofmt` test, `go vet ./...` and `go test ./...`. There are no known formatting
exceptions: `npm run lint` is clean on `main`. When you change Markdown, run
`npx prettier --check` on it: tables are padded to column width, and the
repository's Markdown is formatted with it.

## Testing

| Layer                          | Command                                                  | What it covers                                                                             |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| server and ssr (Vitest, Node)  | `npm run test` (`vitest --project=server --project=ssr`) | everything under `src/**/*.test.ts` and `*.spec.ts` except components, and `*.ssr.test.ts` |
| client (Vitest, real Chromium) | `npm run test:client` (`vitest --project=client`)        | `src/**/*.svelte.test.ts`: every Svelte component test                                     |
| all three                      | `npm run test:all`                                       |                                                                                            |
| end to end (Playwright)        | `npx playwright test`                                    | `tests/*.spec.ts` on Chromium and WebKit, against a built app and mock services            |
| galopin (Go)                   | `cd agent && go test ./...`                              | unit tests; the real-opencode suite is gated off (below)                                   |
| live scripts                   | `scripts/test_*_live.py`                                 | a running stack                                                                            |

One file or one test: `npx vitest run path/to/file.spec.ts`, `npx vitest run -t "name"`.
`npm run test:coverage` adds a coverage report for the first two projects.

**The server and ssr projects need a MongoDB.** By default each spec starts an
in-memory one (`mongodb-memory-server`), which needs AVX and, on a slim Node
image, `libcurl4`. On a CPU without AVX it dies with `SIGILL`: point the tests at
a real MongoDB (4.4 works) with **`TEST_MONGODB_URL`** (not `MONGODB_URL`, which
the test setup ignores) and run the files serially, because they share that
database and their clean-up helpers would wipe each other's collections:

```sh
docker run -d --name cerea-test-mongo -p 27017:27017 mongo:4.4
TEST_MONGODB_URL=mongodb://127.0.0.1:27017/ npx vitest run --project=server --project=ssr --no-file-parallelism
```

CI does exactly this with a `mongo:8` service container. Known failure modes of
a shared database are environment artefacts, not regressions: conversations that
vanish mid-test, lock counts that are off, a flaky byte-budget replay test.
Re-run a file alone before believing a full-suite failure.

**The client project needs a real browser**, which `npm run test` does not run.
Its Playwright browsers must match the _installed_ Playwright (1.61.1), not the
range in `package.json`, or the project reports "no tests" and an empty
`Serialized Error`. The Playwright container has the right ones:

```sh
docker run --rm -v $PWD:/chat -w /chat --entrypoint /bin/sh \
  mcr.microsoft.com/playwright:v1.61.1-noble \
  -c 'export HOME=/root CI=true; corepack enable; npx vitest run --project=client'
```

On a small machine, running the whole client project in one command can crash
(a benign `SIGILL` or "transport was disconnected" after the summary is
harmless if the exit code is 0): run the files you touched, and let CI run the
rest. A change to shared styles (`tokens.css`, `main.css`, text sizes, spacing)
touches every component test that measures layout: run the whole project.

**End-to-end tests** (`playwright.config.ts`) start their own stack: a MongoDB,
a mock OpenAI upstream, a mock OIDC issuer for machine tokens, a mock MCP server,
and the app through `node server.js`. They run one worker at a time (the database
is shared and wiped between tests), on Chromium and WebKit. The variables:

| Variable                   | Default                                | What it moves                                                                           |
| -------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| `E2E_APP_PORT`             | 5199                                   | the app's port                                                                          |
| `E2E_MONGO_PORT`           | 8790                                   | the MongoDB the run starts, or reuses when something already listens there              |
| `E2E_MONGO_URL`            | `mongodb://127.0.0.1:<E2E_MONGO_PORT>` | a MongoDB you started yourself                                                          |
| `E2E_DB_NAME`              | `chat-ui-e2e`                          | the database name                                                                       |
| `E2E_APP_BASE`             | empty                                  | the base path (`/chat` to match the image); the build is per base                       |
| `E2E_SKIP_BUILD`           | unset                                  | `1` serves an existing `build/` as is; it must have been built with the same `APP_BASE` |
| `E2E_GALOPIN_DIST_DIR`     | `~/.cache/galopin-e2e/dist-<port>`     | where the galopin download spec builds into                                             |
| `E2E_WEBSERVER_TIMEOUT_MS` | 600000                                 | how long to wait for the app                                                            |
| `MOCK_OIDC_PORT`           | 8796                                   | the mock issuer                                                                         |
| `PLAYWRIGHT_WORKERS`       | 1                                      | more than one needs per-conversation scoping first                                      |

On a small machine, build once on its own and then run against that build, so
the build and the browsers do not compete for memory:

```sh
npm run build
E2E_SKIP_BUILD=1 npx playwright test --project=chromium
# without AVX, start a real MongoDB on the port the run expects first:
docker run -d --name e2e-mongo -p 127.0.0.1:8790:27017 mongo:4.4
```

WebKit may not be installed locally ("Executable doesn't exist" means the browser,
not your change): run `--project=chromium` and leave WebKit to CI. Root-owned
`dist/` or `test-results/` left by a container break builds with `EACCES`; build to
another `--outDir` or `chown` them back with a throwaway container. Two
composer-mobile "ring" end-to-end tests are known to fail on `main`.

**galopin (Go).** `cd agent && go test ./...` runs the unit tests. The suite
that matters for releases drives a **real opencode** and is off unless you set
both gates; the opencode release must be the pinned one:

```sh
npm i -g opencode-ai@$(cat agent/packaging/opencode-version)
cd agent && GALOPIN_OPENCODE_IT=1 GALOPIN_ACP_IT=1 go test -count=1 -v -timeout 25m ./...
```

(CI first sets a global git identity, `git config --global user.name ci` and `user.email ci@example.invalid`; do the same if your machine has none.) The
`opencode` workflow counts a test that skipped itself for lack of a gate as not
passed.

**The opencode pin pipeline.** The opencode release galopin is built and tested
against is written once, in `agent/packaging/opencode-version` (1.18.34 today).
galopin embeds it, CI installs it, and the pairing dialog's install line
(`OPENCODE_VERSION` in `src/lib/codeEnrollCommand.ts`) must equal it:
`codeEnrollCommand.spec.ts` fails if not. The `opencode` workflow runs the whole
real-opencode suite on the pin, and every day on opencode's newest release, which
opens or updates one issue labelled `opencode-pipeline` ("opencode X breaks
galopin", or "ready to bump the pin"). To move the pin:

```sh
agent/packaging/bump-opencode.sh 1.18.35     # rewrites both places and prints the commands to run
```

Run the printed commands (the full suite under that opencode, then the TypeScript
spec), skim opencode's release notes for permission names or events the suite
cannot see, update prose that names the release (`docs/agent-machines.md`,
`agent/PROTOCOL.md`), and commit. Pystino's setup script names the same release
(`opencode_pin` in its `opencode-install.sh`) and is **not** moved by this script:
change it in the Pystino repository too.

**Live scripts** (their only third-party dependency is `httpx`) run against a real
stack and sign in through its identity provider. They are worth running for anything touching the generation path,
project context, the knowledge pipeline or the gateway forwarder, because they
assert on what actually left the gateway, which no unit test can see:

```sh
set -a; . /path/to/cerea/kit/.env; set +a        # the running stack's variables
uv run --with httpx python scripts/test_projects_live.py       # projects: context, retrieval, memory
uv run --with httpx python scripts/test_attachments_live.py    # a document attachment, extracted once
uv run --with httpx python scripts/test_nav_live.py            # the sidebar tree, and signing out for real
uv run --with httpx python scripts/test_admin_panel_live.py    # the admin surfaces, and who may see them
uv run --with httpx python scripts/test_connectors_live.py     # MCP connector OAuth, against a real provider
```

(The first turn of a conversation also generates its title, a second completion
that overwrites the smoke upstream's last request: an assertion about the prompt
has to run on a later turn.)

## Deploy kit

`kit/` is the deployment kit for Cerea (the chat) and [Pystino](https://github.com/paoloviviani/Pystino)
(the gateway and console): one `compose.yaml`, one documented `.env.example`, the proxy and
identity-provider configuration, `./configure`, and `get-kit.sh`, which installs it. It holds
no application code. [`kit/README.md`](https://github.com/paoloviviani/Cerea/blob/main/kit/README.md)
is the operator's runbook; this section is for changing the kit. The kit used to be the
`cerea-deploy` repository and moved here with its history (`git log --follow kit/<file>`
reaches back through it). **One version:** a Cerea tag `vX.Y.Z` is the kit's version, and its
changelog is `kit/CHANGELOG.md`.

The kit has no package manager, no build step, no formatter, no linter and no git hooks of its
own, and Prettier skips `kit/` (`.prettierignore`). Work from inside `kit/`:

| Tool                       | Version                     | Used for                                                                                       |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| Python                     | 3.9 or newer (CI runs 3.10) | `./configure`, `tools/pin`, `tools/diagnose` and the tests: standard library only              |
| Docker Engine with Compose | Compose 2.24 or newer       | `docker compose config`, the tests that start a container, `dev/build.sh`, running a stack     |
| `git`, a POSIX `sh`        | any                         | `get-kit.sh` and its tests                                                                     |
| `openssl`, PyYAML          | any                         | one Authelia test each (skipped without them)                                                  |
| ShellCheck                 | recent                      | `get-kit.sh` (`docker run --rm -v $PWD:/mnt:ro -w /mnt koalaman/shellcheck:stable get-kit.sh`) |

| Path (under `kit/`)               | What it is                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `compose.yaml`                    | the whole stack; every service names an image, nothing builds on `up`                                  |
| `.env.example`                    | every setting, explained; `./configure` fills it in                                                    |
| `configure`                       | one standard-library Python script: writes `.env`, or checks it (`--check`)                            |
| `get-kit.sh`                      | installs, upgrades (`--upgrade`) and migrates (`--from`) a kit as a sparse checkout of this repository |
| `caddy/`, `authelia/`, `proxy.d/` | the proxy's and the identity provider's configuration, mounted read-only into stock images             |
| `tools/pin`                       | keeps the image pins and the `cerea.config-rev` labels in step (see Releasing)                         |
| `tools/diagnose`                  | the redacted report operators send with a bug                                                          |
| `tools/backup/`                   | the optional restic backup sidecar, built on the operator's machine                                    |
| `dev/build.sh`, `dev/smoke.yaml`  | building the images from source, and a fake upstream for a stack with no real provider                 |
| `tests/`                          | the unit tests                                                                                         |

**The operator's directory is `<dir>/kit`.** `get-kit.sh` makes `<dir>` a shallow, blob-filtered,
sparse git checkout (only `kit/` is present) and the operator `cd`s into `<dir>/kit`, where
`./configure`, `.env` and every `docker compose` command live. Nothing in the kit depends on the
directory's name: the compose project name is `COMPOSE_PROJECT_NAME` (default `cerea`), never the
directory's. `.env`, `.env.bak-*`, `compose.override.yaml`, `proxy.d/*.caddy` and
`first-sign-in.txt` are git-ignored and belong to the operator; an upgrade (a `git checkout` of
the next tag) never touches them.

`.env.example` and `./configure` are one interface: a new setting goes into both, and
`tests/test_configure.py` reads `.env.example` as its template. If you change `caddy/` or
`authelia/`, run `tools/pin` afterwards: compose cannot see a change inside a mounted file, so each
of those services carries a digest of its directory as a label.

```sh
cd kit
./configure                      # asks a few questions, writes .env (mode 0600)
./configure --check              # reports everything wrong at once; changes nothing
docker compose up -d
```

For a throwaway stack on one machine, a scripted run with Caddy's own certificate authority works
without DNS:

```sh
./configure --non-interactive --origin https://cerea.example.test:8443 \
  --admin-email ops@example.test --tls internal --https-port 8443 \
  --preset homelab --idp authelia --project scratch
```

The origin's name has to resolve to the machine (an `/etc/hosts` line is enough), and the bundled
Authelia needs a dotted name or an IP address. Give a scratch stack its own `--project`, and
remove it (`docker compose down -v`) when you are done. To run commits that have no published
image yet, `dev/build.sh` clones Pystino and Cerea into `dev/src/`, builds both images and points
`.env` at them; `dev/build.sh --reset` goes back to the published ones. It builds the chat image
(about 2 GB of memory) and leaves the images in your local Docker, so prune them when you are
done. `docker compose -f compose.yaml -f dev/smoke.yaml up -d --wait` adds a fake
OpenAI-compatible upstream, so the gateway answers `/v1` without a real provider. On a host that
serialises heavy jobs, set `BUILD_LOCK` to a lock file and `dev/build.sh` takes it around each
docker build itself; do not wrap the script in a `flock` of the same file, which would deadlock.

**Testing the kit:**

```sh
cd kit
python3 -m unittest                          # 167 tests; several minutes (some start containers)
tools/pin --check                            # exits 1 if a pin or a config label is stale
bash -n dev/build.sh && sh -n get-kit.sh     # the scripts parse
```

The unit tests cover `./configure` (answers, `--check`, `--break-glass`, the identity-provider
scopes, the written `.env`), `get-kit.sh` (against a throwaway local repository: install, the
newest-tag rule, upgrade, migration, every refusal), `tools/diagnose`, the backup sidecar's
script, the Authelia configuration and the Caddyfile. The Authelia and Caddyfile tests start
containers and so pull their images the first time, and one `./configure` test runs `docker
compose config`; each skips itself when `docker` is not on the PATH. A mocked `docker compose`
call in `./configure`'s tests is deliberate: they check what `./configure` runs, not Docker.

The `kit` workflow runs the same commands, plus two configuration checks you can run by hand
(run the first block in a scratch copy: it writes `.env`):

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

A change to `./configure` needs a test in `kit/tests/test_configure.py`; a change to `get-kit.sh`
one in `kit/tests/test_get_kit.py`; and a change that a stack must prove, such as one to the
proxy, the identity provider or the bootstrap service, needs a real bring-up, which
[Releasing](#releasing) runs. A step you could not run is reported as not run, never as passed.

**Conventions for the kit:**

- **Everything the operator needs is in `kit/` and readable before it runs.** No downloads at
  `up`, nothing built on `up`, no secret in git.
- **`get-kit.sh` is POSIX `sh` and needs only `git`.** It is served from the `stable` branch
  (`https://raw.githubusercontent.com/paoloviviani/Cerea/stable/kit/get-kit.sh`), so a bug in it
  reaches every installer: keep it ShellCheck-clean, never let it run docker, and never let it
  write into a directory it did not create (the tests hold it to both).
- **`./configure` never overwrites** an existing `.env`; it keeps secrets and unknown keys, and
  saves the previous file as `.env.bak-<time>`.
- **Standard library only** for `./configure`, `tools/pin` and `tools/diagnose`.
- **`tools/diagnose` must never print a secret.** A new `.env` key shows as `<redacted>` unless it
  is on the short list of version, profile and flag keys.
- **A new image or tool** is named, with its licence, in the README's "Third-party software".
- **The kit's README is also a page of this documentation site** (see [Documentation](#documentation)).

## Verifying a change

[AGENTS.md](https://github.com/paoloviviani/Cerea/blob/main/AGENTS.md) has the
full rules under "Verifying a change". In short:

- **Run what the change touches, then the gates:** `npm run check`, `npm run lint`
  (or `npx prettier --check` on the files you changed), the server tests for the
  area, and the client tests for any component you changed.
- **A new test must fail without the fix.** Put the fix aside (`git stash push
<the fixed file>`), run the test and see it fail, then restore the fix. A test
  that passes either way proves nothing.
- **A failure is "pre-existing" only once it fails on `main` too.** Rebuild `main`
  without your change and run the same test there. Failing on both: pre-existing,
  say so. Failing only on your branch: yours, however unrelated it looks.
- **End-to-end tests run against a fresh build** (`npm run build`, then
  `E2E_SKIP_BUILD=1`), never a stale `build/`.
- **Screenshots for UI changes.** Tests prove behaviour; a person judges a visual
  change from the real app at desktop (1440) and phone (390) widths, in light and
  dark when colour changes, compared side by side with the old one. Overflow is
  checked by measurement, not by eye. The throwaway Playwright spec that takes them
  is never committed.
- **Heavy runs one at a time** on a small machine: a build, Playwright and the full
  suites do not run together, and a script that takes a lock itself is not wrapped
  in another.
- **Say what you ran.** A step that could not run (no browser, no credentials) is
  reported as not run, never as passed.

## CI

Six workflows in `.github/workflows/`.

| Workflow   | Runs on                                                                                                                                                    | What it does                                                                                                                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci`       | every push to `main` and every pull request (changes to `docs/**`, `kit/**` and `*.md` are ignored), manual runs, and Mondays 04:41 UTC for the client job | **check** (not on the schedule): `npm ci`, `npm run lint`, `npm run check`, then the server and ssr projects against a `mongo:8` service, serially. **go** (not on the schedule): `gofmt`, `go vet`, `go test` in `agent/`. **client** (push, manual and schedule, not on pull requests): the client project in the Playwright container. |
| `opencode` | a push to `main` touching `agent/**`, weekly (pinned), daily (latest), manual                                                                              | the whole real-opencode suite against the pinned opencode (`pinned`), and against opencode's newest release (`latest`), which opens or updates an issue                                                                                                                                                                                   |
| `images`   | manual only (`workflow_dispatch`)                                                                                                                          | builds the image with `APP_BASE=/chat` and pushes it to `ghcr.io/paoloviviani/cerea`; on a `v*.*.*` tag it publishes `X.Y.Z` and `X.Y`, and refuses to overwrite a version that exists                                                                                                                                                    |
| `docs`     | a push to `main` touching `docs/**`, `mkdocs.yml` or `kit/README.md`, and manual                                                                           | `mkdocs build --strict`, published to GitHub Pages at <https://paoloviviani.github.io/Cerea/>                                                                                                                                                                                                                                             |
| `contract` | a pull request touching the gateway-facing code or the pin, Mondays 05:23 UTC (against `edge`, non-blocking), manual                                       | this chat's assumptions about Pystino's API, checked against a gateway image (`deploy/ci/pystino-contract.env` names the version)                                                                                                                                                                                                         |
| `kit`      | a push to `main` or a pull request touching `kit/**`, and manual                                                                                           | the deploy kit, run from `kit/`: its unit tests, `tools/pin --check`, `bash -n dev/build.sh`, `docker compose config` with `.env.example` for every profile, the Caddyfile in all three TLS modes, and `get-kit.sh` under `sh -n` and ShellCheck. No images are pulled or built                                                           |

End-to-end Playwright is not in CI: run it yourself for UI and flow changes.
`ci` ignores documentation-only changes, so a Markdown change runs no tests; the
`docs` workflow is the check for it.

## Releasing

A release of Cerea is a release of the deploy kit: one tag, `vX.Y.Z`. A step that cannot run is
reported as not run, never as passed. Pystino releases first (see
[its guide](https://github.com/paoloviviani/Pystino/blob/main/CONTRIBUTING.md#releasing)); the kit
pins the Pystino version it was tested with. Then, in this order:

1. **The release commit** (`release: vX.Y.Z`) does three things:
   - bumps the version in `package.json` and `package-lock.json`;
   - pins the kit: `kit/tools/pin --cerea X.Y.Z --pystino P.Q.R`, then `kit/tools/pin --check`.
     It rewrites the version defaults in `kit/compose.yaml`, the commented examples in
     `kit/.env.example` and the config labels. Run the kit's unit tests too
     (`cd kit && python3 -m unittest`);
   - writes the changelog entry in `kit/CHANGELOG.md`: newest first, headed
     `## vX.Y.Z — YYYY-MM-DD`, with a `Pins:` line (Cerea, Pystino, Authelia), saying what a person
     running the kit sees and any step an upgrade needs on their side (re-running the install line
     on agent machines, pressing Save once, and so on).
2. **CI green** on that commit: `ci` and `kit` run on every push to `main`; push, then wait.
3. **Tag** it, annotated, `vX.Y.Z` (message `vX.Y.Z — Cerea X.Y.Z, Pystino P.Q.R`), and push the
   tag. Tags are never moved.
4. **The `images` workflow** on the tag: `gh workflow run images.yml --ref vX.Y.Z`, then wait for
   green. It publishes `ghcr.io/paoloviviani/cerea:X.Y.Z` (and `:X.Y`); the package is public.
5. **Anonymous pull:** `docker pull` of the Cerea image and of the Pystino images the kit pins,
   with `DOCKER_CONFIG` pointing at an empty directory.
6. **Fresh-kit end-to-end test**, from the tag, the way an operator gets it:
   `get-kit.sh --repo <this repository> --version vX.Y.Z --dir <scratch>`, then in `<scratch>/kit`
   `./configure --non-interactive` with a scratch origin and project name, `docker compose pull`
   (with the empty Docker login), `up -d --wait`, a check that the running containers carry the new
   tags, and a real sign-in through the identity provider, the gateway and the chat to
   `/chat/code`: from a Pystino checkout, `uv run python deploy/ci/e2e_login.py <scratch>/kit
<first-sign-in password> --chat` must print exactly `E2E_OK`. Then remove the scratch stack with
   its volumes and check they are gone.
7. **Fast-forward `stable` to the tag**, only now: `git push origin vX.Y.Z^{}:refs/heads/stable`
   (a fast-forward; never `--force`). Operators follow `stable` or a tag, **never `main`**, and
   `get-kit.sh` is served from `stable`.

If step 4, 5 or 6 fails, `stable` stays where it was: fix forward and release the next patch
(`vX.Y.Z+1`); do not move or delete the tag. A kit-only fix is a Cerea patch release too. Take
steps 3 to 7 in one sitting: `get-kit.sh` with no `--version` installs the newest tag, which until
step 7 has not passed the test.

**Versions** are `MAJOR.MINOR.PATCH` in `package.json`, one annotated `vX.Y.Z` tag per release,
never moved. A change to galopin ships with the image (the image builds it from `agent/`):
machines pick it up when their owner re-runs the install line from the pairing dialog, and the
changelog says when they must. When a Pystino release is paired with a Cerea one, Pystino's
`deploy/release.env` names the Cerea version it was tested with. Between releases `main` may pin
a `sha-<hex>` image (`tools/pin --cerea sha-<hex>`) for a commit that has no release yet; that is
why operators never follow `main`.

## Documentation

`docs/` is a mkdocs-material site, built strict (a broken link or anchor fails
the build). The Python dependencies are pinned in `docs/requirements.txt`, because
this is a Node repository with no Python project:

```sh
uv run --with-requirements docs/requirements.txt mkdocs build --strict
uv run --with-requirements docs/requirements.txt mkdocs serve
```

Its **The deploy kit** page includes the kit's `README.md` from this repository
(`kit/README.md`; `pymdownx.snippets` in `mkdocs.yml`), and the strict build fails if the
file is missing. A change to it republishes the site (the `docs` workflow watches it). Keep
that README's links absolute for files outside it, because relative ones break on the site, and
check the sections you link to: strict fails on a broken anchor.
**Check every claim that names a setting, a variable, a flag, a route, a label or a
default against the code** before you commit it; write plainly and concretely.
This page, **Development**, is `CONTRIBUTING.md` included into the site, so write
its links as absolute URLs. Links to other repositories' pages are absolute too
(strict cannot check them, so open them).

## Repository conventions

- **`AGENTS.md`** is the context file for coding agents working on this repository:
  the commands, the architecture, and the traps that are not recoverable from the
  code. Read it before changing anything. Agent-specific files for a particular tool
  are kept local and are not committed.
- **Merging from upstream.** Upstream changes are merged by hand where they fit:
  `git remote add upstream https://github.com/huggingface/chat-ui.git` (once), then
  `git fetch upstream && git merge upstream/main`. Merge, never rebase: the fork
  keeps upstream's history intact. Keep upstream's file layout where a file still
  exists in both, so the next merge stays mechanical, and put new first-party code
  in new files where it can go. HuggingChat-only behaviour stays behind
  `publicConfig.isHuggingChat`: do not delete it because this deployment never takes
  that path. After a merge run `npm run check`, `npm run lint` and the tests, and
  read upstream's changes to `src/lib/server/models.ts`, auth and the generation
  path with care: those are where the fork differs most.
- **The shared tokens.** `src/styles/tokens.css` and `src/styles/fonts/` are a
  **byte copy** of Pystino's `packages/ui/src/tokens.css` and `fonts/`, so the two
  repositories stay independently clonable. Change the file in Pystino and copy it
  here; never edit the copy alone. `src/styles/tokens.drift.test.ts` fails when they
  differ, but only when the repositories sit side by side as `Cerea/` and `Pystino/`
  (it skips otherwise).
- **Settings** go in `src/lib/types/Settings.ts` and the user-settings endpoint
  (`src/routes/api/v2/user/settings/+server.ts`). Icons are Carbon or Lucide through
  `unplugin-icons`; custom ones live in `$lib/components/icons/`.
- **Commit messages** carry the reasoning: why, and the failure a decision prevents.
  Merges of a topic branch are real merge commits with a message that says what the
  branch does. [AI-DISCLOSURE.md](https://github.com/paoloviviani/Cerea/blob/main/AI-DISCLOSURE.md)
  says how this code was written.
