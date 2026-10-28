# AGENTS.md

This file provides guidance to coding agents working with code in this repository.

**Start with [MAINTAINING.md](MAINTAINING.md)**: the rules that are not
negotiable, how a change is made, verified and released, the traps that have
already cost time, and the open items. This file is the detailed reference
for each subsystem.

**Interface text** (labels, toasts, errors, empty states, tooltips) follows
[docs/writing.md](docs/writing.md): plain language, sentence case, and its
term list. Read it before adding or extracting any string.

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
    mcr.microsoft.com/playwright:v1.64.1-noble \
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

### Validating UI with screenshots

Tests prove behaviour; screenshots are how a person judges a visual change. The
rules:

- **Screenshot the real app, not a mock.** Write a throwaway Playwright spec
  (`tests/_shots.spec.ts`, deleted afterwards, never committed) that seeds the
  state with the fixtures (`seedConversation` and friends), builds once, and
  runs with `E2E_SKIP_BUILD=1`.
- **Wait for the rendered state before shooting.** Markdown renders after the
  text arrives: wait for a heading or table role, not for the text. A shot taken
  too early shows raw markdown and misleads whoever reviews it.
- **Prototype before building.** To compare options without touching code,
  inject CSS with `page.addStyleTag()` per variant (fonts as data-URL
  `@font-face`, token overrides with `:root:root` for specificity). Only after a
  choice is made does the change go into the source, and then it is
  screenshotted again from the build.
- **Always both widths, and both themes when colour changes:** desktop 1440 and
  phone 390 (360 when space is tight); light and dark by adding `dark` to
  `<html>`. A phone screenshot needs a tall viewport (e.g. 390×1300) to show a
  whole reply.
- **Compare side by side.** Stitch before/after (or one cell per variant) into a
  labelled contact sheet with Pillow (`uv run --with pillow python …`), same
  crop and scale for every cell. Separate screenshots viewed one after the
  other hide small differences.
- **Use element screenshots for details** (`locator.screenshot()`, after
  `scrollIntoViewIfNeeded()`): a folded long message, a focus ring, a single
  control.
- **Check overflow by measurement, not by eye.** A page can scroll sideways
  inside its own scrolling panel while the window does not; assert that no
  element's `scrollWidth` exceeds its `clientWidth` across the scroll
  containers, at both widths (`tests/project-page.spec.ts` does this).
- **Look at every screenshot yourself before reporting it.** Then save the set
  outside the repository, in a reports directory the owner reads (for example
  `reports/screenshots/<date>-<topic>/` next to the checkout), never committed,
  and point to the files.

### Releasing

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
`scripts/release/fresh-kit-check.sh vX.Y.Z` (needs ports 80/443 free, docker,
`uv`; `KEEP=1` leaves the stack up), moves `stable`, and creates the GitHub
release from the changelog entry. It stops at the first failed step and says
which; a GitHub 5xx on the tag push falls back to the API. Each step's outcome
is printed: read them, a release is done only when the script prints
`released vX.Y.Z`.

A step that cannot run (no browser, no credentials) is reported as not run,
never as passed.

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

### Model Context Protocol (MCP)

MCP servers are configured via `MCP_SERVERS` env var. When enabled, tools are exposed as OpenAI function calls.

**Connectors, modes and loading on demand (ADR 0104).** A turn's connectors are decided on the server and nowhere else:

- **The browser sends no choice.** `selectedMcpServers`, `selectedMcpServerNames` and `selectedConnectorIds` are gone from the request schema (an old tab that posts them is ignored), the composer lists no connectors, and the `localStorage` keys older builds kept (`mcp:selected-ids`, `mcp:disabled-base-ids`, the per-chat and default connector ids) are deleted by `forgetOldMcpSelections`, never read. Connectors are switched in Workspace only.
- **Where the settings live.** A deployment connector's policy (`.env` servers and administrators' connectors) is a row in `connectorModes` keyed `base:<name>` or `connector:<id>`: mode `off` / `on` / `locked`, plus `alwaysLoaded`. No row means `on`, not always loaded, which is why an upgrade turns every deployment connector on for everyone. A person's own switches are one row in `connectorSwitches` (`off`: default-on connectors they turned off; `on`: default-off ones, the servers on their machines, they turned on), registered in `identity/userKeyedCollections.ts` for erasure and merge. Both are read from Mongo on every turn, never cached. Code: `src/lib/server/mcp/deploymentModes.ts`; the admin write is `PUT /api/v2/admin/connector-modes`, a person's switch is `PUT /api/v2/mcp/switches` (refuses to switch off a locked connector).
- **The one resolver.** `mcpLocalsFor(conv, userId)` (`mcp/selection.ts`, built on `resolveConnectors` in `mcp/turnConnectors.ts`) takes the policies, the person's switches and `Conversation.loadedConnectors`, and returns every connector that is on (`connectors`), the keys loaded at the start (`loadedKeys`: always loaded, then the conversation's, in order) and their servers with the person's credential (`servers`). The turn route, both sweepers (`parkedSweeper`, `toolApprovalSweeper`: also for a conversation that loaded nothing) and `runMcpFlow` (when handed none) all call it; `resumeElicitation` runs an approved call only on the servers the caller resolved for the person (`locals.mcp.servers`); with none it runs nothing (fails closed). Nested agents and `delegate` inherit the turn's servers, mapping and tool list. Never add a second path that builds a turn's servers.
- **Tools on demand.** Core built-ins stay fully loaded. Each connector that is on and not always loaded is one line in the system prompt (`connectorCatalogNotice`: name, a sentence, tool names) and nothing else; `load_tools({connectors})` (`builtinTools/loadToolsTool.ts`, no approval) loads it. `mcp/connectorRuntime.ts` does the loading: it changes `servers`, `mapping` and the sent tool list in place and **appends**, so the start of the request is unchanged for prompt caching; it records the key on `Conversation.loadedConnectors` (`$addToSet`), so it stays loaded on later turns. A call to a tool of a connector that is not loaded loads it first (`loadForCalls`). The list lists every connector that is on and not always loaded, loaded or not, so the system prompt does not change as connectors load. A sub-agent allowed `load_tools` sees what it loaded on its next request (`NestedAgentDeps.connectors.version`), and the load counts for the conversation. A connector the person switched off or has not signed in to is reported by `load_tools`, not offered.
- **The catalogue costs no connection.** Building a turn reads a `.env` server's tool names from `mcp/catalogCache.ts` (by configured address; filled only by the credential-free refresh of the offered `.env` servers, on boot and every 15 minutes, through `serverOverlays.callableServers` with no token) and a connector row's from the names its own last check stored, never the address cache: a listing made with one person's credential must not reach another's catalogue. Unreadable policies or switches fail closed (no deployment connectors; only locked ones). A connector is contacted only when loaded or called (`getOpenAiToolsForMcp` lists loaded servers only). The size of the tool definitions is logged per turn (`[mcp] tool definition size`, characters and a token estimate, with the catalogue and loaded counts).
- **Approvals are unchanged** (ADR 0075): calling a connector's tool asks as before, whatever its mode; `load_tools` itself never asks. A project's `defaultMcpConnectorIds` is retired: never read, never written.

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

## Where a model's capabilities come from

**The gateway advertises them and this app must read its shape.** Each card on
`GET /v1/models` carries flat `input_modalities`, `output_modalities` and
`supported_features` — an open set of strings on purpose, because
the reference provider documents it as "current values include json_mode,
reasoning and tools" and a boolean per feature would need a migration whenever
a provider adds one. So `models.ts` matches by membership, not by field.

