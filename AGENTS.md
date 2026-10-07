# AGENTS.md

This file provides guidance to coding agents working with code in this repository.

## Overview

Cerea is a SvelteKit application that provides a chat interface for LLMs. A fork of huggingface/chat-ui (the engine behind HuggingChat). The app speaks exclusively to OpenAI-compatible APIs via `OPENAI_BASE_URL`.

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
set -a; . /path/to/cerea-deploy/.env; set +a   # a running stack's variables
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
  `vitest --project=server --project=ssr`, so the **`client`** project — 18
  files, 234 tests, every Svelte component test — does not run. It needs a real
  Chromium through Playwright, and the image's browsers must match the
  _installed_ Playwright rather than the caret range in `package.json`
  (`node_modules/playwright` was 1.61.1 while the range said `^1.55.1`, and the
  mismatched image reports `no tests` plus a `Serialized Error: { log: [] }`,
  which says nothing about the cause):

  ```bash
  docker run --rm -v $PWD:/chat -w /chat --entrypoint /bin/sh \
    mcr.microsoft.com/playwright:v1.61.1-noble \
    -c 'export HOME=/root CI=true; corepack enable; npx vitest run --project=client'
  ```

  Worth knowing because a component assertion can go stale for weeks without
  anything going red: the link this section's own dialog work replaced was
  asserted in `renderWithApp.svelte.test.ts` and stayed green through the
  change.

- **`mongodb-memory-server` needs `libcurl4`**, which `node:*-slim` does not
  carry. Without it 49 test _files_ fail to start their in-memory Mongo and
  report as failures that have nothing to do with the code.
- **If `mongodb-memory-server` dies with `SIGILL`**, the CPU lacks AVX (MongoDB
  5.0+ needs it). Point the tests at a real MongoDB instead (4.4 works), and
  run the files serially, because the tests share that database and their
  clean-up helpers would otherwise wipe each other's collections. Only
  `TEST_MONGODB_URL` is honoured (not `MONGODB_URL`):

  ```bash
  TEST_MONGODB_URL=mongodb://127.0.0.1:27017/ npx vitest run --project=server --project=ssr --no-file-parallelism
  ```

### End-to-end tests (Playwright)

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
  the fix aside (`git stash push <the fixed file>`), run the test, and see it
  fail; then `git stash pop`. A test that passes either way proves nothing, and
  this has caught tests that stubbed the wrong layer.
- **A failure is "pre-existing" only once it fails on main too.** Before
  dismissing a failure, rebuild main without your change and run the same test
  there. Same assertion failing on both: pre-existing, say so. Only on your
  branch: yours, even when it looks unrelated. Two composer-mobile "ring" e2e
  tests are known pre-existing failures; anything new needs this check.
- **End-to-end tests run against a fresh build.** `npm run build` first,
  then `E2E_SKIP_BUILD=1`. A stale `build/` passes or fails for reasons that have
  nothing to do with the change.
- **CI runs on every push to main** (`ci.yml`: `check`, `client`, `go`). Push,
  then wait for it to be green before tagging. Its client job runs in CI's
  Chromium on slower hardware: timing-sensitive tests fail there first, so fix
  them at the cause (wait for the state, tap where the element really is)
  rather than raising timeouts.

### On a small box

- **Heavy runs take the lock:** `flock /tmp/heavy.lock` around builds,
  Playwright and the full test suites, so two of them never run at once. Never
  wrap a script that takes the lock itself (`dev/build.sh`) in another flock.
- **`mongodb-memory-server` dies with `SIGILL` on a CPU without AVX.** Point
  tests at a real MongoDB (`TEST_MONGODB_URL`, `--no-file-parallelism`), and for
  e2e `E2E_MONGO_PORT`/`E2E_MONGO_URL`. Running the whole `client` project in
  one command can hit the same crash; run the affected files instead, and let
  CI run the whole project.
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
  under `~/workspace/ai-stack/reports/screenshots/<date>-<topic>/` and point to
  the files.

### Releasing

A change is released only when all of these pass, in this order:

1. CI green on the commit to be tagged.
2. Tag (annotated `vX.Y.Z`, version bumped in `package.json`) and the `images`
   workflow green, which publishes `ghcr.io/paoloviviani/cerea:X.Y.Z`.
