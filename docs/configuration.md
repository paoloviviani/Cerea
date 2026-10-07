# Configuration

!!! info "For operators"

    The environment variables Cerea adds to upstream chat-ui, by feature; everything else is upstream's and documented there.

Cerea reads its settings from the environment. **This page lists only the
variables this fork added.** The rest (`OPENAI_BASE_URL`, `MONGODB_URL`,
`OPENID_CLIENT_ID`, `MCP_SERVERS`, the router and theming variables and so on)
are upstream chat-ui's, and are documented in [its configuration
docs](https://github.com/huggingface/chat-ui/tree/main/docs/source/configuration/overview.md).
The repository's `.env` lists every variable the app understands, with its
comments.

In a deployment you rarely set these by hand: the deploy kit's `.env.example` is
the deployment's own commented list, and `./configure --set KEY=VALUE` changes a
single one (see [Deploying](deploy.md)). Switches take the string `true` or
`false`; the defaults below say which way an unset one goes.

## The variables that choose your deployment shape

Three upstream-named variables decide what kind of deployment you are
running, before any of the fork's variables below matter:

| Variable              | What it decides                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_BASE_URL`     | Where inference goes: a Pystino gateway's `/v1`, or any OpenAI-compatible endpoint.                                                                                                                                                                                                                                                                                            |
| `USE_USER_TOKEN`      | With `OPENAI_BASE_URL` set, `true` makes this a **gateway deployment**: people sign in through the gateway and every inference call carries their own token, so quotas and the ledger are theirs. Unset or `false` means one shared `OPENAI_API_KEY` and no per-person billing. A hand-built chat pointed at Pystino without this silently bills everything to the shared key. |
| `OPENID_PROVIDER_URL` | The identity provider people sign in with. The machine agent's issuer (`CODE_MACHINE_ISSUER`) defaults to it.                                                                                                                                                                                                                                                                  |

The [Deploying](deploy.md) page shows the two complete variable sets, for a
chat against Pystino and for a chat against any other endpoint.

## Sign-in

| Variable                    | What                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENID_INTERNAL_URL`       | The server-to-server base for the issuer, when `OPENID_PROVIDER_URL` would hairpin through the public proxy (the bundled Authelia: `http://authelia:9091/authelia`). Browsers still use `OPENID_PROVIDER_URL`                                                                                                                                     |
| `OPENID_SCOPES`             | The scopes the chat asks the identity provider for, separated by spaces. The default is upstream's (HuggingChat's); the deploy kit writes `openid profile email groups`, less any scope the issuer's discovery document does not list, for an IdP that answers `invalid_scope` to `groups`. Keep it equal to the gateway's `GATEWAY_OIDC__SCOPES` |
| `OPENID_LOGOUT_URL`         | The provider's logout page, for one that publishes no `end_session_endpoint` (the bundled Authelia: `<issuer>/logout?rd={redirect}`). `{redirect}` is where to land. Used before discovery when set                                                                                                                                               |
| `LOGOUT_ALSO_CLEAR_COOKIES` | Other applications' session cookies on this origin to expire when someone signs out, `name` or `name:path`, comma-separated. On the Pystino stack: `gw_session,gw_idt:/auth`, so signing out of one never leaves the other in                                                                                                                     |
| `CHAT_MIGRATE_ISSUER_FROM`  | When moving to a new identity provider: the old issuer. A first login that finds no account takes over the old account with the same verified email                                                                                                                                                                                               |
| `PUBLIC_TURIN_PHRASES`      | Rotating Turin-dialect greetings printed beside the logo on a new chat, one per page load, comma-separated. `false` or empty restores the plain name                                                                                                                                                                                              |

## Secrets shared with the gateway

