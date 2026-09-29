# Deploying

!!! info "For operators"

    Three ways to run Cerea, one command with the deploy kit, more work
    without it. This page is the map; the cerea-deploy README is the runbook.

Cerea is a chat application: it needs a MongoDB, an OpenAI-compatible
endpoint to talk to, and an OIDC identity provider to sign people in. How
much of that you run yourself is the deployment decision, and there are
three supported answers.

## The three deployment paths

| Path                             | What you run                                                                                                                  | You get                                                                                                                | Effort                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **The deploy kit** (recommended) | everything: the chat, the Pystino gateway and console, a bundled identity provider, a TLS proxy and the add-ons, as one stack | the full stack: quotas, accounting, redaction, the `/code` panel's machine enrollment, the console                     | one `./configure`                              |
| **Cerea without the deploy kit** | the chat's own containers, with the environment written by hand                                                               | the same chat, pointed at a gateway or any OpenAI-compatible endpoint you already run                                  | you write every variable and mint every secret |
| **Cerea without Pystino**        | the chat only, against an existing endpoint                                                                                   | the chat and its features; no per-user accounting, quotas, per-caller model access or console of this deployment's own | least, with the least governance               |

**The deploy kit** is how this deployment runs and how Cerea is meant to be
run: the [cerea-deploy](https://github.com/paoloviviani/cerea-deploy)
repository holds the whole stack as one `compose.yaml`, one commented
`.env.example` and a `./configure` script that writes your `.env` and mints
every secret.

```sh
git clone https://github.com/paoloviviani/cerea-deploy && cd cerea-deploy
./configure
docker compose up -d
```

TLS modes, upgrades, backups, the identity provider and break-glass
recovery are in cerea-deploy's README — the runbook, included on this
site as [The deploy kit](deploy-kit.md) — and are deliberately not repeated
here.

**Without the deploy kit**, Cerea is still an ordinary containerized app —
the repository carries a `Dockerfile` and an `entrypoint.sh`, not a compose
file, so you write the runtime yourself:

1. `docker build -t cerea .`
2. A MongoDB the chat can reach (`MONGODB_URL`, `MONGODB_DB_NAME`).
   `mongo:4.4` runs without AVX; MongoDB 5 and later need it.
3. Run the image with your environment: either a bind mount
   `-v $PWD/.env.local:/app/.env.local`, or pass the file's contents as
   `DOTENV_LOCAL` — `entrypoint.sh` reads both.

The minimum variables differ by what you point the chat at, because
`USE_USER_TOKEN` (with `OPENAI_BASE_URL`) is the switch that decides the
deployment shape — `true` means the chat is a gateway deployment: people
sign in through the gateway and inference bills to _them_:

- **Against Pystino:** `OPENAI_BASE_URL` at the gateway's `/v1`,
  `USE_USER_TOKEN=true`, `OPENAI_API_KEY` empty, the OIDC variables for
  **the same identity provider the gateway trusts** (`OPENID_PROVIDER_URL`,
  `OPENID_CLIENT_ID`, `OPENID_CLIENT_SECRET`, `OPENID_SCOPES`), the
  `CHAT_ERASURE_TOKEN` shared with the gateway, and `CHAT_PG_URL` for the
  knowledge bases' passages. Miss `USE_USER_TOKEN` and everything
  silently bills to a shared key instead of the people using it.
- **Against any other endpoint:** `OPENAI_BASE_URL` at the endpoint,
  `USE_USER_TOKEN` unset or `false`, `OPENAI_API_KEY` set (one shared
  key), and OIDC variables for your own identity provider.

In both: `MONGODB_URL`, and `CHAT_SECRET_KEY` (the key that encrypts
connector credentials at rest — unset, adding a connector fails
deliberately). The fork's own variables are on
[Configuration](configuration.md); upstream's container background is in
[upstream's docker installation docs](https://github.com/huggingface/chat-ui/blob/main/docs/source/installation/docker.md).
Nothing in the chat requires cerea-deploy; what the kit buys you is the
_rest_ of the stack and a `.env` you did not have to research. You take
on: minting the secrets yourself, wiring your own IdP, and maintaining
the versions.

**Without Pystino**, point `OPENAI_BASE_URL` at any OpenAI-compatible
endpoint. The chat works: conversations, attachments, artifacts, code
execution, knowledge bases (give them a Postgres with pgvector for the
passages — see [Configuration](configuration.md)). What you lose is what
the _gateway_ provides, not the chat: per-user tokens (inference bills to
the one key you set, not to the signed-in person), quotas and the usage
ledger, per-caller model access and catalogue capabilities, redaction on
the wire, the console, and gateway-billed coding agents. The `/code` panel still pairs machines against your identity provider, but with no Pystino the agents can't call models through it: enroll them with `--allow-opencode-provider` or `--allow-free-models` so they use opencode's own providers and keys, and nothing they spend is metered. The `generic` preset below is exactly this shape, and it is a
supported way to run the chat — just with the governance features off.

## Presets (the deploy kit)

If you use the kit, `./configure --preset` picks the starting shape. A
preset is data — the compose profiles it switches on and the feature
switches it writes — and you can change either afterwards; switching
presets never leaves a feature key behind.

| Preset       | Runs                                                            | For                    |
| ------------ | --------------------------------------------------------------- | ---------------------- |
| `homelab`    | gateway, console, chat; no ledger, quotas or redaction          | one person or a family |
| `team`       | homelab + ledger, quotas, pattern-based PII redaction           | a team (the default)   |
| `enterprise` | team + NER redaction (built locally) and headless-browser fetch | an organisation        |
| `satellite`  | the chat only, against a central Pystino and its IdP            | a second site          |
| `generic`    | the chat only, against any OpenAI-compatible endpoint           | no gateway at all      |

Two presets run the chat alone: `satellite`, against a _central_ Pystino (per-user tokens and quotas still apply, administered at the centre, and `CHAT_CONSOLE_ENABLED` is off because administration lives there), and `generic`, the "without Pystino" path, against any endpoint with one shared key. A central Pystino serves only **one** chat client
(gateway-side, several satellite chats share the client id, each with its
redirect URI registered), and its erasure reaches only **one** chat:
deleting a person at the centre does not erase their data on satellite
deployments.

The compose **profiles** underneath (chosen by `COMPOSE_PROFILES` in
`.env`, so you can deviate from any preset): `gateway` (Pystino and the
console), `chat`, `authelia` (the bundled identity provider — chosen by
the kit's `--idp` option, not by the preset; skip it with your own IdP),
`redaction` and `fetch` (the headless-browser fetch backend). Profiles
select services; they never change what a service is. The proxy, Postgres
and Valkey carry no profile, so they always run — including under
`satellite` and `generic`, where Postgres serves the chat's pgvector.

Once it is running, the variables Cerea itself adds are on
[Configuration](configuration.md), and the optional pieces have their own
pages: the [headless browser](browser.md) and the
[`/code` panel](code-panel.md).
