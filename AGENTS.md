# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Chat UI is a SvelteKit application that provides a chat interface for LLMs. It powers HuggingChat (hf.co/chat). The app speaks exclusively to OpenAI-compatible APIs via `OPENAI_BASE_URL`.

## Commands

```bash
npm run dev          # Start dev server on localhost:5173
npm run build        # Production build
npm run preview      # Preview production build
npm run check        # TypeScript validation (svelte-kit sync + svelte-check)
npm run lint         # Check formatting (Prettier) and linting (ESLint)
npm run format       # Auto-format with Prettier
npm run test         # Run all tests (Vitest)
```

### Against a running stack

```bash
set -a; . deploy/.env; set +a          # the gateway's deployment variables
./scripts/test_projects_live.py        # projects: context, retrieval, memory
./scripts/test_attachments_live.py     # a document attachment, extracted once
```

Note the trap in the attachment check, because it will be reintroduced: the
**first** turn of a conversation also generates its title, which is a second
completion and overwrites the smoke upstream's `GET /_last_request`. Any
assertion about the prompt has to run on a later turn, or it is a coin flip.

Signs in through the identity provider and drives real turns. Worth running for
anything touching the generation path, project context or the gateway
forwarder: it asserts on **the prompt that actually left the gateway**, read
from the smoke upstream's recorded request, which no unit test can see.

Note for containerised runs: `mongodb-memory-server` needs `libcurl4`, which
`node:*-slim` does not carry. Without it 49 test _files_ fail to start their
in-memory Mongo and report as failures that have nothing to do with the code.

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
│   ├── components/       # Svelte components (chat/, mcp/, voice/, icons/)
│   ├── server/
│   │   ├── api/utils/       # Shared API helpers (auth, superjson, model/conversation resolvers)
│   │   ├── textGeneration/  # LLM streaming pipeline
│   │   ├── mcp/          # Model Context Protocol integration
│   │   ├── router/       # Smart model routing (Omni)
│   │   ├── database.ts   # MongoDB collections
│   │   ├── models.ts     # Model registry from OPENAI_BASE_URL/models
│   │   └── auth.ts       # OpenID Connect authentication
│   ├── types/            # TypeScript interfaces (Conversation, Message, User, Model, etc.)
│   ├── stores/           # Svelte stores for reactive state
│   └── utils/            # Helpers (tree/, marked.ts, auth.ts, etc.)
├── routes/               # SvelteKit file-based routing
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
- `projects` - Groups of conversations sharing standing context (ADR 0062)
- `users` - User accounts (OIDC-backed)
- `sessions` - Session data
- `sharedConversations` - Public share links
- `settings` - User preferences

## The dialog language, and where it comes from

**Models, projects, knowledge and agents are overlays, not pages**, and they
are overlays in the shape the MCP dialog already had — that is this app's own
design language and the reference implementation is still
`src/lib/components/mcp/`. Read `MCPServerManager.svelte` and
`ServerCard.svelte` before adding a screen.

What it consists of, all of it in `src/lib/components/overlay/styles.ts` as
constants lifted verbatim from those two files:

- an overlay with **per-view widths** (`w-[800px]` for a list, `w-[600px]` for
  a form) and sub-views switching _inside_ it on a `view` variable, rather than
  navigating — somebody managing knowledge is doing one task and should not
  lose their place in the conversation that prompted it;
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

**The routes are kept and render the same component.** `/knowledge`,
`/agents`, `/projects` and their `/<id>` forms are thin wrappers that mount the
manager with `initialId`, because people link to those addresses. One
implementation and one design: a dialog for whoever arrives from the nav and a
separate page for whoever arrives from a link is how the two drift apart. The
one trap that caused — **a page body runs on the server**, so a manager that
fetched in its component body answered 502 with `Failed to parse URL from
/chat/api/v2/...`. Every manager loads in `onMount`.

## Projects, knowledge bases and agents

Knowledge bases and agents are the **gateway's** (ADR 0062): it owns files,
extraction, embedding, the vector store and one ACL, and this application
reaches them through `/api/v2/gateway`, an allowlisted forwarder that attaches
the session's OIDC token and never lets it reach the page. Projects are
**ours**, because a project groups _conversations_, and those live in Mongo.

`src/lib/server/projects.ts` is the whole of it. Read the header of
`src/lib/types/Project.ts` first; the parts that will bite:

- **Sharing is decided against the viewer's own identity** — their email and
  the groups `GET /v1/billing/groups` reports for _their_ token. Nothing asks
  the gateway who is in a group, because a bearer token cannot ask and a route
  that could would let a chat client enumerate the directory. The cost is that
  a share names a principal that may not exist: a typo and a colleague who has
  not signed in yet are indistinguishable.
- **A shared project is a shared workspace.** Everyone who can see it sees
  every conversation in it. The project page says so.
- **Sharing a project shares no documents.** Retrieval runs with the reader's
  own token, so they see passages only from bases they could already read.
- **Retrieval never fails a turn.** Every error is logged
  (`project_retrieval_degraded`, `project_memory_index_failed`) and swallowed:
  a base being unavailable is a reason for a worse answer, not for none.
- **Indexing past chats is idempotent by handle.** The transcript goes to the
  gateway under `source_ref = chat:conversation:<id>`, which _replaces_ rather
  than appends — otherwise a ten-turn thread leaves ten overlapping copies and
  every search returns all of them.
- The memory base is an **ordinary knowledge base**, visible on the Knowledge
  screen and deletable there, named after its project. That is deliberate: the
  transcripts are somewhere a person can look.

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

Which model extracts is `CHAT_OCR_MODEL`, or the first `kind: ocr` model the
caller may use. With only the built-in extractor installed that is the built-in
extractor, and **it never sends the document anywhere** — naming an upstream
OCR model does, which is why it is a setting rather than a default.

Two things found only by running `scripts/test_projects_live.py`, both worth
knowing before touching the model picker or writing another live check:

- **The model catalogue is global.** `src/lib/server/models.ts` builds it once
  at startup with the deployment's own key, so every account sees the same
  list — including agents whose underlying model that account may not use.
  Calling one answers 404 from the gateway, which _is_ the designed behaviour
  for an agent shared across a model restriction; what it means is that this
  list cannot hide it the way the gateway's per-caller `/v1/models` does.
  Per-user filtering would mean the catalogue stops being module state.
- **A turn is a multipart post**, with the JSON in a `data` field, needing an
  `Origin` header past the CSRF guard, and a first user message still needs
  its parent id — the create puts a system message at the conversation's root
  and `addChildren` refuses to guess. A JSON body there is a 500 from undici
  before any of this app's code runs.

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