| Variable             | What                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAT_SECRET_KEY`    | Encrypts connector credentials at rest (AES-256-GCM). There is **no default**: without it connectors stop working, and nothing stores a plaintext token. Rotate it and stored connector credentials no longer decrypt                                               |
| `CHAT_ERASURE_TOKEN` | The gateway's own credential for the chat's `/internal/erasure` (deleting a person everywhere). Minted by `./configure`, sent over the compose network only, compared in constant time. The chat also refuses any `/internal/*` request that carries a proxy header |

## Documents and knowledge

| Variable                 | What                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAT_PG_URL`            | PostgreSQL with pgvector, where knowledge-base passages and vectors live. Without it the knowledge store is unavailable                                                                                                                                                                                                                                                             |
| `CHAT_KNOWLEDGE_ENABLED` | Unset means on. `false`, for a deployment without the chat's Postgres, hides the Knowledge tab and the project and composer knowledge affordances                                                                                                                                                                                                                                   |
| `CHAT_OCR_MODEL`         | The model `POST /v1/ocr` uses to read an attached **PDF**. Office files always go to the deployment's local reader instead, whatever is named here ([Knowledge](knowledge.md#for-operators)). Unset: the Knowledge screen's choice, else the first `kind: ocr` model the caller may use. Naming an upstream model here **does** send documents to it, so it is a deliberate setting |
| `CHAT_OCR_BASE_URL`      | For a deployment with **no gateway**: read documents by calling `{base}/ocr` directly (Pystino, Mistral and Cortecs serve one shape). It overrides the gateway path, reads PDFs only, caps a document at 10 MB, and requires `CHAT_OCR_MODEL`                                                                                                                                       |
| `CHAT_PDF_IMAGE_PAGES`   | How many pages of a scanned PDF the deployment's own reader may hand back as images, for a model that sees images ([Attachments](chat.md#attachments)). Default 20, at most 50; `0` turns it off, and the reader then refuses a scan as before. Asked for only when the local reader is the one reading PDFs                                                                        |
| `CHAT_OCR_API_KEY`       | Bearer key for `CHAT_OCR_BASE_URL`: one shared deployment key, not the signed-in person's credential                                                                                                                                                                                                                                                                                |

## Features

| Variable                         | What                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAT_MEMORY_ENABLED`            | Unset means on. `false` withdraws [memory](chat.md#memory) from the deployment: the tab hides, its routes answer 404, `remember` and `forget` are never offered, and a project's [shared memory](knowledge.md#project-memory) go the same way. Each person's own opt-in is separate and defaults off |
| `CHAT_ASK_USER_QUESTION_ENABLED` | Unset means on. `false` removes the `ask_user_question` tool (a question with clickable options the turn waits on) from ordinary conversations                                                                                                                                                       |
| `CHAT_SKILLS_DISABLED`           | Comma-separated skill names to switch off deployment-wide, whatever their source                                                                                                                                                                                                                     |
| `CHAT_CODE_TOOL_ENABLED`         | `true` offers the `execute_code` tool to tool-capable models: the model's code runs in the signed-in person's own [browser sandbox](pyodide.md). Unset: the assistant's Python runs only as blocks in a finished answer; `true` also lets it run code mid-answer and use the result                  |
| `CHAT_PYODIDE_PYPI_DISABLED`     | `true` forces off the sandbox's "install packages from PyPI" setting for everyone. The vendored wheels stay installable                                                                                                                                                                              |
| `DELIVERABLE_SWEEP_INTERVAL_MS`  | How often to sweep [files a run produced](artifacts.md#file-artifacts) for the 30-day expiry and free their bytes. Default 3600000 (one hour)                                                                                                                                                        |
| `CHAT_USAGE_ENABLED`             | `true` shows the "Usage & billing" settings tab: the person's quotas and spend read from the gateway. Needs `OPENAI_BASE_URL`; without a gateway the tab stays hidden                                                                                                                                |
| `CHAT_CONSOLE_ENABLED`           | `true` when this origin serves the Pystino console at `/console`, so the admin panel links to it. Leave empty for a satellite or generic deployment                                                                                                                                                  |

## Web fetch

| Variable                 | What                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FETCH_BACKEND`          | Who reads a page the assistant fetches: `direct` (a plain HTTPS request; the default) or `playwright` (the [headless browser](browser.md)). A third name, `pystino`, is recognised but not implemented and fails with a message                                                                                           |
| `WEB_SEARCH_MODEL`       | The search backend (a gateway `kind: search` model) the **Web search** pill uses. Overrides Administration → Web search and is shown there as "set in the environment". Unset: the admin screen's choice, else the caller's billing-group search policy. A caller not granted the named backend falls back to that policy |
| `PLAYWRIGHT_WS_ENDPOINT` | Where the renderer listens, inside the compose network only. Never publish it                                                                                                                                                                                                                                             |

## Coding agents

| Variable                 | What                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODE_AGENTS_ENABLED`    | Exactly `true` shows the Agents panel. Anything else hides it, and `/code` answers 404                                                                                    |
| `CODE_FILES_ENABLED`     | Unset means on with the panel. `false` turns the read-only file explorer off for the whole deployment (each machine can also refuse it)                                   |
| `CODE_TERMINAL_ENABLED`  | Exactly `true` allows browser terminals; off by default. Still only live for a machine whose policy allows terminals (the enroll default; `--no-terminal` turns them off) |
| `CODE_MACHINE_ISSUER`    | The issuer a machine's token must come from. Defaults to `OPENID_PROVIDER_URL`                                                                                            |
| `CODE_MACHINE_AUDIENCE`  | The audience a machine's token must carry (`pystino-api`)                                                                                                                 |
| `CODE_MACHINE_CLIENT_ID` | The client a machine's token must be issued to (`opencode-enrollment`)                                                                                                    |
| `CODE_GATEWAY_ORIGIN`    | The gateway origin the pairing dialog passes to `galopin enroll --gateway`. Unset: the browser's own origin                                                               |
| `GALOPIN_DIST_DIR`       | Where the image keeps the galopin binaries it serves at `<base>/galopin/`. Default `/app/galopin-dist`                                                                    |

The operator's view of these, and what each does to the panel, is in [The
`/code` panel](code-panel.md).
