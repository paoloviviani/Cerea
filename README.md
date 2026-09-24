# Cerea

A chat application over [Pystino](https://github.com/paoloviviani/Pystino),
the gateway. **A fork of [huggingface/chat-ui](https://github.com/huggingface/chat-ui)**,
merged with its history intact.

## Why a fork, and why this one

Building a frontend from scratch was tried and abandoned. Of the candidates
assessed — LibreChat, Thunderbird's Thunderbolt, Open WebUI frozen at its last
BSD-licensed release, llms.py — chat-ui won on one measurement rather than on
features: how much of it _duplicates the gateway_.

|             | code                  | auth files | accounting | model config |
| ----------- | --------------------- | ---------- | ---------- | ------------ |
| **chat-ui** | 2.5 MB / 533 files    | **9**      | **2**      | **7**        |
| LibreChat   | 35.7 MB / 3,829 files | 263        | 57         | 379          |
| Thunderbolt | 5.3 MB / 1,121 files  | 119        | 17         | 35           |

Those three columns are the argument. Pystino owns identity, accounting and
model access; a fork that ships its own must either be gutted or run in
parallel, and both cost forever. Upstream chat-ui had already deleted its
provider-specific code — it speaks **OpenAI-compatible APIs only**, via
`OPENAI_BASE_URL`, discovering models from `/models`. That is Pystino's `/v1`
contract verbatim, so there was nothing to gut.

Open WebUI was disqualified on security rather than licence: v0.6.5 is the last
BSD-3-Clause tag, but **240 of the project's 400 published advisories affect
it** (4 critical, 108 high), it is 8,348 commits stale, and the licence change
means those patches cannot be taken.

Thunderbolt is the more mature project and remains the better answer if a real
iOS client is ever required — it already carries one, and that is a capability
this side cannot manufacture. The trade taken here is a PWA instead, plus a
desktop agent against this app.

## The one architectural rule, unchanged

This is a **`/v1` client**. It imports nothing from the gateway: no shared
database, no shared models, no Python package in common. If it ever needs
something `/v1` does not expose, the fix is a gateway feature with an ADR, not
an import.

That rule is why upstream's history is merged here rather than snapshotted: the
whole case for forking _this_ project was staying close to it, and that is only
true while `git fetch upstream && git merge` keeps working.

## Authentication

**OIDC, and only OIDC.** The gateway's local email+password door (ADR 0043) is
a development and administration tool; it is off by default
(`LocalAuthSettings.enabled = False`) and a deployment with a directory should
leave it off.

chat-ui authenticates against `/v1` with an **OIDC access token**, not an API
key. `_bearer_principal` resolves it, picks the provider by the unverified
`iss` claim, verifies against that provider's keys, and produces a principal
_indistinguishable from a key-authenticated one_ — quotas, model access,
redaction scoping and the ledger all read the user and the group, and none of
them cares which credential arrived (ADR 0040, ADR 0051).

Two operational consequences worth knowing before deploying this:

- `GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE` must be set or `/v1` rejects every
  token — with the same message a bad API key gets, deliberately, so a prober
  cannot learn that an identity provider exists.
- **Disabling the local door removes the recovery door.** ADR 0056 records that
  a local admin adopted by a directory which does not place them in an admin
  group loses the flag, and that the recovery is the local door. Bootstrap the
  first provider through `GATEWAY_OIDC__*` env seeding; the console owns every
  provider after that (ADR 0051).

## Deploying: `cerea init`

```bash
mkdir my-cerea && cd my-cerea
/path/to/Cerea/scripts/cerea init --origin https://chat.example.org --admin-email you@example.org
./cerea doctor && docker compose up -d --wait
```

**The host needs Docker and nothing else** — no checkout, no node. `cerea init`
asks at most a handful of questions, mints every secret into one `.env` (mode
0600), and writes a `compose.yaml` and a `./cerea` helper into the directory.
The images are pulled, versioned, from `ghcr.io/paoloviviani/` (private while
the repositories are: `docker login ghcr.io` once with a token holding
`read:packages`; `init` tells you if it is missing). Upgrading is
`./cerea upgrade <version>` followed by the same `docker compose up`.

Two shapes, picked for you:

- **Against a Pystino gateway** (`--central-url https://llm.example.org`, the
  _satellite_ preset): the chat uses the gateway's `/v1` and signs in against
  its identity provider; every call carries the signed-in person's own token,
  and no key is stored on the box (one is refused — it would bill a whole site
  to one account).
- **Against any OpenAI-compatible endpoint** (the _generic_ preset; export
  `PYSTINO_UPSTREAM_API_KEY` first): one shared key, user-token mode forced off
  (it would send the person's IdP token to a third party), and a bundled
  Authelia for sign-in unless you bring your own OIDC provider.

Want the gateway too — accounting, quotas, redaction, per-user billing? That
is a full Pystino stack, set up the same way with `pystino init`; the chat is
part of it. Both commands are the same tool: it ships inside the Pystino
gateway image, so a Cerea-only install and a full stack are one topology and
one upgrade path (see Pystino's `deploy/stack/`).

**Development** builds the images from local checkouts instead of pulling
them — `pystino init --mode dev --cerea-src <this checkout>` from a Pystino
checkout — with the same configuration and the same `docker compose up`.

Installs made by the previous bash installer move over with `pystino adopt`
(it reads the old deployment, carries every secret, and prints the cutover).

## What this fork adds

Beyond upstream, and the reason it is Pystino-specific rather than a generic
OpenAI client:

- **Provider-side web search**, billed per search by the gateway (ADR 0058).
  Upstream removed its own search helpers; the tool passes through the gateway
  untouched, so this is request shaping rather than a search backend.
- **File upload wired to the gateway's extraction surface** — `POST /v1/ocr`
  (ADR 0055), whose local backend runs markitdown with its NLP engine switched
  off, so a `.docx` or a text-layer PDF never leaves the deployment.
- **The `/code` Agents panel** (ADR 0089, superseding 0085) — coding agents running on people's
  own machines, driven from the sidebar. `pystino-agent` on the machine dials
  out to the chat over WSS with its own OIDC credential; Cerea stores nothing
  but the pairing record. Off unless `CODE_AGENTS_ENABLED=true`
  (`pystino init --agents`). See
  [docs/code-panel.md](docs/code-panel.md) for deploying it and
  [docs/agent-machines.md](docs/agent-machines.md) for using it; building,
  distributing and installing `pystino-agent` on a machine is Pystino's
  `docs/agent-machines.md`.

## Licensing

Two licence files, on purpose:

- `LICENSE` — Apache-2.0, upstream chat-ui's, covering the code inherited from
  it. Not ours to change.
- `LICENCE` — EUPL-1.2, for first-party additions, per ADR 0001.

The EUPL's compatibility matrix lists Apache-2.0 as upstream-compatible, so a
combined work may be distributed under the EUPL; keeping both files records
which half is which rather than asserting one answer over the whole tree.
Apache-2.0 is OSI-approved, carries no CLA and is not open core, so it clears
ADR 0001's gate — but the _combination_ is the one licensing question in this
fork that has not been signed off.

## Not carried over

The previous first-party attempt — `apps/chat-api` (30 files) and `apps/web`
(37) — is not here. Its history is on the `archive/monorepo-chat` branch of the
gateway's repository.

## Decisions

The decision record is **not here**, and is deliberately never linked: it is
one numbered series for the whole endeavour, it is private, and a URL into it
promises a source the reader cannot open. Cite by number — `(ADR 0040)` —
which resolves wherever the file lives.

## Documentation

- [docs/code-panel.md](docs/code-panel.md) — deploying the `/code` Agents
  panel: the flags, the machine link, what is stored.
- [docs/agent-machines.md](docs/agent-machines.md) — pairing a machine, and
  what the panel does.
- [docs/pyodide.md](docs/pyodide.md) — client-side Python execution, its
  sandbox and what it deliberately cannot do.
- [docs/browser.md](docs/browser.md) — the headless browser behind
  `FETCH_BACKEND=playwright`, and why it is never published.
- [docs/rag.md](docs/rag.md) — knowledge bases: what is built and what the
  decisions were.
- [docs/desktop.md](docs/desktop.md) — the desktop shell: not started, and the
  decisions already taken about it.
- Upstream chat-ui's own documentation is under
  [docs/source](docs/source) — read it as upstream's, not as this fork's.

## The name

**Cerea** — a Turinese _modo di dire_: a historic, affectionate greeting that
means both _buongiorno_ and _arrivederci_. The gateway keeps the name Pystino;
this app now has its own.
