# Cerea

A chat application over [Pystino](https://gitlab.linksfoundation.com/viviani/pystino),
the gateway. **A fork of [huggingface/chat-ui](https://github.com/huggingface/chat-ui)**,
merged with its history intact.

## Why a fork, and why this one

Building a frontend from scratch was tried and abandoned. Of the candidates
assessed — LibreChat, Thunderbird's Thunderbolt, Open WebUI frozen at its last
BSD-licensed release, llms.py — chat-ui won on one measurement rather than on
features: how much of it *duplicates the gateway*.

| | code | auth files | accounting | model config |
|---|---|---|---|---|
| **chat-ui** | 2.5 MB / 533 files | **9** | **2** | **7** |
| LibreChat | 35.7 MB / 3,829 files | 263 | 57 | 379 |
| Thunderbolt | 5.3 MB / 1,121 files | 119 | 17 | 35 |

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
whole case for forking *this* project was staying close to it, and that is only
true while `git fetch upstream && git merge` keeps working.

## Authentication

**OIDC, and only OIDC.** The gateway's local email+password door (ADR 0043) is
a development and administration tool; it is off by default
(`LocalAuthSettings.enabled = False`) and a deployment with a directory should
leave it off.

chat-ui authenticates against `/v1` with an **OIDC access token**, not an API
key. `_bearer_principal` resolves it, picks the provider by the unverified
`iss` claim, verifies against that provider's keys, and produces a principal
*indistinguishable from a key-authenticated one* — quotas, model access,
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

## Deploying (the installer is the entry point)

```bash
npm run setup
# or: node installer/install.mjs [--pystino <path>] [--phase2]
```

The terminal installer proposes five deployment profiles (see Pystino's
`deploy/profiles/`): three full stacks with a local gateway — `homelab`,
`team`, `enterprise` — plus two standalone chat-only profiles with no gateway
on the box, `satellite` (against a central Pystino, no stored key — every
call carries the signed-in person's own token) and `generic` (against any
OpenAI-compatible third party, a shared key, user-token mode forced off). For
a gateway profile, it lets you toggle components within the chosen one,
generates every secret locally, writes Pystino's `deploy/.env`, and brings
the stack up in two phases (database and gateway first, because the admin
password and the chat database cannot exist before they run); nothing is
minted for the chat to boot with — it reads Pystino's public model list with
no key (ADR 0081). The standalone profiles skip the gateway phase entirely.
It needs only node — no `npm install` first — and a Pystino checkout, which
it validates or offers to clone. Pystino itself ships a simpler `install.sh`
for gateway-first operators.

Taking it back down again is here too, since this is where it was put up:

```sh
./installer/teardown.sh [--backup] [--images] [--all] [--yes]
```

Containers, named volumes and networks of the `llm-platform` project. Shell
rather than node, unlike its sibling: the installer needs a runtime because it
is a TUI that runs before `npm install`, and removing containers needs nothing
but Docker. It finds the Pystino checkout by asking Docker where the running
deployment's compose files came from — `--pystino <path>` if nothing is
running — and then hands over to that checkout's `deploy/teardown.sh`, which
is the one implementation.
`--backup` saves `deploy/.env`, the profile fragments and database dumps
first; **`deploy/.env` is gitignored and exists nowhere else**, and the
`CHAT_SECRET_KEY` in it decrypts the stored connector credentials, so a
database restored without it is a database with unreadable connectors in it.

## What this fork adds

Beyond upstream, and the reason it is Pystino-specific rather than a generic
OpenAI client:

- **Provider-side web search**, billed per search by the gateway (ADR 0058).
  Upstream removed its own search helpers; the tool passes through the gateway
  untouched, so this is request shaping rather than a search backend.
- **File upload wired to the gateway's extraction surface** — `POST /v1/ocr`
  (ADR 0055), whose local backend runs markitdown with its NLP engine switched
  off, so a `.docx` or a text-layer PDF never leaves the deployment.

## Licensing

Two licence files, on purpose:

- `LICENSE` — Apache-2.0, upstream chat-ui's, covering the code inherited from
  it. Not ours to change.
- `LICENCE` — EUPL-1.2, for first-party additions, per ADR 0001.

The EUPL's compatibility matrix lists Apache-2.0 as upstream-compatible, so a
combined work may be distributed under the EUPL; keeping both files records
which half is which rather than asserting one answer over the whole tree.
Apache-2.0 is OSI-approved, carries no CLA and is not open core, so it clears
ADR 0001's gate — but the *combination* is the one licensing question in this
fork that has not been signed off.

## Not carried over

The previous first-party attempt — `apps/chat-api` (30 files) and `apps/web`
(37) — is not here. Its history is on the `archive/monorepo-chat` branch of the
gateway's repository.

## Decisions

The decision record is **not here**. It is one numbered series for the whole
endeavour, in
[ai-stack/docs/adr](https://gitlab.linksfoundation.com/viviani/ai-stack/-/blob/main/docs/adr/README.md).
Cite by number — `(ADR 0040)` — which resolves wherever the file lives.

Planned components keep their own documents: [docs/rag.md](docs/rag.md),
[docs/desktop.md](docs/desktop.md), [docs/shared.md](docs/shared.md).
Upstream's own documentation is under [docs/source](docs/source).

## The name

**Cerea** — a Turinese *modo di dire*: a historic, affectionate greeting that
means both *buongiorno* and *arrivederci*. The gateway keeps the name Pystino;
this app now has its own.
