# Deploying

!!! info "For operators"

    Three ways to run Cerea, one command with the deploy kit, more work
    without it. This page is the map; the cerea-deploy README is the runbook.

Cerea is a chat application: it needs a MongoDB, an OpenAI-compatible
endpoint to talk to, and an OIDC identity provider to sign people in. How
much of that you run yourself is the deployment decision, and there are
three supported answers.

## The three deployment paths

| Path | What you run | You get | Effort |
|------|--------------|---------|--------|
| **The deploy kit** (recommended) | everything: the chat, the Pystino gateway and console, a bundled identity provider, a TLS proxy and the add-ons, as one stack | the full stack: quotas, accounting, redaction, the `/code` panel's machine enrollment, the console | one `./configure` |
| **Cerea without the deploy kit** | the chat's own containers, with the environment written by hand | the same chat, pointed at a gateway or any OpenAI-compatible endpoint you already run | you write every variable and mint every secret |
| **Cerea without Pystino** | the chat only, against an existing endpoint | the chat and its features; no per-user accounting, quotas, per-caller model access or console of this deployment's own | least, with the least governance |

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
recovery are in cerea-deploy's
[README](https://github.com/paoloviviani/cerea-deploy#readme), which is the
runbook and is deliberately not repeated here.

**Without the deploy kit**, Cerea is still an ordinary containerized app:
clone this repository, copy `.env` to `.env.local`, and set at minimum
`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `CHAT_SECRET_KEY` (the key that
encrypts connector credentials at rest — unset, adding a connector fails
deliberately) and the OIDC variables (`OPENID_CONFIG` and friends — see
[Configuration](configuration.md)), then `docker compose build && docker
compose up -d` against the compose file that suits your MongoDB. Nothing
in the chat requires cerea-deploy; what the kit buys you is the *rest* of
the stack and a `.env` you did not have to research. You take on: minting
the secrets yourself, wiring your own IdP, and maintaining the versions.

**Without Pystino**, point `OPENAI_BASE_URL` at any OpenAI-compatible
endpoint. The chat works: conversations, attachments, artifacts, code
execution, knowledge bases (give them a Postgres with pgvector for the
passages — see [Configuration](configuration.md)). What you lose is what
the *gateway* provides, not the chat: per-user tokens (inference bills to
the one key you set, not to the signed-in person), quotas and the usage
ledger, per-caller model access and catalogue capabilities, redaction on
the wire, the console, and the `/code` panel's machine enrollment (galopin
authenticates against the deployment's own IdP; with a third-party
endpoint you have no console to grant from). The `generic` preset below is
exactly this shape, and it is a supported way to run the chat — just with
the governance features off.

## Presets (the deploy kit)

If you use the kit, `./configure --preset` picks the starting shape. A
preset is data — the compose profiles it switches on and the feature
switches it writes — and you can change either afterwards; switching
presets never leaves a feature key behind.

| Preset | Runs | For |
|--------|------|-----|
| `homelab` | gateway, console, chat; no ledger or quotas | one person or a family |
| `team` | homelab + ledger, quotas, pattern-based PII redaction | a team (the default) |
| `enterprise` | team + NER redaction (built locally) and headless-browser fetch | an organisation |
| `satellite` | the chat only, against a central Pystino and its IdP | a second site |
| `generic` | the chat only, against any OpenAI-compatible endpoint | no gateway at all |

Two of those are the "without Pystino" paths: `satellite` runs the chat
against a *central* Pystino (per-user tokens and quotas still apply, but
administered at the centre, and `CHAT_CONSOLE_ENABLED` is off because
administration lives there), and `generic` runs it against any endpoint
with one shared key.

The compose **profiles** underneath (chosen by `COMPOSE_PROFILES` in
`.env`, so you can deviate from any preset): `gateway` (Pystino and the
console), `chat`, `authelia` (the bundled identity provider — skip it with
your own IdP), `redaction` and `fetch` (the headless-browser fetch
backend). Profiles select services; they never change what a service is.

Once it is running, the variables Cerea itself adds are on
[Configuration](configuration.md), and the optional pieces have their own
pages: the [headless browser](browser.md) and the
[`/code` panel](code-panel.md).