3. The image pulls **with no registry login** (`DOCKER_CONFIG` pointing at an
   empty config).
4. In cerea-deploy: `tools/pin`, `tools/pin --check`, its unit tests, then the
   **fresh-kit test**: a clean copy of the kit, `./configure`, `docker compose
pull`, `up -d --wait`, a check that the running containers carry the new
   tags, and a real sign-in through the identity provider, the gateway and the
   chat to `/chat/code`, which must print exactly `E2E_OK`. The test stack is
   then removed and checked gone.
5. Only then the cerea-deploy tag and changelog entry.

A step that cannot run (no browser, no credentials) is reported as not run,
never as passed.

## Merging from upstream

Cerea is a fork of huggingface/chat-ui, now mostly a hard fork. Upstream
changes are merged by hand where they fit:

```bash
git remote add upstream https://github.com/huggingface/chat-ui.git   # once
git fetch upstream && git merge upstream/main
```

- Merge, never rebase: the fork keeps upstream's history intact.
- Keep upstream's file layout where a file still exists in both, so the next
  merge stays mechanical. New first-party code goes in new files where it can.
- HuggingChat-only behaviour stays behind `publicConfig.isHuggingChat`; do not
  delete it just because this deployment never takes that path, since that
  turns every later upstream merge into a conflict.
