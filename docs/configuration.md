# Configuration

!!! info "For operators"

    Every environment variable the chat understands, by feature. The repository's `.env` is the defaults file; a test fails if it lists a variable the code does not read, or the code reads one it does not list.

Cerea reads its settings from the environment; the repository's `.env` lists
every variable the app understands, with its comments and its default. A value
exported into the environment, or set in `.env.local`, wins over `.env`.

In a deployment you rarely set these by hand: the deploy kit's `.env.example` is
the deployment's own commented list, and `./configure --set KEY=VALUE` changes a
single one (see [Deploying](deploy.md)). Switches take the string `true` or
`false`; the defaults below say which way an unset one goes.

## The variables that choose your deployment shape

Three variables decide what kind of deployment you are
running, before any of the fork's variables below matter:

| Variable              | What it decides                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_BASE_URL`     | Where inference goes: a Pystino gateway's `/v1`, or any OpenAI-compatible endpoint. **No default**: empty, the chat refuses to start. The kit sets it to the bundled gateway (`http://gateway:8000/v1`, or `CHAT_OPENAI_BASE_URL`).                                                                                                                                            |
| `USE_USER_TOKEN`      | Names the mode (below). `true` is **Pystino mode**: people sign in through the gateway and every inference call carries their own token, so quotas and the ledger are theirs. Unset or `false` is **standalone mode**: one shared `OPENAI_API_KEY` and no per-person billing. A hand-built chat pointed at Pystino without `true` silently bills everything to the shared key. |
| `OPENID_PROVIDER_URL` | The identity provider people sign in with. **No default**: empty, sign-in has no issuer to talk to (set it with `OPENID_CLIENT_ID`); the kit sets it from `OIDC_ISSUER`. The machine agent's issuer (`CODE_MACHINE_ISSUER`) defaults to it.                                                                                                                                    |

### Two modes, never a mix

The chat reaches models in exactly one of two ways, decided by `USE_USER_TOKEN`
(no other setting names the mode):

|                  | **Pystino mode** (`USE_USER_TOKEN=true`)                                        | **Standalone mode** (unset or not `true`) |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| Credential       | each person's own sign-in token, only                                           | one shared `OPENAI_API_KEY`, only         |
| Endpoints        | the gateway at `OPENAI_BASE_URL`, for every model, including `MODELS` overrides | one OpenAI-compatible endpoint            |
| `OPENAI_API_KEY` | must be empty                                                                   | the shared key                            |
| Boot catalogue   | fetched with no key, then filtered per person and billing group                 | fetched with the shared key               |

A mix either bypasses the gateway's per-person access, billing and redaction,
or hides models people are entitled to, so **the chat refuses to start** on
one, and the error names the setting to change:

- `OPENAI_API_KEY` set while `USE_USER_TOKEN=true`:
  empty it, or set `USE_USER_TOKEN=false` for a standalone endpoint.
- In Pystino mode, a `MODELS` entry whose `endpoints` name a `baseURL` other
  than `OPENAI_BASE_URL` (an endpoint with no `baseURL` counts: it defaults to
  `api.openai.com`), or carry their own `apiKey`: remove `endpoints` from that
  entry. Overrides that only set flags such as `supportsArtifacts` are fine.
- `USE_USER_TOKEN=true` with no `OPENAI_BASE_URL`: there is no gateway to
  present tokens to.

An install from before this rule that mixed the two fails to start after
upgrading until one of those is changed. With the deploy kit, run
`./configure`: it reports the mix and offers the fix. It can only write one
mode: the `generic` preset writes a shared key with personal tokens off, every
other preset writes no key.

The [Deploying](deploy.md) page shows the two complete variable sets, for a
chat against Pystino and for a chat against any other endpoint.

## Sign-in

| Variable                    | What                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENID_INTERNAL_URL`       | The server-to-server base for the issuer, when `OPENID_PROVIDER_URL` would hairpin through the public proxy (the bundled Authelia: `http://authelia:9091/authelia`). Browsers still use `OPENID_PROVIDER_URL`                                                                                                                                     |
| `OPENID_SCOPES`             | The scopes the chat asks the identity provider for, separated by spaces. The default is upstream's (HuggingChat's); the deploy kit writes `openid profile email groups`, less any scope the issuer's discovery document does not list, for an IdP that answers `invalid_scope` to `groups`. Keep it equal to the gateway's `GATEWAY_OIDC__SCOPES` |
| `OPENID_LOGOUT_URL`         | The provider's logout page, for one that publishes no `end_session_endpoint` (the bundled Authelia: `<issuer>/logout?rd={redirect}`). `{redirect}` is where to land. Used before discovery when set                                                                                                                                               |
| `ADMIN_CLI_LOGIN`           | Default `false`. `true` prints a one-time admin login URL (with a token) in the server log at boot and lets a signed-in person who presents it become chat admin. It is always off when OpenID is configured, whatever this says; the kit sets it `false`. Admin rights come from the identity provider                                           |
| `LOGOUT_ALSO_CLEAR_COOKIES` | Other applications' session cookies on this origin to expire when someone signs out, `name` or `name:path`, comma-separated. On the Pystino stack: `gw_session,gw_idt:/auth`, so signing out of one never leaves the other in                                                                                                                     |
| `CHAT_MIGRATE_ISSUER_FROM`  | When moving to a new identity provider: the old issuer. A first login that finds no account takes over the old account with the same verified email                                                                                                                                                                                               |
| `PUBLIC_TURIN_PHRASES`      | Rotating Turin-dialect greetings printed beside the logo on a new chat, one per page load, comma-separated. `false` or empty restores the plain name                                                                                                                                                                                              |

