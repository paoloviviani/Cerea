# cerea-deploy

Run **Cerea** on your own server: the chat (Cerea), the model gateway and
admin console (Pystino), a bundled identity provider (Authelia), the reverse
proxy with automatic TLS (Caddy), and optional add-ons: PII redaction, a
headless browser for web fetch, and agent machines (`/chat/code`).

Everything is in this repository and readable before you run anything: one
`compose.yaml`, one documented `.env.example`, the proxy's `caddy/Caddyfile`,
the IdP's `authelia/configuration.yml`, and `./configure`, a single
standard-library Python script that writes `.env` for you.

Licence: EUPL-1.2.

## First run

You need Docker Engine with Compose 2.24 or newer, Python 3.10 or newer (for
`./configure` only), and a DNS name pointing at the server with ports 80 and
443 open.

```sh
git clone https://github.com/paoloviviani/cerea-deploy && cd cerea-deploy
./configure
docker compose up -d
```

`./configure` asks for your origin (`https://chat.example.org`), the
administrator's email, a preset, the TLS mode and the identity provider. It
generates every secret and writes `.env` at mode 0600. The first sign-in for
the bundled Authelia goes to `first-sign-in.txt` (mode 0600). Sign in at
`https://<your origin>/`, then delete that file.

Prefer to edit by hand? Run `cp .env.example .env && chmod 600 .env`, then fill
it in. Every option is explained there, and every secret names the command that
generates it. Then run `./configure --check`.

For scripted installs, every question has a flag:

```sh
./configure --non-interactive --origin https://chat.example.org \
  --admin-email ops@example.org --preset team --tls acme --idp authelia
```

## Presets

| Preset       | Runs                                                           | For |
|--------------|----------------------------------------------------------------|-----|
| `homelab`    | gateway, console, chat; no ledger or quotas                    | one person or a family |
| `team`       | homelab + ledger, quotas, pattern-based PII redaction          | a team (the default) |
| `enterprise` | team + NER redaction (built locally) and headless-browser fetch | an organisation |
| `satellite`  | the chat only, against a central Pystino and its IdP           | a second site |
| `generic`    | the chat only, against any OpenAI-compatible endpoint          | no gateway at all |

A preset only chooses compose profiles and feature switches in `.env`. You can
change either afterwards.

## Upgrading

```sh
git pull
docker compose pull
docker compose up -d
```

Each release of this repository pins the image versions it was tested with,
inside `compose.yaml`, so you never type one. Back up first (next section).

<!-- TODO(docs task): backup and restore, TLS modes, external IdP, agent
machines (galopin one-liner), `./configure --check`, troubleshooting,
building from source (dev/build.sh), moving from a `pystino init` install. -->

## Building the images yourself

Only for development, or before a release is published:

```sh
dev/build.sh        # clones Pystino and Cerea at the pinned commits, builds, points .env at the result
docker compose up -d
dev/build.sh --reset   # back to the published images
```
