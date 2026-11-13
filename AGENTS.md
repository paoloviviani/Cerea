# AGENTS.md

This file guides coding agents working in this repository. It holds the rules,
commands, layout, test setup and traps. Subsystem reference lives in
[docs/dev/](docs/dev/) (internal notes, not part of the published docs site);
the index is at the end of this file. Read the page for the area you touch
before you change it.

**Start with [MAINTAINING.md](MAINTAINING.md)**: the rules that are not
negotiable (section 2), how a change is made, verified and released, the traps
that have already cost time (section 6), and the open items.

**Interface text** (labels, toasts, errors, empty states, tooltips) follows
[docs/writing.md](docs/writing.md): plain language, sentence case, and its
term list. Read it before adding or extracting any string.

**Non-negotiable, in short** (full list in MAINTAINING.md section 2): work on a
branch and merge with `--no-ff`; never push `WIP` to `main`; fix bugs freely
but new features are the owner's decision; report the truth (a step that did
not run is "not run"); never touch the owner's live deployment; every
first-party licence is Apache-2.0; say "users", not "people", in new UI copy.

## Overview

Cerea is a SvelteKit application that provides a chat interface for LLMs. A hard fork of huggingface/chat-ui: it no longer tracks or merges upstream, and nothing in it is kept for upstream's sake. The app speaks exclusively to OpenAI-compatible APIs via `OPENAI_BASE_URL`.

## Commands

```bash
npm run dev          # Start dev server on localhost:5173
npm run build        # Production build
npm run preview      # Preview production build
npm run check        # TypeScript validation (svelte-kit sync + svelte-check)
npm run lint         # Check formatting (Prettier) and linting (ESLint)
npm run format       # Auto-format with Prettier
npm run test         # Run all tests (Vitest)
uv run --with-requirements docs/requirements.txt mkdocs build --strict   # the docs site (docs/, not docs/source)
```

### Against a running stack

```bash
set -a; . /path/to/cerea/kit/.env; set +a      # a running stack's variables
./scripts/test_projects_live.py        # projects: context, retrieval, memory
./scripts/test_attachments_live.py     # a document attachment, extracted once
./scripts/test_nav_live.py             # the sidebar tree, and signing out for real
./scripts/test_admin_panel_live.py     # the admin surfaces, and who may see them
./scripts/test_connectors_live.py      # MCP connector OAuth, against a real provider
```

Note the trap in the attachment check, because it will be reintroduced: the
**first** turn of a conversation also generates its title, which is a second
completion and overwrites the smoke upstream's `GET /_last_request`. Any
assertion about the prompt has to run on a later turn, or it is a coin flip.

Signs in through the identity provider and drives real turns. Worth running for
anything touching the generation path, project context or the gateway
forwarder: it asserts on **the prompt that actually left the gateway**, read
from the smoke upstream's recorded request, which no unit test can see.

Two things about running the suites in a container:

- **`npm run test` is not the whole suite.** It is
  `vitest --project=server --project=ssr`, so the **`client`** project — about
  85 files in October 2026, every Svelte component test — does
  not run. It needs a real
  Chromium through Playwright, and the image's browsers must match the
  _installed_ Playwright rather than the caret range in `package.json`
  (`node_modules/playwright` was 1.64.1 while the range said `^1.55.1`, and the
  mismatched image reports `no tests` plus a `Serialized Error: { log: [] }`,
  which says nothing about the cause):

  ```bash
  docker run --rm -v $PWD:/chat -w /chat --entrypoint /bin/sh \
    mcr.microsoft.com/playwright:v1.65.0-noble \
    -c 'export HOME=/root CI=true; corepack enable; npx vitest run --project=client'
  ```

  Worth knowing because a component assertion can go stale for weeks without
  anything going red: the link this section's own dialog work replaced was
  asserted in `renderWithApp.svelte.test.ts` and stayed green through the
  change.

- **`mongodb-memory-server` needs `libcurl4`**, which `node:*-slim` does not
  carry. Without it 49 test _files_ fail to start their in-memory Mongo and
  report as failures that have nothing to do with the code.
