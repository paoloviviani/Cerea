# Contributing and development

Thanks for helping. Cerea is small and moves quickly, so a short conversation
first saves work on both sides.

- **Bugs and ideas:** open an issue. For a bug, include what you did, what you
  expected, what happened, and your browser and deployment (a cerea-deploy
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
set -a; . /path/to/cerea-deploy/.env; set +a     # the running stack's variables
uv run --with httpx python scripts/test_projects_live.py       # projects: context, retrieval, memory
uv run --with httpx python scripts/test_attachments_live.py    # a document attachment, extracted once
uv run --with httpx python scripts/test_nav_live.py            # the sidebar tree, and signing out for real
uv run --with httpx python scripts/test_admin_panel_live.py    # the admin surfaces, and who may see them
uv run --with httpx python scripts/test_connectors_live.py     # MCP connector OAuth, against a real provider
```

(The first turn of a conversation also generates its title, a second completion
that overwrites the smoke upstream's last request: an assertion about the prompt
has to run on a later turn.)

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

Five workflows in `.github/workflows/`.

| Workflow   | Runs on                                                                                                                                          | What it does                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci`       | every push to `main` and every pull request (changes to `docs/**` and `*.md` are ignored), manual runs, and Mondays 04:41 UTC for the client job | **check** (not on the schedule): `npm ci`, `npm run lint`, `npm run check`, then the server and ssr projects against a `mongo:8` service, serially. **go** (not on the schedule): `gofmt`, `go vet`, `go test` in `agent/`. **client** (push, manual and schedule, not on pull requests): the client project in the Playwright container. |
| `opencode` | a push to `main` touching `agent/**`, weekly (pinned), daily (latest), manual                                                                    | the whole real-opencode suite against the pinned opencode (`pinned`), and against opencode's newest release (`latest`), which opens or updates an issue                                                                                                                                                                                   |
| `images`   | manual only (`workflow_dispatch`)                                                                                                                | builds the image with `APP_BASE=/chat` and pushes it to `ghcr.io/paoloviviani/cerea`; on a `v*.*.*` tag it publishes `X.Y.Z` and `X.Y`, and refuses to overwrite a version that exists                                                                                                                                                    |
| `docs`     | a push to `main` touching `docs/**` or `mkdocs.yml`, and manual                                                                                  | `mkdocs build --strict`, published to GitHub Pages at <https://paoloviviani.github.io/Cerea/>                                                                                                                                                                                                                                             |
| `contract` | a pull request touching the gateway-facing code or the pin, Mondays 05:23 UTC (against `edge`, non-blocking), manual                             | this chat's assumptions about Pystino's API, checked against a gateway image (`deploy/ci/pystino-contract.env` names the version)                                                                                                                                                                                                         |

End-to-end Playwright is not in CI: run it yourself for UI and flow changes.
`ci` ignores documentation-only changes, so a Markdown change runs no tests; the
`docs` workflow is the check for it.

## Releasing

A change is released only when all of these pass, in this order. A step that
cannot run is reported as not run.

1. **CI green** on the commit to be tagged (it runs on every push to `main`: push,
   then wait).
2. **Bump and tag.** The release commit (`release: vX.Y.Z`) changes the version in
   `package.json` and `package-lock.json`. Tag it annotated, `vX.Y.Z`, and push the
   tag. The `images` workflow does not run on a tag by itself: run it on the tag,
   `gh workflow run images.yml --ref vX.Y.Z`, and wait for green. It publishes
   `ghcr.io/paoloviviani/cerea:X.Y.Z` (and `:X.Y`); the package is public.
3. **The image pulls with no registry login:** a `docker pull` with `DOCKER_CONFIG`
   pointing at an empty directory.
4. **In cerea-deploy:** `tools/pin`, `tools/pin --check`, its unit tests, then the
   **fresh-kit test**: a clean copy of the kit, `./configure`, `docker compose pull`,
   `up -d --wait`, a check that the running containers carry the new tags, and a
   real sign-in through the identity provider, the gateway and the chat to
   `/chat/code`, which must print exactly `E2E_OK`. The test stack is then removed
   and checked gone. See
   [cerea-deploy's CONTRIBUTING.md](https://github.com/paoloviviani/cerea-deploy/blob/main/CONTRIBUTING.md#releasing).
5. **Only then** the cerea-deploy tag and its changelog entry.

**Versions** are `MAJOR.MINOR.PATCH` in `package.json`, one annotated `vX.Y.Z` tag
per release, never moved. A change to galopin ships with the image (the image
builds it from `agent/`): machines pick it up when their owner re-runs the
install line from the pairing dialog, and the changelog says when they must.
When a Pystino release is paired with a Cerea one, Pystino's `deploy/release.env`
names the Cerea version it was tested with.

## Documentation

`docs/` is a mkdocs-material site, built strict (a broken link or anchor fails
the build). The Python dependencies are pinned in `docs/requirements.txt`, because
this is a Node repository with no Python project:

```sh
uv run --with-requirements docs/requirements.txt mkdocs build --strict
uv run --with-requirements docs/requirements.txt mkdocs serve
```

Its **The deploy kit** page includes cerea-deploy's `README.md` from a sibling
checkout, `../cerea-deploy/README.md`, and the strict build fails if that checkout is
missing. The `docs` workflow downloads the kit's `main` README at build time.
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
