<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="static/chatui/logo-white.svg">
    <img src="static/chatui/logo.svg" alt="Cerea" width="240">
  </picture>
</p>

# Cerea

A self-hosted chat for the models your gateway exposes, with knowledge bases,
artifacts, Python in the browser, and coding agents on your own machines.

**The name.** _Cerea_ is a Turinese _modo di dire_: a historic, affectionate
greeting that means both _buongiorno_ and _arrivederci_.

![Cerea](docs/assets/cerea.png)

## Features

- **Chat over any model the gateway exposes**, signed in with OIDC; each call
  carries the person's own token, so quotas and billing are theirs. The stack
  currently signs the chat and the console in against one provider; to combine
  several sources of users, federate them in your own IdP (Keycloak,
  Authentik and the like).
- **Web search**, run by the deployment's search backends through the gateway,
  with the backend chosen in Administration → Web search (the gateway can also meter provider-side search where a model offers it).
- **File upload and extraction**: PDFs, Office documents (old `.doc` too), images
  and text, read once at upload by the gateway, which can do it inside your
  deployment. Scanned PDFs reach a model that sees images as page images.
- **Artifacts**: HTML, React and Mermaid previews in sandboxed frames with no
  network access.
- **Knowledge bases and projects**, shareable with people or groups, with an
  optional project memory ([docs/knowledge.md](docs/knowledge.md)).
- **Python in your browser**, in a WebAssembly sandbox with the scientific and
  office libraries ([docs/pyodide.md](docs/pyodide.md)).
- **Your own models and look**: a global system prompt and private custom
  models (a base model plus a prompt) under Workspace → Customize models, a
  searchable list of every chat at `/chats`, and accent and background palettes
  ([docs/chat.md](docs/chat.md)).
- **The `/code` agents panel**: coding agents on your own machines through
  **galopin**, with a file explorer, scheduled actions (a prompt sent to a
  session on a timetable) and, off by default, a browser terminal.

## Quick start

Cerea is deployed as part of a full stack: the chat, the Pystino gateway and
console, a bundled identity provider, a TLS proxy and the add-ons. The
**deploy kit**, the `kit/` directory of this repository, holds all of it: one
`compose.yaml`, a documented `.env.example`, and a `./configure` script. Its
installer fetches only that directory:

```sh
curl -fsSL https://raw.githubusercontent.com/paoloviviani/Cerea/stable/kit/get-kit.sh | sh
cd cerea/kit
./configure
docker compose up -d
```

It also covers a chat-only install, against a central Pystino gateway
(`--preset satellite`) or any OpenAI-compatible endpoint (`--preset generic`).

## Configuration

Cerea reads its settings from the environment. The ones that matter most:

| Variable                                                                                      | What                                                                        |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `OPENAI_BASE_URL`                                                                             | the OpenAI-compatible API the chat calls (the gateway's `/v1`)              |
| `USE_USER_TOKEN`                                                                              | `true`: each call carries the signed-in person's own token                  |
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

galopin runs next to the agent on a person's machine, dials out to Cerea with
its own OIDC credential, and is confirmed by its owner in `/code`. What a
machine allows (the permission ceiling, workspace roots, files, the terminal) is fixed on
the machine at enroll time; the terminal also needs `CODE_TERMINAL_ENABLED=true`
on the deployment. See [docs/code-panel.md](docs/code-panel.md) (operators),
[docs/agent-machines.md](docs/agent-machines.md) (users) and
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
[Development](https://paoloviviani.github.io/Cerea/development/) page of the
documentation.

**The image** fixes SvelteKit's base path at build time, and builds galopin
too: `docker build --build-arg APP_BASE=/chat -t cerea .`

## Upstream

Cerea began as a fork of [huggingface/chat-ui](https://github.com/huggingface/chat-ui),
with its history intact, and is now mostly a hard fork. Upstream changes are
merged by hand where they fit:

```sh
git remote add upstream https://github.com/huggingface/chat-ui.git
git fetch upstream && git merge upstream/main
```

## Documentation

The documentation is a [mkdocs](https://www.mkdocs.org) site built from `docs/`:
[chat](docs/chat.md) · [artifacts](docs/artifacts.md) ·
[pyodide](docs/pyodide.md) · [knowledge](docs/knowledge.md) ·
[connectors](docs/connectors.md) · [agent-machines](docs/agent-machines.md) ·
[browser](docs/browser.md) · [deploy](docs/deploy.md) ·
[configuration](docs/configuration.md) · [chat-admin](docs/chat-admin.md) ·
[code-panel](docs/code-panel.md) · [reference](docs/reference.md) ·
[development](docs/development.md) ·
[PRIVACY](PRIVACY.md). Build it with
`uv run --with-requirements docs/requirements.txt mkdocs build --strict`
(there is no Python project in this repository; the pins are in
`docs/requirements.txt`). [docs/source](docs/source) is **upstream chat-ui's**
documentation, kept as upstream wrote it, excluded from the site; parts of it
do not apply to Cerea.

## Contributing, security, licence

See [CONTRIBUTING.md](CONTRIBUTING.md) and, for vulnerabilities,
[SECURITY.md](SECURITY.md). Cerea is Copyright 2026 Paolo Viviani and
licensed under the [Apache License 2.0](LICENSE); [NOTICE](NOTICE) records
that it is based on huggingface/chat-ui, © Hugging Face, and carries the
third-party notices. How this code was written is disclosed in
[AI-DISCLOSURE.md](AI-DISCLOSURE.md).