- Run `npm run check`, `npm run lint` and the tests after a merge, and read the
  upstream changes to `src/lib/server/models.ts`, auth and the generation path
  with care: those are where the fork differs most.

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
│   │   ├── router/       # Smart model routing (Omni)
│   │   ├── database.ts   # MongoDB collections
│   │   ├── models.ts     # Model registry from OPENAI_BASE_URL/models
│   │   └── auth.ts       # OpenID Connect authentication
│   ├── types/            # TypeScript interfaces (Conversation, Message, User, Model, etc.)
│   │   codeDevices.ts    # pairing records, and the per-person scope on them
│   │   codeEnabled.ts    # the CODE_AGENTS_ENABLED gate
│   ├── stores/           # Svelte stores for reactive state
│   └── utils/            # Helpers (tree/, marked.ts, auth.ts, etc.)
├── routes/               # SvelteKit file-based routing
│   ├── code/             # the /code Agents panel (a thin wrapper; the frame is components/code/)
│   ├── conversation/[id]/  # Chat page + streaming endpoint
│   ├── settings/         # User settings pages
│   ├── api/              # Legacy v1 API endpoints (mcp, transcribe, fetch-url)
│   ├── api/v2/           # REST API endpoints (+server.ts)
│   └── r/[id]/           # Shared conversation view
```

### Text Generation Flow

1. User sends message via `POST /conversation/[id]`
2. Server validates user, fetches conversation history
3. Builds message tree structure (see `src/lib/utils/tree/`)
4. Calls LLM endpoint via OpenAI client
5. Streams response back, stores in MongoDB

### Model Context Protocol (MCP)

MCP servers are configured via `MCP_SERVERS` env var. When enabled, tools are exposed as OpenAI function calls. The router can auto-select tools-capable models when `LLM_ROUTER_ENABLE_TOOLS=true`.

### LLM Router (Omni)

Smart routing via Arch-Router model. Configured with:

- `LLM_ROUTER_ROUTES_PATH`: JSON file defining routes
- `LLM_ROUTER_ARCH_BASE_URL`: Router endpoint
- Shortcuts: multimodal routes bypass router if `LLM_ROUTER_ENABLE_MULTIMODAL=true`

### Database Collections

- `conversations` - Chat sessions with nested messages
- `projects` - Groups of conversations sharing standing context
- `users` - User accounts (OIDC-backed)
- `sessions` - Session data
- `sharedConversations` - Public share links
- `settings` - User preferences (including the global system prompt)
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
shapes are read now, gateway first, because this fork also runs against the HF
router where the nested one is all there is.

Two consequences worth knowing:

- **a model's row can legitimately declare nothing.** `benchmark-live` was
  created by `scripts/benchmark_live.py` through `/api/admin/models` with the
  three fields omitted, so it advertised nothing while its upstream declares
  `tools` and `json_mode`. The script sets them now. An operator sets them for
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
that hosts models, **Customize models**, MCP servers, knowledge bases, skills and
memory as tabs. The address is the way in from anywhere: `/workspace?tab=models`
for the list, `/workspace?tab=models&id=<id>` straight onto one model's
settings, `/workspace?tab=custom[&id=custom:<id>]` for Customize models. The
affordances that open it — a routed message's model, the models list's gear —
navigate to that address (the composer's model name opens the per-chat
`ModelPicker`, which is a different thing). The `modelsOverlay` store this once
needed is deleted; an address needs no store.

Two things worth knowing:

- **"Default" is what a _new_ chat starts on.** An open conversation keeps the
  model it was started with, so the button says "Set as default" and the pill
  says "Default", not "Active";
- **`providerOverrides` is not in the dialog, and is not a loss.** It picks
  which _HuggingFace Inference Provider_ serves a model — inherited from
  upstream, and meaningless in a gateway deployment, where every call goes to
  the gateway and which upstream serves a model is the gateway's decision. Its UI was already hidden behind `isHuggingChat`. The
  server-side plumbing is deliberately left in place, because it is live on the
  branch this fork came from.

### Customize models: the global prompt and custom models

Two things a person writes, both on the **Customize models** tab
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
called by `resolvePreprompt`, fed by `textGeneration/userPrompts.ts`): **global,
then the custom model's, then the conversation's stored prompt**; empty parts are
skipped; `preprompt.spec.ts` asserts the order. What `resolvePreprompt` and the
turn append after it (the artifacts and execution contracts, skills, memory, then
the project's context, whose own order `projectContext` keeps) reads below.
The ML Assistant preset supplies its whole prompt, so neither reaches it.

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
**Workspace** (the tabbed page hosting models, MCP servers and knowledge
bases), **Settings**, and **Admin** for administrators (gated on
`gatewayIsAdmin`, the gateway's answer, not the chat's own flag) — and the
**footer** is static: the user's tag and name, a theme switch, and a sign-out
button, all inline, with no popup. (Models, Knowledge and MCP Servers were
three more rows that each opened their own dialog; the workspace page absorbed
them, and `UserMenu` — whose popup carried Settings, Admin, the theme switch
and sign out — went with them.)

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
- **nothing opens a list of all projects from the sidebar.** The list survives
  only as the `/projects` route (`ProjectsManager`, now just that list, each card
  a link to the project's page);
- **a project's chats live under the project, so Chats leaves them out.** That
  is what `projectId` on `ConvSidebar` is for; without it every project
  conversation appeared in both places.

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

`components/projects/ProjectPage.svelte` is one scroll of sections, which are the
**five context levels** in the order `projectContext` (`server/projects.ts`)
builds the prompt — the one function that assembles project context, and the
order is part of its contract (`projectContext.spec.ts` asserts it):

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

## The /code Agents panel

`agent/PROTOCOL.md` is the wire protocol, binding for both this app and the Go
agent, `galopin`, which lives in this repository as `agent/`. Coding agents run on
**the person's own machine**, supervised by one binary that dials **out** to
this deployment over WSS with its own OIDC credential — no relay in between,
nothing capability-bearing at rest in Cerea. `docs/code-panel.md`
is the operator guide and `docs/agent-machines.md` the user's (it also
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
- **The agent view is the chat's own machinery.** `ChatMessageColumn`,
  `ChatInput`, the approval card, the shared side pane. That is what makes
  live updates arrive by construction; a bespoke stack here would be a second
  thing to keep working.

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

## Feature Development Checklist

When building new features, consider:

1. **HuggingChat vs self-hosted**: Wrap HuggingChat-specific features with `publicConfig.isHuggingChat`
2. **Settings persistence**: Add new fields to `src/lib/types/Settings.ts`, update API endpoint at `src/routes/api/v2/user/settings/+server.ts`
3. **Rich dropdowns**: Use `bits-ui` (Select, DropdownMenu) instead of native elements when you need icons/images in options
4. **Scrollbars**: Use `scrollbar-custom` class for styled scrollbars
5. **Icons**: Custom icons in `$lib/components/icons/`, use Carbon (`~icons/carbon/*`) or Lucide (`~icons/lucide/*`) for standard icons
6. **Provider avatars**: Use `PROVIDERS_HUB_ORGS` from `@huggingface/inference` for HF provider avatar URLs