- **A CPU without AVX needs no setup.** MongoDB 5.0+ is built for AVX and dies
  with `SIGILL` without it, so the test setup, `database.ts` and the e2e
  fixtures pick the mongod version with `mongoMemoryVersion()`
  (`src/lib/server/mongoMemoryVersion.ts`): 7.0.18, or 4.4.30 when
  `/proc/cpuinfo` has no `avx` flag. 4.4 links OpenSSL 1.1, which current
  distributions no longer ship, so `scripts/setups/legacyOpenssl.ts` fetches it
  once into `~/.cache/cerea-libssl1.1` (needs `curl` and `dpkg-deb`) and puts it
  on `LD_LIBRARY_PATH`. A plain `npx vitest run --project=server` therefore
  works on such a machine. To use a real MongoDB instead, and run the files
  serially because they then share that database and their clean-up helpers
  would wipe each other's collections, set `TEST_MONGODB_URL` (not
  `MONGODB_URL`, which the setup ignores):

  ```bash
  TEST_MONGODB_URL=mongodb://127.0.0.1:27017/ npx vitest run --project=server --project=ssr --no-file-parallelism
  ```

  The knowledge specs that need Postgres (`ingestBackground`, `deleteDerived`,
  `mrl`, `reindexVectors`, `readerChoice`) skip unless `TEST_DATABASE_URL` points
  at a pgvector server whose user may create databases. CI's `check` job
  supplies one (a `pgvector/pgvector:pg18` service), so they run on every PR;
  locally, `docker run -e POSTGRES_USER=gw -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=gw -p 55442:5432 pgvector/pgvector:pg18`
  and `TEST_DATABASE_URL=postgresql://gw:pw@127.0.0.1:55442/gw`.

### End-to-end tests (Playwright)

