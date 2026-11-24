<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="static/chatui/logo-white.svg">
    <img src="static/chatui/logo.svg" alt="Cerea" width="240">
  </picture>
</p>

# Cerea

**Self-hosted chat and coding agents for teams: every user with their own spend, quotas and privacy rules.**

<p align="center">
  <a href="docs/assets/cerea-demo.mp4" title="Watch the demo as a video">
    <img src="docs/assets/cerea-demo.webp" alt="Cerea demo: a question answered with an artifact, then a coding agent's approval card allowed once on desktop and on a phone" width="900">
  </a>
</p>

## Try it in 5 minutes

You need Docker. The **deploy kit** (the `kit/` directory of this repository)
runs the full stack: the chat, the Pystino gateway and its console, a bundled
identity provider, a TLS proxy and the add-ons. Its installer fetches only that
directory:

```sh
curl -fsSL https://raw.githubusercontent.com/paoloviviani/Cerea/stable/kit/get-kit.sh | sh
cd cerea/kit
./configure
docker compose up -d
```

For a chat-only install, against a central Pystino (`--preset satellite`) or any
OpenAI-compatible endpoint without Pystino (`--preset generic`), and for what each
shape gives and lacks, see [docs/deploy.md](docs/deploy.md). The chat also runs
without the kit.

<p align="center">
  <a href="https://github.com/paoloviviani/Cerea/releases/latest"><img src="https://img.shields.io/github/v/release/paoloviviani/Cerea?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-Apache--2.0-blue" alt="Licence: Apache-2.0"></a>
  <a href="https://paoloviviani.github.io/Cerea/"><img src="https://img.shields.io/badge/docs-paoloviviani.github.io%2FCerea-informational" alt="Documentation site"></a>
</p>

## Why Cerea