It was reading **HuggingFace's router shape instead** — `architecture
.input_modalities` and `providers[].supports_tools` — which a gateway never
sends. Every model therefore came back with no tools, no vision and no
reasoning, and the capability switches for them had nothing to show. Nothing
errored and nothing logged; the only symptom was four absent switches. Both
shapes are read now, gateway first, because the standalone mode runs against
any OpenAI-compatible endpoint, some of which send only the nested one.

Two consequences worth knowing:

- **a model's row can legitimately declare nothing.** `benchmark-live` was
  created by a live-benchmark script (`benchmark_live.py`, not in this
  repository) through `/api/admin/models` with the three fields omitted, so it
  advertised nothing while its upstream declares `tools` and `json_mode`. The
  script sets them now. An operator sets them for
  any model through the console's `CapabilityPicker`;
- **the switches are not gated on advertised support.** The advertised value is
  the default and the switch overrides it — the same judgement the gateway
  makes about its own catalogue: a claim rather than a contract,
  editable by somebody who has found out otherwise. Gating them is how all four
  came to be invisible. Where switch and catalogue disagree, the row says what
  the gateway said.

`scripts/test_nav_live.py` asserts the crossing: a model the _gateway_ says
does tools must be reported by the _chat_ as doing tools. That is the only
place the mismatch was ever visible.

## Models: one manager, custom models, and no per-model page

`ModelsManager` is the **only** place catalogue models are managed. It lists all
of them (and the person's custom models, marked) with a search, and opens one to
set it as the default or change its settings — reasoning, tools, images and
artifacts. **There is no per-model system prompt**: it was removed, its stored
values dropped without migration (see below). `routes/settings/(nav)/[...model]`
is **gone**; everything that pointed at it now opens the manager.

The manager is the Models tab of the **workspace** (`/workspace`), the page
that hosts models, **Custom models**, memory, knowledge bases, skills and
memory as tabs. The address is the way in from anywhere: `/workspace?tab=models`
for the list, `/workspace?tab=models&id=<id>` straight onto one model's
settings, `/workspace?tab=custom[&id=custom:<id>]` for Custom models. The
affordances that open it — a routed message's model, the models list's gear —
navigate to that address (the composer's model name opens the per-chat
`ModelPicker`, which is a different thing). The `modelsOverlay` store this once
needed is deleted; an address needs no store.

Two things worth knowing:

- **"Default" is what a _new_ chat starts on.** An open conversation keeps the
  model it was started with, so the button says "Set as default" and the pill
  says "Default", not "Active";
- **There is no inference-provider choice.** Every call goes to the gateway,
  and which upstream serves a model is the gateway's decision (ADR 0032).

### Custom models: the global prompt and custom models

Two things a person writes, both on the **Custom models** tab
(`components/models/CustomModelsManager.svelte`):

- **`Settings.globalSystemPrompt`**: one prompt for every _chat_ turn. Chat only:
  the /code panel never reaches the pipeline that applies it, and title
  generation is a separate internal completion that does not.
- **Custom models** (`customModels` collection, `types/CustomModel.ts`,
  `server/customModels.ts`, routes `api/v2/custom-models`): a name (unique per
  owner, case-insensitively), a **base** (a catalogue model the caller can see,
  never another custom model), a system prompt and an optional description.
  **Private**, owner-keyed exactly like `settings` (`userId`, or `sessionId` for
  an anonymous session, via `authCondition`); another person's id is a 404.
  Erased with the account and renamed-not-dropped on a merge
  (`identity/userKeyedCollections.ts`, which has a spec guarding the roster).

**The id scheme is `custom:<24-hex ObjectId>`** (`utils/customModelId.ts`).
`conversation.model` holds it, so a conversation stays on its custom model,
and it is also the id in the picker and in `settings.activeModel` (a custom
model can be the default). **It never leaves Cerea.** One function turns it into
a model a turn can run on: `resolveConversationModel` (`server/customModels.ts`).
Every place that used to do `models.find(m => m.id === conv.model)` goes through
it — the turn route, the parked-turn and tool-approval sweepers, the
view-prompt route — and the upstream request, the capability gates, the metrics
and the per-model settings (`reasoningEffortOverrides`, tools, images,
artifacts: all keyed by the **base** id) see only the base. A custom model that is
gone, or whose base left the catalogue, **falls back to the deployment default**
instead of failing the turn (a deleted one's conversations are moved to its base
when it is deleted, so that is the safety net).

**The client sees custom models as ordinary catalogue entries.** `+layout.ts`
loads `GET /api/v2/custom-models` beside the catalogue and appends
`customModelEntries()` (`utils/customModelEntries.ts`) to `data.models`: each
copy of its base's entry with a new id, name and `customBase`, so vision, tools,
reasoning and effort gating carry over with no second code path. They go
**after** the catalogue so `models[0]` stays the deployment default. A setting
keyed by model id is read with `settingsModelId(model)` (the base's), never
`model.id`. The /code panel never sees them: it lists the machine's own models,
and `allowsModel` refuses a `custom:` id even for a machine that allows free
models.

**One function composes the prompt**: `composeUserPrompt` (`textGeneration/preprompt.ts`,
called by `resolvePreprompt`, fed by `textGeneration/userPrompts.ts`): **the
administrator's instructions** (`server/adminInstructions.ts`: config keys
`ADMIN_INSTRUCTIONS` / `ADMIN_INSTRUCTIONS_VISIBLE`, edited at `/admin/instructions`,
read from the config's in-memory copy so a turn adds no query, a saved empty value winning over the env default via `getSaved`; sent as a labelled, closed block, first in the system prompt even on tool turns (`runMcpFlow` puts it ahead of the tool contract); also put first in
every sub-agent's system prompt in `runNestedAgent`; never the /code panel,
galopin or titles; Settings gets the text only while visible, and no field at
all otherwise), then **global,
then the custom model's, then the conversation's stored prompt**; empty parts are
skipped; `preprompt.spec.ts` asserts the order. What `resolvePreprompt` and the
turn append after it (the artifacts and execution contracts, skills, memory, then
the project's context, whose own order `projectContext` keeps) reads below.

**Per-model prompts are gone, and stale ones are neutralised three ways.** The
settings API no longer reads or writes `customPrompts` / `customPromptsEnabled`
(an old client posting them is ignored: the schema strips unknown keys);
`POST /conversation` ignores a body `preprompt` (a stale tab could otherwise
smuggle one back in; a conversation's prompt is the model's own, or an imported
share's); and `dropPerModelPrompts` — run once at boot from
`Database.initDatabase`, idempotent, not a `Migration` routine because that list
is empty and routines run in a transaction — `$unset`s what is stored.
Conversations that already stored one keep it: it is that conversation's own
system message now.

## The sidebar, and signing out at both ends

**Two trees, then three rows, then the footer.** `components/nav/` holds the
pieces: `TreeBranch`, `TreeLeaf`, `RowMenu`, `ProjectsBranch` for the one
branch whose children are themselves folders, and `NavFooter` for the foot.

The split is the point, and it was arrived at by getting it wrong first: every
top-level entry was a branch, and a disclosure triangle revealing a list you
then clicked to open a dialog anyway was worse. Only **Projects and Chats**
have contents worth expanding. The rows at the foot are single addresses —
**Workspace** (the tabbed page hosting models, Custom models, memory,
knowledge bases, skills and memory), **Settings**, and **Admin** for administrators (gated on
`gatewayIsAdmin`, the gateway's answer, not the chat's own flag) — and the
**footer** is static: the user's tag and name, a theme switch, and a sign-out
button, all inline, with no popup. (Models, Knowledge and MCP Servers were
three more rows that each opened their own dialog; the workspace page absorbed
them, and `UserMenu` — whose popup carried Settings, Admin, the theme switch
and sign out — went with them.)

**Projects and Chats are pages as well as folders.** In each header the
**label is a link** (to `/projects`, the list of projects, and to `/chats`, the
searchable list of every chat) and **only the chevron expands or collapses** the
branch. They are two controls and two tab stops, never one button: the chevron
is its own button named "Expand Projects" / "Collapse Projects" (likewise
Chats) with `aria-expanded`, drawn at a 20px target but laid out as before.
`TreeBranch` does this when given an `href`; the folders inside a branch (a
project's own row) keep the single button, which is the file-tree idiom. The `+`
beside Projects is unchanged. Do not make the label toggle again "because every
tree does": the chevron is the toggle, and the label is where you go.

**The width is one variable.** The desktop sidebar is `--nav-width` (340px, in
`styles/main.css`): the layout's grid column, the collapse handle riding its
edge and the width pinned on the nav's children all read it, so they cannot
disagree. It was 260, then 300 because titles and the /code tree's nested rows
(flush machines and workspaces, indented sessions and subagents) were
unreadable once the
text grew by a pixel; 340 because at 300 a session row's state dot, badges and
⋯ menu still cut its title short, while the phone drawer (85% of a 390px
screen, ~330px) showed it whole. It means nothing below `md`, where the sidebar is the
drawer. Put no pixel width for the nav anywhere else.

Four rules:

- **a tree's contents load when it is opened**, never on page load. A project's
  chats load when _its_ folder opens, not with the project list — a dozen
  projects would otherwise be a dozen requests to draw a sidebar nobody
  expanded;
- **managing a project happens on its own row**, through the `⋯`: **Project
  settings** navigates to the project's page (`/projects/<id>`), Delete removes
  it after a confirmation that says what is _kept_ (the chats return to the
  ordinary list; the knowledge bases are gateway resources with their own
  owner). The `+` on the Projects header goes to `/projects/new` and is the only
  control there that is not about an existing project. There is no overlay and
  no nested Edit: the page tells the tree to reload through `projectsRevision`;
- **the list of all projects is a page, and the label opens it.** `/projects`
  (`ProjectsManager`, just that list, each card a link to the project's page)
  was once reachable only from a project page's back link, and the rule here
  said nothing in the sidebar opens it. That rule is reversed on purpose: the
  Projects label is the way to it, and still no overlay;
- **a project's chats live under the project, so the sidebar's Chats leaves
  them out.** That is what `projectId` on `ConvSidebar` is for; without it every
  project conversation appeared in both places. The `/chats` page is the
  opposite on purpose: it is the "find anything" list, so it includes them and
  marks each with its project.

**`/chats` and its search** (`components/chats/ChatsList.svelte`). A search box
focused on open, rows of title, last updated (relative), model and the project
badge, newest first, more rows as the end scrolls into view. The filter is the
**server's**, as an optional `q` on `GET /api/v2/conversations` rather than a
new endpoint, because it is that same list with one more condition: the same
auth condition (the caller's own conversations, so their own project chats are
in and a colleague's chats in a shared project are not — those stay on the
project's page), the same sort, the same `p` paging and `hasMore`, the same
row shape, and no second route to keep in step. Three things about `q`:

- **case and accents are folded in the pattern**
  (`server/titleSearch.ts`), because MongoDB's `$regex` ignores collation: each
  letter becomes a class of its cased and accented forms plus any combining
  marks (so a title stored decomposed matches), and everything else is escaped,
  so `c++` and `(draft` are text. Latin only; a Greek or Cyrillic accent is
  matched as typed. Whitespace runs match any whitespace;
- **the length is capped** at `MAX_TITLE_QUERY_LENGTH` (100, in
  `constants/pagination.ts`; the box has the same `maxlength`) and the rest is
  ignored rather than refused;
- **the index is `{ userId, updatedAt, title }`**, which _replaces_ `{ userId,
updatedAt }` (`database.ts`). An unanchored folded regex cannot use an index
  for bounds, but with `title` as a trailing key Mongo tests it on the index
  entries and fetches only the matches: on 3,000 of one user's conversations
  with 24 KB of messages each, 2,959 documents fetched became 31 (and 0 for a
  search with no match). The old index has to be dropped, not kept beside it:
  with both, the planner keeps picking the narrower one and the search never
  gets the benefit. The list without `q` costs the same on either.

**Title only.** Searching message text is a different cost, not a bigger
version of this one. A regex over `messages.content` reads every message of
every conversation the person owns; a text index would hold every message of
every user and be rewritten on each turn, and it matches words and stems, not
the substrings a title search does. The sound way is the embedding/retrieval
pipeline the projects already have for "index past chats", which is per-project
and opt-in. It was left out on purpose.

**Signing out ends the session at both ends** (`routes/logout/+server.ts`), and
the second end is the one that was missing. `POST /logout` deleted the local
session and cleared the cookie correctly, then redirected to `/` — which re-ran
the OIDC flow, and the _provider's_ still-live session signed the person
straight back in with no prompt. From the outside, Sign out did nothing. It now
does RP-initiated logout: local session first (so a provider round trip that
never returns still leaves this app signed out), then the browser to the
`end_session_endpoint` with `id_token_hint` and back.

Three things that follow, all found by running it:

- **the id token is kept on the session** (`Session.oauth.idToken`) for exactly
  one purpose, `id_token_hint`. It was previously discarded;
- **Keycloak answers 400 for an unregistered `post_logout_redirect_uri`**, and
  `post.logout.redirect.uris = +` registers only the _login_ callback — not the
  app root the browser is sent back to. Register a wildcard under the
  published origin instead, which is safe only because the deployment serves
  one origin;
- **landing on a login prompt afterwards is the proof, not a fault.** The
  browser returns to `/chat/`, which is unauthenticated by then and bounces to
  the provider's login page.

A provider advertising no `end_session_endpoint` keeps the old behaviour
exactly: the local sign-out still happens, and `getOIDCLogoutUrl` returns
`null` rather than throwing.

One trap for anyone writing a check against the panel: matching a row by
`>Label<` fails for exactly the rows that carry a count badge, because the
label is then followed by whitespace and a `<span>`. Strip the tags and match
the text.

## The dialog language, and where it comes from

**A project is a page (`/projects/<id>`, `/projects/new`); models, MCP servers
and knowledge are tabs of the workspace page** (`/workspace`), and every manager
screen and the project page are drawn in the shape the MCP dialog gave this app — the design language's reference
implementation is still `src/lib/components/mcp/`. Read
`MCPServerManager.svelte` and `ServerCard.svelte` before adding a screen.

What it consists of, all of it in `src/lib/components/overlay/styles.ts` as
constants lifted verbatim from those two files:

- **sub-views switch inside one screen** on a `view` variable, rather than
  navigating — somebody managing knowledge is doing one task and should not
  lose their place at each step of it. In the overlay era that came with
  per-view widths (`w-[800px]` for a list, `w-[600px]` for a form); the
  workspace managers keep the switching and lost the shell, drawing inside the
  tab's card instead (`styles.EMBEDDED`);
- a **tinted summary strip** under the header: a `size-10 rounded-xl
bg-blue-500/10` icon tile, a count, a state, and the actions on the right.
  `bg-blue-50` when there is something, `bg-gray-100` and `grayscale` when
  there is not;
- **blue-600 as the single accent** — the only place blue is a fill rather than
  a tint is a primary button;
- **two-column gradient cards** (`bg-linear-to-br`) that tint blue when active;
- **rounded-full status pills** with an icon, in four tones;
- **dashed empty states** with a large muted icon and a primary call to action;
- a closing **Quick Tips** block, which is where the surprising rules go.

Three practical notes. `btn` is a project class, not a Tailwind one.
`bg-linear-to-br` is Tailwind 4's spelling and `bg-gradient-to-br` silently
does nothing. And the MCP dialog deliberately still inlines its own classes
rather than importing the constants — it is the definition, and moving it one
step away from itself would be the wrong direction.

**Old manager addresses redirect into the workspace.** `/knowledge` and
`/knowledge/<id>` redirect to `/workspace?tab=kb` (with the `id` carried over),
because people link to those addresses. `/projects` is the list of projects and
`/projects/<id>` one project's page (`ProjectPage`; `ProjectsManager` is only
the list now, and the overlay is gone). The one trap that caused — **a page body runs
on the server**, so a manager that fetched in its component body answered 502
with `Failed to parse URL from /chat/api/v2/...`. Every manager loads in
`onMount`, which the workspace tabs also rely on.

## Palettes: accent and background tone

**Settings → Application settings → Appearance** offers an accent (Blue,
Violet, Teal, Green, Rose, Orange) and a background tone (Gray, Slate, Stone),
stored as `Settings.accent` / `Settings.neutral` (`utils/palettes.ts`). The
theme (System, Light, Dark) is separate and stays in `localStorage`. Three
things to know:

- **The defaults are the absence of an attribute.** `paletteAttributes()` emits
  `data-accent` / `data-neutral` on `<html>` only for a non-default choice, so
  a person who never picked one, and a page drawn before settings load, is the
  unthemed app. `hooks/handle.ts` fills `%paletteAttrs%` in `app.html` from the
  stored settings (`server/paletteSettings.ts`), so there is no flash.
- **`src/styles/palettes.css` is generated** by `scripts/generate-palettes.mjs`
  (then `npx prettier --write` on it): edit the tables in the script, never the
  CSS. Every shade is the sRGB hex Tailwind's oklch value clips to, because
  `palettes.contrast.test.ts` measures what the browser paints and Tailwind 4
  emits no `--color-teal-*` variable that nothing uses. The contrast test holds
  every combination to 4.5:1 in light and dark.
- **Palettes are Cerea-only.** `tokens.css` stays a byte copy of Pystino's; the
  palettes override it from their own file. The swatch colours in
  `utils/palettes.ts` are checked against the CSS by a test.

## Translations: messages, locales, and the check

The app's words are moving, area by area, into one catalogue,
`messages/en.json`, read through Paraglide JS (inlang) the way the Pystino
console does it, with the same key style, the same `en-XA` pseudo-locale and the
same `i18n:check`. English is the only language that ships; the machinery is
here so that adding a language is a file, not a change to every screen.

**Converted so far:** every screen: Settings, chat (conversation, composer,
messages), sidebar and navigation, connectors, the app shell and its shared
components, projects, models, skills, knowledge, memory, admin, the Code area
(`src/routes/code`, `src/lib/components/code`) and the Workspace area
(`src/routes/workspace`, `src/lib/components/workspace`). The list is `CONVERTED` in
`scripts/i18n-check.mjs`. Everything else still spells its words in the
template, which is correct until its area is converted.

**Adding a string** (in a converted area, or one you are converting):

1. Add the key to `messages/en.json`: `area.screen.thing`, lower snake_case words
   joined by dots, e.g. `settings.notifications.devices.remove`. A message with a
   value in it uses `{name}`; a count uses a plural variant (see
   `settings.notifications.notice.sent`); a bit of markup uses `{#tag}text{/tag}`.
2. Use it: `import { m } from "$lib/paraglide/messages";` then
   `{m["settings.title"]()}` or `m["settings.notifications.notice.removed"]({ label })`.
   Write the key as a literal (`m["a.b"]`, never built from a variable): the check
   finds keys by reading them. To choose between messages, keep the functions in a
   lookup table (`{ blue: m["settings.application.accent.option.blue"] }`).
3. Markup: declare a snippet per tag, then
   `<Rich parts={m["key"].parts({ ... })} tags={{ code }} />` (`$lib/i18n/Rich.svelte`). The words and their order are the translator's, the
   look is the template's.
4. Run `npm run i18n:pseudo` (regenerates `messages/en-XA.json`) and
   `npm run i18n:check`.

Words that are not words (the product name, a command, a value from the API) stay
literal, on a line that says so: `<!-- i18n: literal -->` in a template, or
`// i18n: literal` in a script (`i18n: server text` for text that came off the
wire). Numbers, dates and relative times never go through `toLocaleString` with a
hard-coded tag: use `$lib/i18n/format` (`formatNumber`, `formatDate`,
`formatDateTime`, `formatRelativeTime`, `formatCurrency`), which follow the
page's language, not the browser's.

**Converting an area:** replace its strings with messages, add the directory to
`CONVERTED` in the same commit, and `npm run i18n:check` then fails on any word
that slips back into a template there (text between tags, and `title`,
`placeholder`, `aria-label`, `alt`, `label`). The check also fails on a key used
but missing, a key in `en.json` that no code uses, an out-of-date `en-XA.json`,
and a real locale that lost a key or a `{placeholder}`. It runs in `npm run lint`
(so in CI's check job). Strings in `.ts` helpers (an error message built in
`utils/`) are not scanned: convert those by hand when you convert their caller.

**Adding a language:** copy `messages/en.json` to `messages/<tag>.json` and
translate the values (keys and `{placeholders}` unchanged), add the tag to
`locales` in `project.inlang/settings.json`, run `npm run i18n:check`. It appears
in Settings → Language by itself, written in its own name.

**Which language a request gets** is decided once, in `hooks/handle.ts`, by the
pure `resolveLocale` (`src/lib/i18n/resolve.ts`): the person's saved choice
(`Settings.locale`, saved through the same two settings endpoints as the palette,
so it follows them across devices), then the `cerea_locale` cookie (what the
selector wrote in this browser), then `Accept-Language`, then English. The render
runs inside Paraglide's per-request store (`server/requestLocale.ts`), so
concurrent requests never see each other's language; `%lang%` in `app.html`
becomes `<html lang>` in the first chunk; the root layout returns the answer as
`data.locale` and the browser adopts it before its first render
(`adoptServerLocale`), so hydration matches the HTML. Changing the language in
Settings saves it, sets the cookie and reloads: messages are plain strings, not
reactive. Changing the browser's language does nothing for a person who has
chosen one, and that is the point of choosing.

**`en-XA`** is English with every message accented and bracketed, so a string
that is still hard-coded stands out on screen. It is a developer tool: it is
offered in Settings → Language only under `vite dev` or with
`CHAT_PSEUDO_LOCALE=true`, it is never selected from `Accept-Language`, and the
server ignores it from the cookie or the saved setting where it is not enabled.
Pick it in Settings (dev), or set the `cerea_locale` cookie to `en-XA`.

`src/lib/paraglide/` is generated (by the Vite plugin, and by
`npm run i18n:compile`, which `check` and `i18n:check` run first) and is not
committed. The compiler options are in `project.inlang/paraglide.config.ts`.

## Projects and knowledge bases

The knowledge pipeline is **ours**: bases, documents, chunks,
vectors, sharing and reindexing live in this application — Mongo for the
things a person names, and a chat-owned Postgres (`CHAT_PG_URL`, pgvector) for
the passages and vectors. The gateway kept only the two inference services the
pipeline consumes: `POST /v1/embeddings` (catalogue-managed, metered to the
acting user's token) and `POST /v1/ocr` for reading documents. The browser's
paths did not move — `/api/v2/gateway/vector_stores/…` and `/files` are
served in-process by `src/lib/server/knowledge/`, behind the same forwarder
and its allowlist; only the handling is local now. Projects are **ours**
because a project groups _conversations_, and those live in Mongo.

`src/lib/server/projects.ts` and `src/lib/server/knowledge/` are the whole of
it. Read the header of `src/lib/types/Project.ts` first; the parts that will
bite:

- **Postgres refuses a 24-hex ObjectId as `uuid`, and a pgvector type
  modifier cannot be a bind parameter.** `toUuid`/`fromUuid` (`db.ts`) are
  the boundary — pad to 32 hex, format; read back by taking the first 24. The
  search SQL formats the width into the cast (`::halfvec(N)`) because
  `::halfvec($1)` is a prepare-time _syntax_ error — an int from a checked
  range, never caller input. Ranking runs in half precision through partial
  expression indexes on `dimensions` (384…3072); storage stays full precision
  in an untyped `vector` column, because a fixed width would make changing
  the embedding model a schema change instead of a reindex.
- **Sharing is decided against the viewer's own identity** — their email and
  the groups `GET /v1/me` reports for _their_ token. Nothing asks the gateway
  who is in a group, because a bearer token cannot ask and a route that could
  would let a chat client enumerate the directory. The cost is that a share
  names a principal that may not exist: a typo and a colleague who has not
  signed in yet are indistinguishable.
- **A shared project is a shared workspace.** Everyone who can see it sees
  every conversation in it. The project page says so.
- **Sharing a project shares no documents.** Retrieval runs with the reader's
  own identity, so they see passages only from bases they could already read.
- **Retrieval never fails a turn.** Every error is logged
  (`project_retrieval_degraded`, `project_memory_index_failed`) and swallowed:
  a base being unavailable is a reason for a worse answer, not for none.
- **Indexing past chats is idempotent by handle.** The transcript is stored
  under `source_ref = chat:conversation:<id>`, which _replaces_ rather than
  appends — otherwise a ten-turn thread leaves ten overlapping copies and
  every search returns all of them.
- The memory base is an **ordinary knowledge base**, visible on the Knowledge
  screen and deletable there, named after its project. That is deliberate: the
  transcripts are somewhere a person can look.

### The project page, and what a project puts in a prompt

`components/projects/ProjectPage.svelte` is two tabs of one page, addressed like
the workspace panel: **Conversations** (the default — the strip with the count
and New chat, then the list of the project's chats) and **Settings**
(`?tab=settings` — everything that configures the project). A query change never
remounts the page, so the loaded project and unsaved edits survive a switch;
`/projects/new` has no tab bar, since everything it makes is settings.

The Settings tab's sections are the **five context levels** in the order
`projectContext` (`server/projects.ts`) builds the prompt — the one function
that assembles project context, and the order is part of its contract
(`projectContext.spec.ts` asserts it):

1. standing instructions (in full);
2. context documents (in full);
3. project memory (in full);
4. knowledge bases (searched);
5. past chats (searched).

The page's explainer lists the same five. Levels 2 and 3 re-check that the
person running the turn can still see the project (`projectForMember`): they are
what members write into each other's prompts. 4 and 5 share one retrieval
budget and are rendered as two blocks. Saving: the text fields and options share
one Save; actions (attach a base, a document, remove a chat) happen at once,
because unsaved attach state is how a base looks attached when it is not.

**Context documents** (`server/projectDocuments.ts`, `ProjectDocumentsSection`):
files whose extracted text goes into every prompt of that project. They go
through the chat's own writer (`writeAttachment`: same sniffing, extractor,
failure reasons, legacy `.doc`), once, at upload, owner-keyed `project:<id>` in
GridFS with the row's id as `messageId`; plain text gets an extracted entry of
its own so every document is read from one place. The budget
(`PROJECT_DOCUMENTS_MAX_CHARS` 100,000, warning at 50,000, beside the memory
limits in `types/Memory.ts`) is enforced where the cost is known: a project
already full refuses _before_ extracting (the extractor bills per page), a file
that tips it over is extracted, refused and removed, and a re-check after the
insert closes the race between two uploads. A failed extraction is a `failed`
row with its reason and contributes nothing. Files only: no `webkitdirectory`,
and `readDrop` refuses a dropped directory. Everyone who can see the project can
add and remove (like notes); the row keeps the uploader for display. Project
delete (`deleteProjectDocuments`), erasure (the `projectDocuments` roster entry,
which runs before `projects`) and the orphan sweep (`project:<id>` keys with no
project) all clean up the bucket entries — a `project:` tag the sweep did not
know would have been left alone for ever.

**Removing a chat from a project** (`DELETE /api/v2/projects/<id>/conversations/<cid>`)
is exactly what project delete does to each chat: clear `projectId`, then
`deleteDerived` its transcript from the project's memory base. The chat's author
or the project's owner may.

**Moving a chat in, between and out** is one operation, `PATCH
/api/v2/conversations/<id>` with `{ projectId: string | null }`
(`server/conversationProject.ts`; the DELETE above delegates to the same
detach). Into a project or between projects: the chat's author only, who must
also have access to the target (404 otherwise, like every project route). Out:
the author or the owner of the project the chat is in. Leaving a project calls
`deleteDerived`; entering one calls `indexConversation` with the whole existing
thread (it is whole-thread and idempotent by handle, so there is no per-message
backfill), not awaited. Instructions, documents and memory are read from
`projectId` every turn, so they apply from the next message. The UI shares
`useMoveConversation` (sidebar store, Projects tree, toast) between the row
menu, the picker (`MoveToProjectModal`), the sidebar drag (`chatDrag`) and the
project page's `MoveMenu`.

### Attaching a document to a message

A PDF or an Office file is bytes no model reads. `POST /v1/ocr` in the gateway
turns one into markdown, and `src/lib/server/files/extractDocument.ts` calls
it. The two things to know:

- **Extraction happens once, at upload**, and the text is stored beside the
  file as its own GridFS entry, named by `MessageFile.extracted`. That is a
  **billing** decision, not a caching one: `/v1/ocr` is priced per page, so
  re-extracting per turn charges for the same twelve-page PDF on every question
  about it. `scripts/test_attachments_live.py` asserts the count from the
  gateway's ledger, which is the only place that can tell the two apart.
- **A document with no readable text is not dropped.** `preprocessMessages`
  puts a sentence saying so in its place, because an attachment silently
  omitted makes the assistant answer as though nothing was attached while the
  person watching sees their file in the transcript.

Which model extracts is the Knowledge screen's choice, else `CHAT_OCR_MODEL`,
else the first `kind: ocr` model the caller may use. **A deployment with no
gateway at all skips that chain**: `CHAT_OCR_BASE_URL` (with
`CHAT_OCR_API_KEY` and a required `CHAT_OCR_MODEL`) makes extraction post to
`{base}/ocr` directly, which works because Pystino, Mistral and Cortecs serve
one shape. Set, it overrides the gateway path rather than falling
back to it, reads PDFs only, and caps a document at 10 MB — the base64 body of
a 20 MB PDF is ~27 MB and no vendor's limit for it is known. Unset, nothing
about the above changes. The deployment's own
extractor is not a special case — it is an ordinary model row on the gateway
whose provider is the local extractor service, and it shows up in the
catalogue like any other reader. There is no value that means "extract
nothing": one existed, and a deployment that held it read no documents while
being told it would. A model embedding wider than the store indexes (halfvec
stops at 4000) is MRL-truncated to the largest width the schema covers, and
the base's recorded width is what every later embed — search included — asks
for.

Two things found only by running `scripts/test_projects_live.py`, both worth
knowing before touching the model picker or writing another live check:

- **The model catalogue is global.** `src/lib/server/models.ts` builds it once
  at startup with the deployment's own key, so every account sees the same
  list. What it means is that this list cannot hide a model the way the
  gateway's per-caller `/v1/models` does. Per-user filtering would mean the
  catalogue stops being module state.
- **A turn is a multipart post**, with the JSON in a `data` field, needing an
  `Origin` header past the CSRF guard, and a first user message still needs
  its parent id — the create puts a system message at the conversation's root
  and `addChildren` refuses to guess. A JSON body there is a 500 from undici
  before any of this app's code runs.

## Skills: built-ins, bundled files, and the seeding rule

Built-in deployment skills live in two places, unified by
`src/lib/server/skills/builtinSkills.ts`: the three original inline seeds in
`adminSkills.ts` (csv-shaping, report-writing, json-shaping), and the
directory skills under `src/lib/server/skills/builtin/<name>/` — `SKILL.md`
plus bundled `scripts/`, `references/`, `assets/` files, with the upstream
`LICENSE.txt` and a `SOURCE.md` (provenance: repo URL, commit SHA, what was
changed and why) sitting beside `SKILL.md`, never seeded. The directories are
read through Vite `?raw` globs and inlined into the server bundle — the
container copies only `build/`, so a runtime filesystem read would not
survive the image. `?raw` decodes as UTF-8: **bundled files must be text**; a
binary asset embeds base64 inside the script that uses it (the powerpoint
skill's template does exactly that).

Everything goes through the same validation the zip import uses
(`parseSkill`, `validateSkillFiles`); a definition that fails is dropped with
a logged reason and never seeded — a broken built-in must never fail a turn.

**The seeding rule** (`ensureDeploymentSeeds`): each seeded row stores the
definition's sha256 as `seedHash`. On boot, a built-in whose definition
changed replaces the row only when the row's current content and files still
hash to the stored `seedHash` — nobody edited it since seeding. An
administrator's edit is never overwritten, and `enabled` is never touched.
The update carries an equality filter on content and files, so a concurrent
edit between read and write wins instead of being clobbered. Rows seeded
before `seedHash` existed are stamped when their content still matches the
current definition, left alone otherwise. To change a built-in's shipped
definition: edit the directory (or the inline string), bump nothing else —
the next boot upgrades every unedited deployment automatically; edited rows
keep the admin's version until they delete the row (it re-seeds fresh).

Adding or updating a built-in: copy the upstream skill folder, keep its
`LICENSE.txt` verbatim, write the `SOURCE.md`, adapt the body for the
execution model (Pyodide only: no shell, no subprocess, no network in the
sandbox; verification is reading files back, never rendering), add every
upstream attribution to `NOTICE`, and cover the skill's scripts in the
Pyodide check (`scripts/pyodide_skills_check.mjs`). Licences: OSI-approved
only; never source from Anthropic's proprietary `docx`/`xlsx`/`pptx`/`pdf`
skills or from "awesome skills" aggregates; OpenAI's removed skills come from
OpenAI's own git history, never a third-party copy.

## The /code Agents panel

`agent/PROTOCOL.md` is the wire protocol, binding for both this app and the Go
agent, `galopin`, which lives in this repository as `agent/`. Coding agents run on
**the person's own machine**, supervised by one binary that dials **out** to
this deployment over WSS with its own OIDC credential — no relay in between,
nothing capability-bearing at rest in Cerea. `docs/code-panel.md`
is the operator guide and `docs/agent-machines.md` the user's getting-started page and
`docs/agent-machines-reference.md` the user's reference (it also
covers building, installing and running `galopin` itself); what matters when
changing the code:

- **`CODE_AGENTS_ENABLED` must be exactly `"true"`.** Off hides the
  Chats/Agents switch, 404s `/code` in `+page.server.ts`, and refuses the
  pairing endpoints as a backstop.
- **The machine link is a raw WebSocket upgrade, not a SvelteKit route.**
  `server.js` (production) and `vite.config.ts`'s dev plugin both forward
  `GET /api/v2/code/machine` upgrades to a function the app registers on
  `globalThis[Symbol.for("cerea.machineUpgrade")]` from `initServer()`
  (`src/lib/server/code/machineServer.ts`). It never reaches
  `hooks/handle.ts` at all.
- **The bearer is validated locally, never via userinfo.**
  `src/lib/server/code/machineAuth.ts`: JWKS from the issuer's discovery doc
  (cached), `iss`/`aud`/`azp`/`exp` checked, `sub` mapped to a Cerea user the
  same way the login callback does. No user → the upgrade is refused with a
  plain HTTP 403 before it completes.
- **The registry (`src/lib/server/code/machines.ts`) is a plain in-process
  `Map`, lost on restart.** `MachineLink` is cheap to construct for any
  device id — every method looks the live connection up at call time, so a
  link for an offline machine rejects instantly (`unavailable`), never hangs. Pairing happens on first `hello` (a `pending` row); a browser
  confirm flips it to `paired` and pushes a `status` frame down the socket —
  a fresh human approval of every new machine. Revoke tombstones the row
  (`status: "revoked"`) rather than deleting it, so a reconnect under the
  same `machineId` is refused.
- **The browser never reaches the machine directly.** Every call goes to
  Cerea, through `MachineLink`. `routes/api/v2/code/[...path]/+server.ts` is
  the forwarder, and its allowlist maps each permitted browser path to
  exactly one typed op (spec §6). Timeline streams, pairing hooks and
  anything beyond one backend's sessions are deliberately absent; read that
  file's header before adding anything.
- **The SSE bridge is cursored on the machine's own `epoch`/`seq`**
  (`agents/[id]/stream/+server.ts`), not an invented replay counter — an
  epoch change (the machine's process restarted) sends a `reset` frame down
  the _same_ update channel `consumeAgentUpdates.ts` already parses, and the
  connection's listeners migrate across a machine reconnect
  (`machines.ts`'s `onHello`) rather than going silently stale.
- **The bridge ends its history replay with a `historyDone` frame**
  (snapshot + seam, before the live tail), and, just before it, a
  `historyMeta` frame when the snapshot was paged (below). Both are
  Cerea-internal — no machine ever sends them, PROTOCOL.md does not know them —
  and the agent view gates its
  first paint on it (`ChatMessageColumn`'s `historyPending`): the transcript
  folds behind a loading skeleton with the turns unmounted, then mounts once
  and lands at the bottom before paint. Folding into the rendered list was
  the real cost of opening a long session (1,000 messages: ~2 minutes to
  first content, measured); the gate also makes the landing independent of
  whatever the reader did while waiting, because a skeleton cannot scroll.
- **A long session arrives as its newest page, and older pages load on
  scroll.** When the machine advertises `historyPaging`, the bridge asks
  `session.sync` for only the newest 40 messages (`SNAPSHOT_PAGE_LIMIT` in
  `agents/[id]/stream/+server.ts`) and sends `{type:"historyMeta", hasMore,
before?}` ahead of `historyDone`; without the capability (an older galopin,
  or an ACP backend) the snapshot is whole and no frame is sent, so nothing
  pages. `AgentView.svelte` keeps `historyHasMore`/`historyBefore` from it and,
  when the reader scrolls within about a screen of the top, fetches
  `GET v1/agents/:id/history?before=&limit=` (the forwarder's `session.history`
  route, pages of 40, converted by the same per-message code as the snapshot)
  and prepends the page through the column's anchored prepend, so the visible
  message does not move. One fetch at a time; one started before a rebuild
  (rollback, new epoch) is discarded. The head of the list says "Loading
  earlier messages…", "Couldn't load earlier messages. Retry" or "Start of the
  session".
- **Recent sessions reopen from an in-memory cache, then refresh.**
  `stores/agentTranscriptCache.ts` keeps the last 8 sessions (newest 400
  messages each, plain snapshots, memory only, never localStorage) saved on
  leaving a session and at `historyDone`. A hit renders at once with no
  skeleton, folds the fresh replay into a separate `$state` array
  (`staging`), and swaps it in at `historyDone` through the column's
  `replaceWithAnchor` (the very array the fold keeps appending to). Until the
  swap the copy is display-only: no paging, retry/edit or fork, and a
  permission card refuses to answer. A rollback/undo, a new epoch, deleting
  or archiving the session, and sign-out invalidate it.
- **A provider retry is shown, not hidden.** opencode's `retry` status
  (PROTOCOL.md §7: `retry {attempt, message, next?}`, also `Transcript.retry`
  in a snapshot) becomes a running turn carrying `retry` (`machineTimeline.ts`
  `statusToTurnState`), and `RetryNotice.svelte` renders "Retrying — <provider
  message> (attempt N, next try in S s)" under the transcript while the turn
  runs, so a rate limit does not read as a hang. A galopin without the field
  shows a plain running turn.
- **Tool-output images are references, never bytes on the stream.** A tool
  part lists `attachments` (`sha256`, `mime`, `size`); `machineTimeline.ts`
  maps them to `{type:"image", url}` blocks pointing at the forwarder's
  `v1/agents/:id/attachments/:sha256` route, which calls `session.attachment`
  and judges the bytes itself (`server/code/toolImages.ts`: magic numbers, not
  the claimed mime; ≤50 megapixels; ≤8 MiB; must hash to the sha). Nothing is
  persisted in Cerea. SVG is never inline.
- **The panel owns mutations, the pane owns display.** `CodeNavTree.svelte` has
  every dialog and every write; `CodePanel`/`AgentView` render whatever
  `?device=&ws=&agent=` names, and a new address remounts the view. Removals
  confirm, then redraw from the machine's answer — never an optimistic
  splice, because the machine owns the listings. The paired-device list
  itself is one shared poll (`$lib/stores/codeDeviceList.svelte.ts`) — do not
  reintroduce a second one alongside it.
- **The machines and sessions list outlives the tree (stale-while-revalidate).**
  The device list (`codeDeviceList`) and each device's workspaces and sessions
  (`stores/codeTreeCache.svelte.ts`) are module state, so returning to `/code`
  draws the last list in the first frame, with no loading state. Entering the
  panel re-reads only what is older than the 8 s poll interval
  (`CODE_LIST_STALE_MS` / `CODE_CACHE_STALE_MS`); focus and app-resume re-read at once; the 8 s poll
  runs while the panel is open. Every read folds in place
  (`utils/reconcileById.ts`: unchanged rows keep their objects, so keyed rows
  do not re-render). A failed tree read keeps the rows and flags the device
  "Offline." above them. The cache is per person: `NavFooter`'s sign-out calls
  `clearCodePanelCache()` beside the drafts, `bindCodeCacheOwner(user.id)`
  empties it on an account switch, and a stale sign-in drops it.
- **The agent view is the chat's own machinery.** `ChatMessageColumn`,
  `ChatInput`, the approval card, the shared side pane. That is what makes
  live updates arrive by construction; a bespoke stack here would be a second
  thing to keep working.

## Scheduled actions: the framework and the executor contract

A schedule is a row someone owns that says "at these times, do this". **The core
is kind-agnostic** (`src/lib/server/schedules/`); only `kind: "agent"` exists,
and **a "chat" runner must be one new file plus its registration, with no change
to the core.** The pieces:

- `recurrence.ts`: presets (every N hours, daily, weekdays, weekly) and a cron
  expression, validated and iterated with **croner** (MIT, no dependencies;
  wall-clock times in an IANA zone, DST: a skipped time runs once at the first
  instant that exists, a repeated one once at the first). The **15-minute floor**
  is enforced here only: a cron expression is sampled and refused if any two of its
  next 400 occurrences are closer, and a seconds field is refused. "Every N hours"
  counts elapsed hours from `anchorAt`, not clock hours.
- `scheduler.ts`: the loop (30s, started in `hooks/init.ts` like the sweepers).
  `claimDue` takes one due row with a single `findOneAndUpdate` whose filter pins
  the `nextRunAt` it read and a free lease, and whose update **advances
  `nextRunAt` first** and sets the lease; two instances cannot both win. Lateness
  past 2 minutes is downtime: one catch-up if under half the interval late (cap
  1h), else a `missed-downtime` row. Three consecutive `failed` runs disable the
  schedule (the core counts, executors do not). `runNow` takes the same lease.
- `store.ts`: owner-scoped CRUD. Another person's id is a 404, never a 403. The
  per-user cap (`CHAT_SCHEDULES_MAX_PER_USER`, 20) is settled after the insert, so
  racing creates cannot exceed it. `limits.ts` holds the kill switch
  (`CHAT_SCHEDULES_ENABLED`, on unless exactly `false`).
- Two collections: `schedules` and `scheduleRuns` (a row per occurrence
  _considered_, fired or not: the audit record, TTL 90 days). Both are in
  `identity/userKeyedCollections.ts` (erased with the account, moved on a merge).

**The executor contract** (header of `executors.ts`, the source of truth):

```ts
registerExecutor({
  kind: "agent",
  available?: () => boolean,          // false: the core leaves its rows alone
  validateTarget(target, { userId }), // -> { ok, target } | { ok: false, error }; check what the CALLER owns
  describeTarget(target, { userId }), // -> short label for a list; cheap, never throws
  run({ schedule, scheduledFor, trigger, previousRun, now }), // -> { status, detail?, result?, disable? }
});
```

`target` is opaque to the core. `run` returns what happened (`sent`,
`skipped-still-running` after looking at `previousRun`'s output, `missed-offline`,
`failed`) and `disable` switches the schedule off with a reason. The core never
imports an executor; `hooks/init.ts` imports the executor files for their
registration.

**The agent executor** (`server/code/scheduleAgentExecutor.ts`) uses `MachineLink`
ops: the panel's own (`session.create`, `session.setMode`/`setModel`,
`session.setPermissionMode`, `session.prompt`) and, for the two coordination
options, galopin's `session.grantCoordination`. Its target is `{ deviceId,
workspaceId, sessionMode: "new" | "existing", sessionId?, modeId?, modelId?,
permissionMode, canMessage?, canSpawn?, labels }`; the device must be the
caller's own, paired. Things that bite:

- a session a schedule starts is titled `<name> · YYYY-MM-DD HH:mm`; the tree
  marks it with a clock by matching that tail (`isScheduledTitle`), not by a wire
  field;
- the permission word is set **before** the prompt, and for "always this session"
  it is set on that session and stays; the machine's ceiling caps it as everywhere;
- **coordination is a grant, not a rule.** `session_list`/`session_read`/
  `session_send`/`session_spawn` are what a grant names (a session on Allow
  also spawns and sends without one when the ceiling and the machine's rules
  leave the tool alone, but never reads), and no op writes a
  rule (`session.setRules` is retired). The two options (`canMessage`: list,
  read, send; `canSpawn`: spawn; both off by default, `utils/coordination.ts`
  maps them) become one `session.grantCoordination` after the session exists
  and **before the prompt**; galopin composes it as allows beneath the ceiling,
  so a capped key still asks and another workspace still asks. A machine that
  cannot take it (`backends[].capabilities.coordinationGrant` absent in its
  hello, `policy.agentTools: "denied"`, or the op answering `unsupported`) runs
  the prompt without it and the run row says why; any other error fails the run
  before the prompt. A pinned session whose options are off has its grant
  cleared (`keys: []`) on a machine that supports it, so "off" means off. The
  editor and the executor read `utils/coordination.ts` for the wording, so the
  warning and the run row cannot disagree;
- **agents make schedules too**: `server/code/machineCalls.ts` answers the
  machine's `call` frames (`schedule.context|list|create|update|delete`) as the
  device's owner, through `createSchedule`/`updateSchedule` and this executor's
  `validateTarget`, with the agent's own refusals on top (mode no looser and
  coordination no wider than the caller's, 5 running agent-made schedules per
  machine, 10 changes per machine per hour with pause/delete exempt, this
  machine's schedules only). Its `agentMode` is the target's `modeId`
  (default `build`, not bounded by the caller). `createdBy` is passed by the caller of
  `createSchedule`, never read from a body; the welcome advertises
  `features.machineCalls`. Specs: `machineCalls.spec.ts`, and `FakeMachine.call()`
  sends a `call` from tests;
- **every scheduled prompt starts with one header line**
  (`schedules/runHeader.ts`): `[Scheduled run of "<name>", <timetable>
(<timezone>); previous run <ago | none>; coordination: <keys | none>]`, a
  blank line, then the prompt as written. It is not stored on the schedule.
  galopin's `delegation` skill (`agent/internal/backend/opencode/skill.go`) has
  a "When you run on a schedule" and a "Scheduling work" section that read it;
  change the header and the skill together;
- API: `/api/v2/code/schedules` (+ `/[id]`, `/[id]/run`, `/[id]/runs`, `/preview`).
  It is under `/api/v2/code/`, so the 7-day sign-in guard covers it by prefix;
  `stale-guard.spec.ts` lists every route file and fails on a new one.

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

## Document tools (`doc_outline`, `doc_read`, `doc_edit`, `doc_create`, `doc_create_from_template`)

ADR 0103. The `documents/` service (Python, own CI job, own image
`cerea-documents`, versioned with the chat) edits Word, Excel and PowerPoint
files; the chat reaches it at `CHAT_DOCUMENTS_URL` with `CHAT_DOCUMENTS_SECRET`.

- `src/lib/server/documents/client.ts` is the client: deadline, error mapping
  (401/413/415/422/504 to plain messages), `getCapabilities()` cached a minute
  (shorter after a failure). `runMcpFlow` resolves it per turn and hands it to
  `getEnabledBuiltinTools({ documentCapabilities })`; null means no `doc_*` tool.
- `builtinTools/documentTools.ts`: `doc_edit`'s text is **generated from the
  service's `operation_schemas`** in `/v1/capabilities` (one source of truth),
  and only operations the service lists are offered. A new service operation
  needs no change here. `documentsContract.spec.ts` checks every operation in
  `capabilities.fixture.json`, which `documents/tests/test_api.py` keeps equal to
  the live service: regenerate the fixture (command in the spec) when the service's
  schemas change.
- Files are named as `convert_document` names them (`conversationFiles.ts`:
  attachments by their `/mnt/data` name, produced files by name, this
  conversation only, access re-checked on every read). The document tools prefer
  the newest **produced** file of a name over an attachment of the same name, so
  edits chain.
- An edit is stored with `storeDeliverable` under the **source's name** (the
  next version of the same file artifact, which `collectFileArtifacts` folds by
  name), with `derivedFromSha256/Name` on the store row, and listed through an
  `Outputs` update (`runKey` `doc_edit:<uuid>`, so it renders as a file card).
  The original is never touched.
- Creation (step 3): `doc_create` and `doc_create_from_template` are offered
  when the service reports `create` / `create_from_template`, and their text is
  **generated from `create_schemas`** the same way (`describeSchema`; the theme,
  a text run and a table cell are printed once as shared aliases; a format whose
  schema equals an earlier one, PDF and Word, is printed as "the same"). The
  created file is stored under the requested or title-derived name (creating again
  under a name is the next version; `derivedFrom` records an uploaded template),
  and listed through an `Outputs` update like an edit. `theme.template` is a file
  name in the conversation: the tool sends its bytes as the `file` part and
  rewrites the name to the bare file name. The skills (`word`, `excel`,
  `powerpoint`, `pdf`) carry one rule, "the `doc_*` tools are the ONLY way", with
  the sandbox method in a labelled last "Fallback" section; `officeSkills.spec.ts`
  pins that wording, so a change to a skill must keep the two apart. The execution
  prompt's generic "write binary files with python-docx..." sentences name the
  same exception.
- Decks (`documents/src/cerea_documents/make_pptx.py`, schema in `spec.py`): six
  built-in 16:9 layouts, body text 24/22/20/18 pt stepping down to 14 pt (below
  16 pt a note suggests splitting the slide), content kept below the title.
  A slide takes a `background` (colour, two-colour gradient, or a picture
  `fit: "cover"`; `theme.slide_background` for all) and up to 30 `shapes` (`rect`,
  `rounded_rect`, `ellipse`, `line`, `arrow`, `chevron`, `text`; cm on the slide;
  `layer` back by default, so behind the placeholders). Shapes with text (a `text`
  kind, or `text`/`runs`) must lie fully on the slide; a **decorative** shape may
  **bleed** (`x_cm`/`y_cm` from -50) if at least `MIN_SEEN_CM` (0.5 cm) shows on
  both axes (`_bleeds`, `_check_shape_bounds`, all checked before anything is
  built, so a 422 names `slides[i].shapes[j]`, the values and the slide size).
  Warnings, not errors, go into the result's notes: contrast under 4.5:1 of the
  theme's text colours on a solid background, a shape over a placeholder or
  content (`OVERLAP_CM`), overflow. `theme.slide_background` and the shapes are
  new in 0.31.0, the bleed in 0.31.1.
- Range errors from the schema check (`spec.py` `_check`, `_friendly`) state the
  field, the value and the allowed range ("-70 is less than the minimum (-50);
  allowed range -50 to 100"); `properties`/`required` are put in the details only
  for `additionalProperties` and `required` failures, where the parent's keys
  help.
- The tool card shows object arguments. `ToolCall.parameters` holds primitives, so
  `mcp/toolParams.ts` `toPrimitive` keeps an object or array argument (a document
  `spec`) as compact JSON text, cut at `MAX_PARAM_JSON_CHARS` (20,000) with a
  visible "... (N more characters)" and not dropped. `ToolUpdate.svelte`
  pretty-prints JSON text that parses (`expandJsonText`) and shows cut text as it
  is. It applies to every tool, not only the document ones.
- The PowerPoint skill: the tools are the default; an **explicit** request for a
  custom design the tools cannot express (free-placed cards, an infographic) is
  built in the sandbox from the skill's "Fallback" section, said in one line, and
  never mixed with the tools in one deck; an unclear request asks through
  `ask_user_question` with two options. `officeSkills.spec.ts` pins the wording.

## Office previews and `convert_document`

Optional, per deployment: the kit's `office` profile runs Gotenberg (LibreOffice
and Chromium) on an `internal: true` network reachable by the chat only, and
`CHAT_GOTENBERG_URL` tells the chat where it is. Unset means off everywhere.

- `src/lib/server/office/gotenberg.ts` is the client (deadline, size caps, PDF
  check, at most 3 conversions in flight). `CONVERTER_VERSION` is part of every
  preview's cache key: **bump it when the Gotenberg image or the conversion
  options change**, and previews are made again on their next view.
- `previewStore.ts` keeps previews in the chat's GridFS bucket as
  `preview-<version>-<sha256 of the source bytes>`, deliberately without a
  `metadata.conversation` tag. `metadata.owners` lists the source files using
  one (`att:<conversation or share id>-<stored sha>`, `out:<conversation>-<sha256>`,
  i.e. the source's own GridFS name). Everything that deletes files calls
  `releasePreviewOwners` / `releasePreviewOwnerStrings` (conversation delete,
  deliverable delete and retention, share delete, account erasure), and the
  entry goes with its last owner. `sweepOrphanPreviews`, run by the daily orphan
  sweep, drops owners whose source no longer exists and old-version entries.
  A new path that deletes attachments or deliverables must release owners too.
- Lazy by default (`.../output/<sha>/preview` routes); model-produced Office
  files are converted when `storeDeliverable` stores them.
- `convert_document` (builtinTools) is registered only when Gotenberg is
  configured; the PDF is stored with `storeDeliverable` and listed through a
  `CodeExecution/Outputs` update.
- Without Gotenberg a `.pptx` is drawn in the browser by pptx-glimpse
  (`utils/pptxPreview.ts`): slides become `data:image/svg+xml` `<img>`s, never
  live SVG; fonts (OFL Carlito and Liberation, `static/fonts/office/`) are
  fetched only for the families a deck uses. `docs/office.md` is the user page.

## Push notifications (Web Push)

User page: `docs/notifications.md`. Code: `src/lib/server/push/`, `src/lib/pushWorker.ts`
and `src/service-worker.ts`, the Settings screen
`src/lib/components/settings/NotificationSettings.svelte`.

- **`web-push` builds the request, we send it.** `push/webpush.ts` calls
  `webpush.generateRequestDetails` (VAPID ES256 JWT, RFC 8291 aes128gcm) and
  never `sendNotification`. The send goes through `push/guard.ts`: https only,
  no private or internal destination (10/8 included, unlike the shared
  `urlSafety`), checked on the resolved address, redirects not followed. The
  RFC 8291 appendix A vector is decrypted in `webpush.spec.ts`; the package is
  MPL-2.0, unmodified, listed in NOTICE.
- **Off unless the keys are a pair.** `vapid.ts` returns null for unset keys, a
  wrong-length key, a public key that is not the private key's, or a subject
  that is not `mailto:`/`https:`; the API then reports `configured: false`, and
  Settings says so. The kit's `./configure` mints the pair once
  (`CHAT_VAPID_*`, pure-Python P-256 in `kit/configure`, never re-minted:
  a new pair strands every subscribed browser).
- **Where events come from** (`push/watch.ts`; every trigger is wrapped in
  `safely`, a push never breaks what it reports):
  - the machine link calls `observeMachineEvent` for every event frame
    **before** its "nobody is watching" return (a person with no tab open is who
    needs it): `permission.asked`/`question.asked` → `permission`; busy→idle on a
    root session after `LONG_TURN_MS` → `agentTurn`; a synthetic background-task
    part in state `error` → `backgroundTask`;
  - the scheduler's `record()` calls `afterScheduleRun`: a failed or missed
    dispatch is told at once, a `sent` one registers the session so the end of its
    turn is the run's end (one notification, not also `agentTurn`);
  - the generation writer's `finish` calls `chatTurnFinished` (default off).
    The in-memory turn and ask bookkeeping is bounded and lost on restart: that
    loses a notification, never sends a wrong one.
- **Cancelled background tasks (G8) are not an event**: galopin tells the parent
  agent, not the server, and a Stop is the person's own act.
- **Payload is thin and not sensitive** (`notify.ts`): title, one line, a path
  under the base, an icon. No message text, command, tool argument or prompt.
  Add a new event as an entry in `utils/pushEvents.ts` plus its trigger; the
  copy goes through `buildPayload`.
- **The focus check lives in the service worker**, because only the browser
  knows: `shouldShow` skips the notification when a window is visible and
  focused (the test notification always shows). The worker has no `fetch`
  handler and no cache, so registering it changes nothing about loading;
  SvelteKit registers `src/service-worker.ts` at `<base>/service-worker.js`.
- **Storage**: `pushSubscriptions` (unique `endpoint`, owner `userId`), in
  `identity/userKeyedCollections.ts` and the roster in its spec. The endpoint
  and keys never leave the server (`deviceView` sends a label, dates and a
  16-hex fingerprint the browser matches against its own endpoint). Per-event
  switches are `Settings.pushEvents`, written only by `PATCH /api/v2/push`: the
  general settings routes post a whole copy loaded at page open and would
  overwrite a toggle made since.

## The plan tool and sub-agents

Both are builtin tools (`textGeneration/builtinTools/`), offered to any chat whose
turn has tool calling on (`toolsEnabled`).

- **`update_plan`** (`planTool.ts`) persists `Conversation.plan` with a targeted
  `$set`, emits a `Plan` update, and `runMcpFlow` tail-injects the stored plan on
  the last user message each turn (`injectPlanState`) while the tool is offered.
  `ChatMessage` renders one `PlanCard` per message.
- **`delegate`** and **`research`** (`delegateTool.ts`) run `runNestedAgent`
  (`nestedAgent.ts`) on a fresh message array and return only the final answer
  (plus the pages it read, when its answer does not cite them). They are nested
  agent builtins: static definitions, bound to the turn's request plumbing in
  `runMcpFlow` (same `OpenAI` client, same `Authorization`/bill-to headers, so a
  sub-agent is billed to the person like the turn). `CHAT_DELEGATION` (admin
  screen `/admin/delegation`, `delegation.ts`) turns both off; the caller passes
  `delegation` to `getEnabledBuiltinTools` only when it is on.
  - Tools: web search/fetch/structured fetch plus the turn's MCP tools
    (`SUBAGENT_BUILTIN_TOOLS`); never `execute_code` (a parked browser call),
    `delegate`/`research` (depth one), the plan tool or the writers. `research`
    is the same loop with a fixed prompt and the three web tools.
  - Model: `model` is validated against `visibleModels(locals)` (what the person
    may use: tool-capable, not the router, never `custom:`), resolved by the
    caller; another model gets its own id and caps, none of the main model's
    sampling.
  - **Approvals are not relayed.** The approval card works by parking the turn
    and resuming it (`toolApproval.ts`, `resumeElicitation.ts`); a sub-agent is
    an in-memory loop inside one tool call and cannot be parked. So its MCP calls
    pass `createSubAgentApprovalGuard`: allowed under `always-allow` or when the
    conversation already approved `server:tool`, otherwise refused with a message
    the model reads, shown as "refused" on the card and named in the result so the
    main model can make the call itself (which asks the person). `web_fetch` and
    `web_fetch_structured` gate themselves in `execute`. Do not give a sub-agent a
    way to open an approval prompt without first persisting its loop.
  - Limits: 25 rounds, a cumulative token budget, an eight-minute deadline (the
    run then answers with what it has), three at once per turn (one counter for
    both tools), Stop through the turn's abort signal. The per-turn fetch caps live
    in the shared `web_fetch` instance, so they hold across sub-agents.
  - UI: a `SubAgent` update (re-sent whole, replaced by `uuid` in
    `applyUpdateToMessage` and `consumeMessageUpdates`) drives `SubAgentCard`;
    the card takes the answer or error from the call's own Tool result. The two
    replace-by-uuid copies must stay in step, like the final-answer merge.