`npx playwright test --grep @smoke` is the subset CI runs on every PR; the
whole suite is `npx playwright test --project=chromium`. Nothing is retried
(`retries: 0`) and none is known to fail: a spec that passes only on a second
try is a bug in the spec or the app, fixed at its cause. Two causes recur: an
action taken before the page hydrates (a server-rendered input or button does
nothing until then: `waitForHydration` in `tests/fixtures.ts`), and a wait
shorter than the thing it waits for (a poll's interval, a background cleanup).

`npx playwright test` builds the app, starts its own MongoDB and drives
Chromium. The `E2E_*` variables move it: `E2E_APP_PORT`, `E2E_MONGO_PORT`,
`E2E_DB_NAME`, and `E2E_APP_BASE` for the base path. SvelteKit's base path is
compiled in, so **a build is per base**: a `build/` made for one base cannot
serve another. `E2E_SKIP_BUILD=1` serves an existing `build/` as is, which
must have been built with the same `APP_BASE`; on a small machine, build once
(`npm run build`) and then run the tests with `E2E_SKIP_BUILD=1`, so the build
and the browsers do not compete for memory.

**Pull requests run the whole suite too.** `ci.yml` runs `e2e-full` (4 shards
on 4 runners, merged into one report and one `e2e-full` result) on a PR that
touches `src/`, `messages/`, `tests/`, `agent/`, `static/`, `playwright.config.ts`,
`package*.json` or the workflow itself; a docs-only or changelog-only PR keeps
only the smoke run. Nightly and `-f full=true` dispatches run it as before.
Sharding splits spec files (workers stay 1 inside a shard), so a spec must not
rely on state left by another spec. Before opening a UI PR, run
`scripts/e2e-affected.sh`: it maps `git diff origin/main...HEAD` (and the
working tree) to the specs likely to be affected, by feature words in the
changed file's name and path, plus any spec you changed, and runs them under
`flock /tmp/heavy.lock` (`LOCK_FILE=/tmp/heavy.lock.a` picks another slot,
`E2E_SKIP_BUILD=1` reuses `build/`, `--base REF` changes the diff base).
`scripts/e2e-affected.sh --list` only prints the specs. It is a heuristic: CI's
`e2e-full` is the gate.

## Verifying a change

The rules every change follows before it merges, and how a release is proven.
They exist because each one was skipped once and something shipped broken.

### Before merging

- **Run what the change touches, then the gates.** `npm run check`, `npm run
lint` (or `npx prettier --check` on the files you changed), the server tests
  for the area, and the client tests for any component you changed. A change to
  shared styles (`tokens.css`, `main.css`, text sizes, spacing) touches every
  component test that measures layout: run the whole `client` project, not one
  file.
- **A new test must fail without the fix.** After writing a regression test, put
  the fix aside (copy the fixed file somewhere outside the tree, then restore
  the old version: `git restore --source=HEAD -- <the fixed file>` while the
  fix is uncommitted, `--source=<the base commit>` once it is; do not use
  `git stash`, whose stack is shared by every worktree of the clone), run the
  test, and see it fail; then copy the fixed file back. A test that passes either way proves
  nothing, and this has caught tests that stubbed the wrong layer.
- **A failure is "pre-existing" only once it fails on main too.** Before
  dismissing a failure, rebuild main without your change and run the same test
  there. Same assertion failing on both: pre-existing, say so. Only on your
  branch: yours, even when it looks unrelated. There are no known failing
  e2e specs: the whole Playwright suite passes, and a failure in it is yours
  until main shows the same one.
- **End-to-end tests run against a fresh build.** `npm run build` first,
  then `E2E_SKIP_BUILD=1`. A stale `build/` passes or fails for reasons that have
  nothing to do with the change.
- **CI runs on every push to main** (`ci.yml`: `check`, `client`, `go`,
  `e2e-smoke`; the whole e2e suite nightly, or `-f full=true` on a dispatch,
  and on a PR the `client` job only when it touches `src/lib/components`).
  The smoke subset is the Playwright specs tagged `@smoke` in their title:
  add the tag to a spec that guards a main path, never to a slow or timing-
  sensitive one. Push,
  then wait for it to be green before tagging. Its client job runs in CI's
  Chromium on slower hardware: timing-sensitive tests fail there first, so fix
  them at the cause (wait for the state, tap where the element really is)
  rather than raising timeouts.

### On a small box

- **Heavy runs take the lock:** `flock /tmp/heavy.lock` around builds,
  Playwright and the full test suites, so two of them never run at once. Never
  wrap a script that takes the lock itself (`kit/dev/build.sh` with
  `BUILD_LOCK` set) in another flock.
- **`mongodb-memory-server` on a CPU without AVX** runs mongod 4.4 by itself
  (see Testing above). To use a real MongoDB, set `TEST_MONGODB_URL` with
  `--no-file-parallelism`, and for e2e `E2E_MONGO_PORT`/`E2E_MONGO_URL`. Running the whole `client` project in
  one command can hit the same crash: give the Playwright container the real
  database too (`--network host -e MONGODB_URL=mongodb://localhost:<port>
-e MONGODB_DB_NAME=cerea-client-test`), or run the affected files and let CI
  run the whole project.
- **WebKit may not be installed locally.** "Executable doesn't exist" means the
  browser, not the change; run `--project=chromium` and leave WebKit to CI.
- **Root-owned leftovers** (`dist/`, `test-results/` written by a container)
  break builds with `EACCES`. Build to another `--outDir`, or give the files
  back with a throwaway container (`docker run --rm -v $PWD:/x alpine chown -R
$(id -u):$(id -g) /x`).

### Running a Single Test

```bash
npx vitest run path/to/file.spec.ts        # Run specific test file
npx vitest run -t "test name"              # Run test by name
npx vitest --watch path/to/file.spec.ts    # Watch mode for single file
```

### Test Environments

Tests are split into three workspaces (configured in vite.config.ts):

- **Client tests** (`*.svelte.test.ts`): Browser environment with Playwright
- **SSR tests** (`*.ssr.test.ts`): Node environment for server-side rendering
- **Server tests** (`*.test.ts`, `*.spec.ts`): Node environment for utilities

## Architecture

### Stack

- **SvelteKit 2** with Svelte 5 (uses runes: `$state`, `$effect`, `$bindable`)
- **MongoDB** for persistence (auto-fallback to in-memory with MongoMemoryServer when `MONGODB_URL` not set)
- **TailwindCSS** for styling

### Key Directories

```
src/
├── lib/
│   ├── components/       # Svelte components (chat/, code/, mcp/, voice/, icons/)
│   ├── server/
│   │   ├── api/utils/       # Shared API helpers (auth, superjson, model/conversation resolvers)
│   │   ├── textGeneration/  # LLM streaming pipeline
│   │   ├── mcp/          # Model Context Protocol integration
│   │   ├── database.ts   # MongoDB collections
│   │   ├── models.ts     # Model registry from OPENAI_BASE_URL/models
│   │   ├── auth.ts       # OpenID Connect authentication
│   │   ├── code/         # the /code panel's server side: machine link, forwarder, schedules executor
│   │   ├── schedules/    # the kind-agnostic scheduled-actions core
│   │   ├── codeDevices.ts  # pairing records, and the per-person scope on them
│   │   └── codeEnabled.ts  # the CODE_AGENTS_ENABLED gate (and files, terminal, schedules)
│   ├── types/            # TypeScript interfaces (Conversation, Message, User, Model, etc.)
│   ├── stores/           # Svelte stores for reactive state
│   └── utils/            # Helpers (tree/, marked.ts, auth.ts, etc.)
├── routes/               # SvelteKit file-based routing
│   ├── code/             # the /code Agents panel (a thin wrapper; the frame is components/code/)
│   ├── conversation/[id]/  # Chat page + streaming endpoint
│   ├── settings/         # User settings pages
│   ├── api/              # Legacy v1 API endpoints (mcp, transcribe, fetch-url)
│   └── api/v2/           # REST API endpoints (+server.ts)
```

### Text Generation Flow

1. User sends message via `POST /conversation/[id]`
2. Server validates user, fetches conversation history
3. Builds message tree structure (see `src/lib/utils/tree/`)
4. Calls LLM endpoint via OpenAI client
5. Streams response back, stores in MongoDB

### Database Collections

- `conversations` - Chat sessions with nested messages
- `projects` - Groups of conversations sharing standing context
- `users` - User accounts (OIDC-backed)
- `sessions` - Session data
- Retired, never dropped: `assistants`, `reports`, `sharedConversations` (public share links, removed). No type or index; read by raw name only so erasure, merge and conversation delete still reach old rows (`RETIRED_COLLECTIONS`, `legacyShares.ts`)
- `settings` - User preferences (including the global system prompt)
- `connectorModes` - How the deployment offers its own connectors: `off` / `on` / `locked` and `alwaysLoaded`, keyed `base:<name>` or `connector:<id>`; no row means `on` (ADR 0104)
- `connectorSwitches` - One row per person: the connectors they switched off (default-on) or on (default-off); owner-keyed (ADR 0104)
- `customModels` - A person's own custom models: a base model plus a system prompt. Owner-keyed like `settings`
- `codeDevices` - Paired coding-agent machines. Pairing records
  only: name, the machine's own `machineId`, its OIDC `sub`/`iss`, one owner,
  the backends/policy/credential health it last reported. Nothing
  capability-bearing; a revoked machine stays as a tombstone. No agent state

## Environment Setup

Copy `.env` to `.env.local` and configure:

```env
OPENAI_BASE_URL=https://router.huggingface.co/v1
OPENAI_API_KEY=hf_***
# MONGODB_URL is optional; omit for in-memory DB persisted to ./db
```

See `.env` for full list of variables including router config, MCP servers, auth, and feature flags.

## Code Conventions

- TypeScript strict mode enabled
- ESLint: no `any`, no non-null assertions
- Prettier: tabs, 100 char width, Tailwind class sorting
- Server vs client separation via SvelteKit conventions (`+page.server.ts` vs `+page.ts`)
- The think tag never appears literally in source: import `THINK_OPEN`, `THINK_CLOSE` and the block patterns from `src/lib/utils/thinkTags.ts`. Some reasoning models emit those tags as special tokens and cannot type them, so an agent built on one corrupts a literal tag (a dropped `>`) without noticing; the literal lives only in that module, assembled from pieces, and `thinkTags.spec.ts` fails if it shows up elsewhere in non-test code under `src/`. Say "the think tag" in comments.

## Feature Development Checklist

When building new features, consider:

1. **Settings persistence**: Add new fields to `src/lib/types/Settings.ts`, update API endpoint at `src/routes/api/v2/user/settings/+server.ts`
2. **Rich dropdowns**: Use `bits-ui` (Select, DropdownMenu) instead of native elements when you need icons/images in options
3. **Scrollbars**: Use `scrollbar-custom` class for styled scrollbars
4. **Icons**: Custom icons in `$lib/components/icons/`, use Carbon (`~icons/carbon/*`) or Lucide (`~icons/lucide/*`) for standard icons

## Subsystems

Each entry is the short version; the page has the full reference and the reasons.

### Models and capabilities

The gateway advertises capabilities as flat `input_modalities`, `output_modalities`
and `supported_features` on `GET /v1/models`; `models.ts` matches by membership
and also reads HuggingFace's nested shape (gateway first). The per-model switches
override the advertised default and are never gated on it. `ModelsManager`
(`/workspace?tab=models`) is the only place models are managed; there is no
per-model page and no per-model system prompt. Custom models use the id
`custom:<ObjectId>`, never leave Cerea, and are resolved to their base by
`resolveConversationModel` in every place a turn picks its model. The prompt is
composed in one function, `composeUserPrompt` (admin instructions, global,
custom model, conversation).

Full reference: [docs/dev/models.md](docs/dev/models.md).

### MCP connectors (ADR 0104)

A turn's connectors are decided on the server only: the browser sends no choice.
One resolver, `mcpLocalsFor` (`mcp/selection.ts`), builds a turn's servers; never
add a second path. Connectors load on demand through `load_tools`, appending to
the request so prompt caching holds. Tool output from outside is data
(`textGeneration/untrusted.ts`): a new built-in that returns outside content must
be added to `EXTERNAL_BUILTIN_TOOLS`. Approvals are unchanged.

Full reference: [docs/dev/mcp-connectors.md](docs/dev/mcp-connectors.md).

### Sidebar and signing out

Tree contents load when opened, never on page load; `--nav-width` is one
variable; `/chats` search is server-side, title only, with an index on
`{ userId, updatedAt, title }`. Sign-out ends the session at both ends
(`routes/logout/+server.ts`) using the stored id token; landing on the login
prompt afterwards is the proof it worked.

Full reference: [docs/dev/sidebar.md](docs/dev/sidebar.md).

### Dialogs, palettes and the look

Projects, models and connectors are pages, not dialogs; blue-600 is the single
accent. `src/styles/palettes.css` is generated by `scripts/generate-palettes.mjs`
(edit the tables there); `tokens.css` is a byte copy of Pystino's and palettes
stay Cerea-only.

Full reference: [docs/dev/ui-dialogs-palettes.md](docs/dev/ui-dialogs-palettes.md).

### Translations

User-visible strings come from `messages/en.json` through Paraglide, in every
converted area (`CONVERTED` in `scripts/i18n-check.mjs`; currently every screen).
`npm run i18n:check` is part of lint. New strings are messages, not literals;
`en-XA` is the pseudo-locale for spotting leftovers. The language of a request is
decided once in `hooks/handle.ts`.

Full reference: [docs/dev/translations.md](docs/dev/translations.md).

### Projects, knowledge bases and attachments

The knowledge pipeline is Cerea's own: Mongo for the named things, a chat-owned
Postgres with pgvector (`CHAT_PG_URL`) for passages and vectors, served in-process
under `/api/v2/gateway/vector_stores/...`. Sharing is decided against the viewer's
identity and shares instructions, knowledge and memory, not chats or documents;
retrieval runs with the reader's access and never fails a turn. Postgres refuses a
24-hex ObjectId as `uuid`. A document attachment is extracted once, at upload.

Full reference: [docs/dev/knowledge-projects.md](docs/dev/knowledge-projects.md).

### Skills

Built-in skills are seeded by `ensureDeploymentSeeds`; each seeded row stores the
hash it was seeded from, so an admin's edit is never overwritten. Bundled files
(`scripts/`, `references/`, `assets/`) must be text: they are inlined into the
server bundle with `?raw`.

Full reference: [docs/dev/skills.md](docs/dev/skills.md).

### The /code panel, agent sessions and the machine link

`CODE_AGENTS_ENABLED` must be exactly `"true"`. The machine link is a raw WebSocket
upgrade, not a SvelteKit route; the bearer is validated locally, never via
userinfo; the registry is in-process. The browser never reaches a machine
directly: every call goes through Cerea, and the SSE bridge is cursored on the
machine's own `epoch`/`seq`. Tool-output images are references, never bytes on the
stream. The chat drives agent sessions through the same machinery (ADR 0106).
The wire contract is `agent/PROTOCOL.md`; new ops and fields are optional and
advertised (MAINTAINING.md section 4).

Full reference: [docs/dev/code-panel.md](docs/dev/code-panel.md).

### Scheduled actions

A kind-agnostic core (`src/lib/server/schedules/`) with one executor per kind
(`chat`, agent). The executor contract is the header of `executors.ts`. A chat run
is the conversation route's own turn, unattended, authenticated through the
user's background OIDC grant (`schedules/grants.ts`); permission mode is Ask or
Allow, never looser than the user's setting. The `schedule` tool only proposes;
a click on the approval card creates. Coordination between agents is a grant.

Full reference: [docs/dev/schedules.md](docs/dev/schedules.md).

### Memory: scopes, notes and the prompt cache

One `Scope` abstraction (`src/lib/server/memory/service.ts`) serves personal,
project, **chat** (`conversationMemories`) and **agent** (`agentMemories`) notes.
`remember`/`forget` take `scope: conversation | project | global`; global needs the
user's words. Agents get only `session` and `workspace` through the `memory` machine
call, and are refused every chat scope server-side. **Prompt-cache rule:** nothing
that changes mid-chat may sit before the newest user message: personal and project
memory are a per-chat snapshot in the system prompt, and chat notes plus later
writes go in the tail (`memory/tail.ts`, `injectConversationNotes`).

Full reference: [docs/dev/scoped-memory.md](docs/dev/scoped-memory.md).

### Document tools

`doc_outline`, `doc_read`, `doc_edit`, `doc_create`, `doc_create_from_template`
talk to the `documents/` service (`CHAT_DOCUMENTS_URL`). `doc_edit`'s operations
are generated from the service's `/v1/capabilities`; `documentsContract.spec.ts`
guards the fixture. Edits store a new version under the source's name; the
original is never touched.

Full reference: [docs/dev/document-tools.md](docs/dev/document-tools.md).

### File storage

Every stored file goes through `BlobStore` (`src/lib/server/blobs/`). Never open
a `GridFSBucket`, touch `files.files`/`files.chunks`/`codeOutputs.*`, or build an S3
client elsewhere: `blobs/seam.spec.ts` fails the build.

Full reference: [docs/dev/file-storage.md](docs/dev/file-storage.md).

### Office previews

Optional (kit `office` profile, `CHAT_GOTENBERG_URL`). Bump `CONVERTER_VERSION`
when the Gotenberg image or its options change.

Full reference: [docs/dev/office-previews.md](docs/dev/office-previews.md).

### Push notifications

Web Push is off unless the VAPID keys are a pair. Payloads are thin and not
sensitive; the focus check lives in the service worker.

Full reference: [docs/dev/push-notifications.md](docs/dev/push-notifications.md).

### Browser use (ADR 0116)

The `browse` tool runs a sub-agent on a computer's `cerea-browser` MCP server
(contract in `contract.ts`). One task per computer (a lease on the device row);
actions are classified and commits ask for approval, held in process. `browse`
is an external built-in and not a sub-agent tool.

Full reference: [docs/dev/browser-use.md](docs/dev/browser-use.md).

### The plan tool and sub-agents

`update_plan` persists `Conversation.plan`; `delegate` and `research` run
`runNestedAgent` on a fresh message array. Sub-agent approvals are not relayed:
their MCP calls pass `createSubAgentApprovalGuard`. Never give a sub-agent a way
to open an approval prompt without persisting its loop. The two replace-by-uuid
copies for `SubAgent` updates must stay in step.

Full reference: [docs/dev/plan-and-subagents.md](docs/dev/plan-and-subagents.md).

### UI screenshots

Screenshot the real app with a throwaway Playwright spec (never committed), at 1440
and 390 wide, both themes when colour changes; look at every shot yourself.

Full reference: [docs/dev/ui-screenshots.md](docs/dev/ui-screenshots.md).

### Releasing

The release proof (CI, tag, images, anonymous pull, fresh-kit test, `stable`) is
scripted by `scripts/release/release.sh X.Y.Z`; see MAINTAINING.md section 5.
A release is done only when it prints `released vX.Y.Z`.

Full reference: [docs/dev/releasing.md](docs/dev/releasing.md).