- **Every user has their own account at the gateway.** With
  [Pystino](https://github.com/paoloviviani/Pystino), each call carries the
  signed-in user's own token, so spend, quotas and model access are per user
  and per group, not one shared key.
- **Privacy rules before the model.** The gateway redacts personal data and
  applies the rules your administrator sets (a message holding an API key can
  be refused, for example) before anything reaches a provider.
- **Coding agents on your own computers.** The `/code` panel drives agents on
  machines you pair, in Plan, Ask or Allow mode, with approval cards for what
  they want to do, which you can answer from a phone.
- **Artifacts and Office files.** HTML, React and Mermaid previews, and Word,
  Excel, PowerPoint and PDF files the assistant creates and edits.
- **Python in your browser, or in a server sandbox.** By default a WebAssembly
  sandbox on your device, so files stay there; or, when the operator enables
  it, a gVisor sandbox on the server.
- **One connector list** (MCP servers) for the chat and for your agents.

Cerea is a fork of Hugging Face's
[chat-ui](https://github.com/huggingface/chat-ui) (see [Origin](#origin)); it
keeps what that project built and adds the rest.

## How it compares

How Cerea sits next to the other self-hosted chat front ends. Each of them is
good at something Cerea is not, and the table says so.

|                                                                       | Cerea                        | Open WebUI                                      | LibreChat                | LobeChat                                       | HF chat-ui                |
| --------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------- | ------------------------ | ---------------------------------------------- | ------------------------- |
| Self-hosted                                                           | ✅                           | ✅                                              | ✅                       | ✅                                             | ✅                        |
| Licence                                                               | Apache-2.0                   | own licence, BSD-3 based with a branding clause | MIT                      | own licence, Apache-2.0 based with extra terms | Apache-2.0                |
| Per-user spend accounting and quotas                                  | ✅ with Pystino              | via plugin                                      | partial (token balances) | ?                                              | ❌                        |
| PII redaction or privacy routing before the model                     | ✅ with Pystino              | via plugin                                      | ?                        | ?                                              | ❌                        |
| Coding agents on users' own machines, with approvals                  | ✅                           | ❌                                              | ❌                       | ❌                                             | ❌                        |
| MCP connectors                                                        | ✅                           | ✅                                              | ✅                       | ✅                                             | ✅                        |
| Artifacts                                                             | ✅                           | partial                                         | ✅                       | ✅                                             | ❌                        |
| Python execution                                                      | ✅ browser or server sandbox | ✅                                              | partial                  | ?                                              | ❌                        |
| Native provider APIs (Anthropic, Gemini and others) without a gateway | ❌ OpenAI-compatible only    | partial                                         | ✅                       | ✅                                             | ❌ OpenAI-compatible only |
| Community, ecosystem and maturity                                     | young, one maintainer        | very large, many integrations                   | large, mature            | large                                          | backed by Hugging Face    |

_As of 2026-11; corrections welcome, please open an issue. "with Pystino"
means the gateway that pairs with Cerea; "via plugin" means a community or
bundled extension rather than the core; "?" means we have not been able to
confirm it._

## Cerea and Pystino

Cerea is one half of a pair. Each half solves a different problem, and each
runs on its own:

- **Cerea** (this repository) serves the users of models: the chat, its
  knowledge, artifacts and tools, and **galopin**, which pairs coding agents
  on a user's own machine.
- **[Pystino](https://github.com/paoloviviani/Pystino)** serves the
  organisation paying for them: an OpenAI-compatible gateway with per-user
  and per-group accounting, quotas, PII redaction, model access and an admin
  console.

Cerea alone runs against any OpenAI-compatible endpoint with one shared key.
Pystino alone serves any OpenAI or Anthropic client. Together they are the
intended setup: the chat calls Pystino's `/v1` with each user's own sign-in
token, so spend, quotas and model access follow the user, and the gateway
adds web search, a local document reader and metered coding agents. Below, **the
gateway** means Pystino. The deploy kit in this repository (`kit/`) runs both
together, or the chat alone.

## The name

_Cerea_ is a Turinese _modo di dire_: a historic, affectionate greeting that
means both _buongiorno_ and _arrivederci_.

## Features

Unmarked features work against any endpoint; those marked _(Pystino)_ need
the gateway.

- **Chat over any model your endpoint serves**, signed in with OIDC. With
  Pystino each call carries the user's own token, so quotas and billing are
  theirs; without it, every call uses the one key you configure. The stack
  currently signs the chat and the console in against one provider; to combine
  several sources of users, federate them in your own IdP (Keycloak,
  Authentik and the like).
- **Web search** _(Pystino)_, run by the deployment's search backends through
  the gateway, with the backend chosen in Administration → Web search (the
  gateway can also meter provider-side search where a model offers it).
- **File upload and extraction**: PDFs, Office documents (old `.doc` too), images
  and text, read once at upload. With Pystino, extraction goes through the
  gateway and can stay inside your deployment; without it, PDFs and images
  go to an OCR endpoint you name (`CHAT_OCR_BASE_URL`). Scanned PDFs reach a
  model that sees images as page images.
- **Artifacts**: HTML, React and Mermaid previews in sandboxed frames with no
  network access, and generated files (see the next item).
- **Word, Excel, PowerPoint and PDF files**: the assistant creates and edits
  them through the bundled document service, saving each edit as a new version
  and leaving the original alone. Styling by asking, or from a template you
  upload; designed slides with backgrounds and shapes; native charts
  ([docs/office.md](docs/office.md)).
- **Skills and connectors**: built-in skills for office files and data
  analysis ([docs/skills.md](docs/skills.md)), and remote MCP servers as
  connectors ([docs/connectors.md](docs/connectors.md)).
- **Knowledge bases and projects**, shareable with users or groups, with an
  optional project memory ([docs/knowledge.md](docs/knowledge.md)).
- **Python the assistant runs**: by default in your browser, in a WebAssembly
  sandbox with the scientific and office libraries, so your files never leave
  your device ([docs/pyodide.md](docs/pyodide.md)); or, when the operator
  turns it on, in a gVisor sandbox on the server with native packages and more
  memory ([docs/sandboxes.md](docs/sandboxes.md)).
- **Share links**: a link to one artifact, for signed-in users or anyone, with an expiry
  and a band naming who shared it ([docs/artifacts.md](docs/artifacts.md#sharing-an-artifact)).
- **Browser use**: the assistant does a task in a real browser on your own
  computer, with approval before anything that commits; no cloud browser
  ([docs/browser-use.md](docs/browser-use.md)).
- **Large content as files**: a long paste or attachment is handed to the
  model as a file it can read in parts, and a connector's file result is kept
  as a file of the chat ([docs/chat.md](docs/chat.md),
  [docs/connectors.md](docs/connectors.md#files-a-connector-returns)).
- **One connector list** for the chat and your agents, with local connectors
  on your own computers ([docs/local-connectors.md](docs/local-connectors.md)).
- **Self-hosted model servers** (vLLM, SGLang, llama.cpp) as gateway providers
  _(Pystino)_ ([Pystino docs](https://github.com/paoloviviani/Pystino/blob/main/docs/provider-catalogue.md#self-hosted-servers-vllm-sglang-llamacpp)).
- **Your own models and look**: a global system prompt and private custom
  models (a base model plus a prompt) under Workspace → Customize models, a
  searchable list of every chat at `/chats`, and accent and background palettes
  ([docs/chat.md](docs/chat.md)).
- **The `/code` agents panel**: coding agents on your own machines through
  **galopin**, with a file explorer, scheduled actions (a prompt sent to a
  session on a timetable) and, off by default, a browser terminal. The file
  explorer uploads, downloads and zips files and folders; Claude Code runs
  over ACP, and `galopin service` keeps galopin running
  ([docs/agent-machines.md](docs/agent-machines.md)). With
  Pystino the agents' model calls are metered like the chat's; without it
  they use opencode's own providers.

## Quick start

See [Try it in 5 minutes](#try-it-in-5-minutes) above. Which shape fits (the full stack,
a chat-only satellite, or any OpenAI-compatible endpoint) and what each gives and lacks is
in [docs/deploy.md](docs/deploy.md); the kit itself is described in
[docs/deploy-kit.md](docs/deploy-kit.md).

## Configuration

Cerea reads its settings from the environment. The ones that matter most:

| Variable                                                                                      | What                                                                        |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `OPENAI_BASE_URL`                                                                             | the OpenAI-compatible API the chat calls (Pystino's `/v1`, or any endpoint) |
| `USE_USER_TOKEN`                                                                              | `true` with Pystino: each call carries the signed-in user's own token       |
| `OPENAI_API_KEY`                                                                              | the one shared key, without Pystino                                         |
| `OPENID_PROVIDER_URL`, `OPENID_CLIENT_ID`, `OPENID_CLIENT_SECRET`                             | the OIDC sign-in                                                            |
| `MONGODB_URL`                                                                                 | conversations, settings and pairing records                                 |
| `CHAT_PG_URL`                                                                                 | PostgreSQL with pgvector, for knowledge-base passages                       |
| `ORIGIN`, `PUBLIC_ORIGIN`                                                                     | the public URL of the chat, and of the whole site                           |
| `CHAT_KNOWLEDGE_ENABLED`, `CHAT_MEMORY_ENABLED`, `CHAT_USAGE_ENABLED`, `CHAT_CONSOLE_ENABLED` | feature switches (`true` or empty)                                          |
| `FETCH_BACKEND`                                                                               | `direct` (default) or `playwright`, the [headless browser](docs/browser.md) |
| `CODE_AGENTS_ENABLED`, `CODE_TERMINAL_ENABLED`                                                | the `/code` panel, and its browser terminal                                 |

The deployment's full, commented list is the kit's `.env.example`; `.env`
here lists every variable the app understands.

## Agents

galopin runs next to the coding agent (opencode, or goose) on a user's machine, dials out to Cerea with
its own OIDC credential, and is confirmed by its owner in `/code`. What a
machine allows (the permission ceiling, workspace roots, files, the terminal) is fixed on
the machine at enroll time; the terminal also needs `CODE_TERMINAL_ENABLED=true`
on the deployment. See [docs/code-panel.md](docs/code-panel.md) (operators),
[docs/agent-machines.md](docs/agent-machines.md) (users; the
[reference](docs/agent-machines-reference.md) has the depth) and
[agent/PROTOCOL.md](agent/PROTOCOL.md) (the wire protocol).

## Development

```sh
npm ci                    # also installs the git hooks (husky)
cp .env .env.local        # then set OPENAI_BASE_URL, OPENAI_API_KEY and friends
npm run dev               # http://localhost:5173
npm run check && npm run lint
```

Tests: `npm run test` (server and ssr Vitest projects; on a CPU without AVX point
them at a real MongoDB with `TEST_MONGODB_URL` and add `--no-file-parallelism`),
`npm run test:client` (the component tests, in a real browser), `npx playwright test`
(end to end; `E2E_SKIP_BUILD=1` reuses `build/`) and `cd agent && go test ./...`
(galopin, which needs Go 1.24+). Toolchains, git hooks, every test layer, CI,
releasing and the repository's conventions are in
[CONTRIBUTING.md](CONTRIBUTING.md), which is also the
[Development](https://paoloviviani.github.io/Cerea/docs/development/) page of the
documentation.

**The image** fixes SvelteKit's base path at build time, and builds galopin
too: `docker build --build-arg APP_BASE=/chat -t cerea .`

## Origin

Cerea began as a fork of [huggingface/chat-ui](https://github.com/huggingface/chat-ui),
with its history intact, and is now a hard fork: it does not merge upstream and
carries nothing for upstream's sake. The attribution stays in [NOTICE](NOTICE).

## Documentation

The documentation is a [mkdocs](https://www.mkdocs.org) site built from `docs/`:
[chat](docs/chat.md) · [artifacts](docs/artifacts.md) ·
[pyodide](docs/pyodide.md) · [skills](docs/skills.md) ·
[knowledge](docs/knowledge.md) · [connectors](docs/connectors.md) ·
[agent-machines](docs/agent-machines.md) ·
[agent-machines-reference](docs/agent-machines-reference.md) · [browser](docs/browser.md) ·
[deploy](docs/deploy.md) · [deploy-kit](docs/deploy-kit.md) ·
[configuration](docs/configuration.md) · [chat-admin](docs/chat-admin.md) ·
[code-panel](docs/code-panel.md) · [reference](docs/reference.md) ·
[development](docs/development.md) ·
[PRIVACY](PRIVACY.md). Build it with
`uv run --with-requirements docs/requirements.txt mkdocs build --strict`
(there is no Python project in this repository; the pins are in
`docs/requirements.txt`). Pystino's documentation lives in its own
repository. [docs/source](docs/source) is **upstream chat-ui's**
documentation, kept as upstream wrote it, excluded from the site; parts of it
do not apply to Cerea.

## Contributing, security, licence

See [CONTRIBUTING.md](CONTRIBUTING.md) and, for vulnerabilities,
[SECURITY.md](SECURITY.md). Cerea is Copyright 2026 Paolo Viviani and
licensed under the [Apache License 2.0](LICENSE); [NOTICE](NOTICE) records
that it is based on huggingface/chat-ui, © Hugging Face, and carries the
third-party notices. How this code was written is disclosed in
[AI-DISCLOSURE.md](AI-DISCLOSURE.md).

## Acknowledgments

This work is supported by [LINKS Foundation](https://linksfoundation.com/en/).