## Secrets shared with the gateway

| Variable             | What                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAT_SECRET_KEY`    | Encrypts connector credentials at rest (AES-256-GCM). There is **no default**: without it connectors stop working, and nothing stores a plaintext token. Rotate it and stored connector credentials no longer decrypt                                               |
| `CHAT_ERASURE_TOKEN` | The gateway's own credential for the chat's `/internal/erasure` (deleting a person everywhere). Minted by `./configure`, sent over the compose network only, compared in constant time. The chat also refuses any `/internal/*` request that carries a proxy header |

## Notifications

| Variable                 | What                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAT_VAPID_PUBLIC_KEY`  | The public half of the deployment's Web Push key pair (base64url, 65 bytes). Minted once by `./configure`. Browsers subscribe against it, so replacing it strands every subscription. Unset means push is off ([Notifications](notifications.md)) |
| `CHAT_VAPID_PRIVATE_KEY` | The private half (base64url, 32 bytes). Signs each push. Keep it with the other secrets in `.env`; a pair whose halves disagree is treated as unset, and `./configure --check` says so                                                            |
| `CHAT_VAPID_SUBJECT`     | How a push service can reach the operator: a `mailto:` or `https:` address. `./configure` writes `mailto:` your admin email                                                                                                                       |

## Documents and knowledge

| Variable                 | What                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAT_PG_URL`            | PostgreSQL with pgvector, where knowledge-base passages and vectors live. Without it the knowledge store is unavailable                                                                                                                                                                                                                                                             |
| `CHAT_KNOWLEDGE_ENABLED` | Unset means on. `false`, for a deployment without the chat's Postgres, hides the Knowledge tab and the project and composer knowledge affordances                                                                                                                                                                                                                                   |
| `CHAT_OCR_MODEL`         | The model `POST /v1/ocr` uses to read an attached **PDF**. Office files always go to the deployment's local reader instead, whatever is named here ([Knowledge](knowledge.md#for-operators)). Unset: the Knowledge screen's choice, else the first `kind: ocr` model the caller may use. Naming an upstream model here **does** send documents to it, so it is a deliberate setting |
| `CHAT_OCR_BASE_URL`      | For a deployment with **no gateway**: read documents by calling `{base}/ocr` directly (Pystino, Mistral and Cortecs serve one shape). It overrides the gateway path, reads PDFs only, caps a document at 10 MB, and requires `CHAT_OCR_MODEL`                                                                                                                                       |
| `CHAT_PDF_IMAGE_PAGES`   | How many pages of a scanned PDF the deployment's own reader may hand back as images, for a model that sees images ([Attachments](chat.md#attachments)). Default 20, at most 50; `0` turns it off, and the reader then refuses a scan as before. Asked for only when the local reader is the one reading PDFs                                                                        |
| `CHAT_OCR_TIMEOUT_MS`    | How long one attached document may take to read, in milliseconds. Default 180000 (3 minutes); a 50-page PDF takes the local reader 20-30 s. When it fires the server logs `document_extraction_timeout` with the elapsed time and the file is stored without text. Pystino has a matching `GATEWAY_EXTRACTOR__TIMEOUT_SECONDS` (default 180): raise both together                   |
| `CHAT_OCR_API_KEY`       | Bearer key for `CHAT_OCR_BASE_URL`: one shared deployment key, not the signed-in person's credential                                                                                                                                                                                                                                                                                |

## Features

| Variable                         | What                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAT_MEMORY_ENABLED`            | Unset means on. `false` withdraws [memory](chat.md#memory) from the deployment: the tab hides, its routes answer 404, `remember` and `forget` are never offered, and a project's [shared memory](knowledge.md#project-memory) go the same way. Each person's own opt-in is separate and defaults off |
| `CHAT_ASK_USER_QUESTION_ENABLED` | Unset means on. `false` removes the `ask_user_question` tool (a question with clickable options the turn waits on) from ordinary conversations                                                                                                                                                       |
| `CHAT_SKILLS_DISABLED`           | Comma-separated skill names to switch off deployment-wide, whatever their source                                                                                                                                                                                                                     |
| `CHAT_CODE_TOOL_ENABLED`         | `true` offers the `execute_code` tool to tool-capable models: the model's code runs in the signed-in person's own [browser sandbox](pyodide.md). Unset: the assistant's Python runs only as blocks in a finished answer; `true` also lets it run code mid-answer and use the result                  |
| `CHAT_CODE_RUN_TIMEOUT_SECONDS`  | Seconds one run of the [browser sandbox](pyodide.md#limits) may take before it is stopped and the sandbox restarts. Default 60; values are held between 5 and 300, so a runaway loop always ends. Also the `kit/.env.example` key                                                                    |
| `CHAT_STREAM_IDLE_TIMEOUT_MS`    | How long a model's answer may go without sending anything before the turn is stopped with "The model stopped responding". Default 300000 (5 minutes), at least 30000; the wait before the first chunk counts, so slow reasoning models need the room                                                 |
| `CHAT_TURN_MAX_MINUTES`          | The longest one turn may run, whatever it is doing. Default 30, at least 1. Past it the turn ends as an error ("This answer took longer than N minutes and was stopped."), keeping what was streamed. A turn parked on an approval or a question ends there, and its resume gets a fresh allowance   |
| `CHAT_PYODIDE_PYPI_DISABLED`     | `true` forces off the sandbox's "install packages from PyPI" setting for everyone. The vendored wheels stay installable                                                                                                                                                                              |
| `CHAT_DICTATION`                 | Whether the composer offers [dictation](chat.md#dictation) with the browser's speech recognition: `yes`, `no`, or `fallback` (the default: only when server-side transcription is not configured). Settable from [Administration → Voice](chat-admin.md#voice), which overrides this                 |
| `CHAT_DELEGATION`                | `false` removes the `delegate` and `research` [sub-agent tools](chat.md#plans-and-sub-agents) from every chat; anything else, or unset, leaves them on. Settable from [Administration → Sub-agents](chat-admin.md#sub-agents), which overrides this                                                  |
| `ADMIN_INSTRUCTIONS`             | The [instructions added to every chat](chat-admin.md#assistant-instructions), up to 4,000 characters. Set under Administration; with `ENABLE_CONFIG_MANAGER` off, set here.                                                                                                                          |
| `ADMIN_INSTRUCTIONS_VISIBLE`     | `false` hides them from users in Settings; they still apply. Anything else shows them.                                                                                                                                                                                                               |
| `CHAT_FILE_RETENTION_DAYS`       | How many days [files a run produced](artifacts.md#file-artifacts) are kept: a whole number, `0` for no expiry, default 30. Settable from [Administration → Storage](chat-admin.md#storage), which overrides this                                                                                     |
| `DELIVERABLE_SWEEP_INTERVAL_MS`  | How often to sweep [files a run produced](artifacts.md#file-artifacts) for that retention, and free orphaned bytes. Default 3600000 (one hour)                                                                                                                                                       |
| `CHAT_WEBFETCH_CACHE_DAYS`       | How many days the text `web_fetch` read from a page or document is kept for its conversation, so a later turn does not download and extract (and pay for) it again: a whole number, `0` turns the cache off, default 7. Deleted with the conversation and on account erasure                         |
| `CHAT_WEBFETCH_FRESH_MINUTES`    | Within this many minutes of the last download a cached document is reused without downloading it again; after that it is downloaded and re-extracted only if its content changed. Default 10                                                                                                         |
| `CHAT_USAGE_ENABLED`             | `true` shows the "Usage & billing" settings tab: the person's quotas and spend read from the gateway. Needs `OPENAI_BASE_URL`; without a gateway the tab stays hidden                                                                                                                                |
| `CHAT_CONSOLE_ENABLED`           | `true` when this origin serves the Pystino console at `/console`, so the admin panel links to it. Leave empty for a satellite or generic deployment                                                                                                                                                  |

## Web fetch

| Variable                             | What                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FETCH_BACKEND`                      | Who reads a page the assistant fetches: `direct` (a plain HTTPS request; the default) or `playwright` (the [headless browser](browser.md)). A third name, `pystino`, is recognised but not implemented and fails with a message                                                                                                                                                                                                    |
| `CHAT_FETCH_ALLOW_INTERNAL_NETWORKS` | Set to `true` only if this deployment must fetch content from hosts on an internal network. By default the assistant's web fetch and "Attach from URL" refuse 10.0.0.0/8 and 100.64.0.0/10 (the range mesh VPNs such as Tailscale and NetBird use), so a model or a page cannot point them at internal services. Loopback, link-local and the other private ranges are refused regardless. MCP connectors may reach both networks. |
| `WEB_SEARCH_MODEL`                   | The search backend (a gateway `kind: search` model) the **Web search** pill uses. Overrides Administration → Web search and is shown there as "set in the environment". Unset: the admin screen's choice, else the caller's billing-group search policy. A caller not granted the named backend falls back to that policy                                                                                                          |
| `PLAYWRIGHT_WS_ENDPOINT`             | Where the renderer listens, inside the compose network only. Never publish it                                                                                                                                                                                                                                                                                                                                                      |
| `CHAT_GOTENBERG_URL`                 | Where the chat reaches Gotenberg, the document converter of the kit's `office` profile ([Office previews](office.md)). Empty turns Office previews through LibreOffice and the `convert_document` tool off                                                                                                                                                                                                                         |
| `CHAT_DOCUMENTS_URL`                 | Where the chat reaches the document service (`cerea-documents`, the kit's `documents` service), which gives models `doc_create`, `doc_create_from_template`, `doc_outline`, `doc_read` and `doc_edit` for Word, Excel, PowerPoint and PDF files ([Word, Excel, PowerPoint and PDF files](office.md)). The kit sets it to `http://documents:8090`; empty, or no secret, turns the tools off                                         |
| `CHAT_DOCUMENTS_SECRET`              | The secret the chat sends in `X-Cerea-Documents-Secret`; the service refuses any call without it. The kit's `./configure` mints it and passes the same value to both; an install from before 0.30.0 runs `./configure` once to get it                                                                                                                                                                                              |

## Coding agents

| Variable                      | What                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODE_AGENTS_ENABLED`         | Exactly `true` shows the Agents panel. Anything else hides it, and `/code` answers 404                                                                                                                                                                                                                                                                                     |
| `LOCAL_CONNECTORS_ENABLED`    | Exactly `true` lets people connect MCP servers that run on their own machine ([Local connectors](local-connectors.md)): the machine link accepts a connectors machine, the Workspace shows the Local connectors tab, and the machine's servers appear in the MCP panel. Independent of `CODE_AGENTS_ENABLED`. Anything else turns it off. The deploy kit sets it to `true` |
| `CODE_FILES_ENABLED`          | Unset means on with the panel. `false` turns the read-only file explorer off for the whole deployment (each machine can also refuse it)                                                                                                                                                                                                                                    |
| `CODE_TERMINAL_ENABLED`       | Exactly `true` allows browser terminals; off by default. Still only live for a machine whose policy allows terminals (the enroll default; `--no-terminal` turns them off)                                                                                                                                                                                                  |
| `CHAT_SCHEDULES_ENABLED`      | Unset means on (with `CODE_AGENTS_ENABLED`). Exactly `false` is the kill switch for scheduled actions: nothing fires, the API answers 404, the sidebar entry goes. Rows are kept                                                                                                                                                                                           |
| `CHAT_SCHEDULES_MAX_PER_USER` | How many schedules one person may have. Default `20`                                                                                                                                                                                                                                                                                                                       |
| `CODE_MACHINE_ISSUER`         | The issuer a machine's token must come from. Defaults to `OPENID_PROVIDER_URL`                                                                                                                                                                                                                                                                                             |
| `CODE_MACHINE_AUDIENCE`       | The audience a machine's token must carry (`pystino-api`)                                                                                                                                                                                                                                                                                                                  |
| `CODE_MACHINE_CLIENT_ID`      | The client a machine's token must be issued to (`opencode-enrollment`)                                                                                                                                                                                                                                                                                                     |
| `CODE_GATEWAY_ORIGIN`         | The gateway origin the pairing dialog passes to `galopin enroll --gateway`. Unset: the browser's own origin                                                                                                                                                                                                                                                                |
| `GALOPIN_DIST_DIR`            | Where the image keeps the galopin binaries it serves at `<base>/galopin/`. Default `/app/galopin-dist`                                                                                                                                                                                                                                                                     |

The operator's view of these, and what each does to the panel, is in [The
`/code` panel](code-panel.md).

## Transcription

`TRANSCRIPTION_MODEL` alone no longer enables the microphone button. It needs
`TRANSCRIPTION_BASE_URL` too: the audio goes to
`${TRANSCRIPTION_BASE_URL}/${TRANSCRIPTION_MODEL}` with the person's token, and
there is no default endpoint any more (it used to be Hugging Face's inference
router, which would have received a gateway token). With either one empty the
button is hidden and `/api/transcribe` answers 503.
