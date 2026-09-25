# cerea-deploy

Run **Cerea** on your own server: the chat (Cerea), the model gateway and
admin console (Pystino), a bundled identity provider (Authelia), the reverse
proxy with automatic TLS (Caddy), and optional add-ons: PII redaction, a
headless browser for web fetch, and agent machines (`/chat/code`).

Everything is in this repository, and you can read all of it before running anything: one
`compose.yaml`, one documented `.env.example`, the proxy's `caddy/Caddyfile`,
the IdP's `authelia/configuration.yml`, and `./configure`, a single
standard-library Python script that writes `.env` for you.

Licence: EUPL-1.2.

## First run

You need Docker Engine with Compose 2.24 or newer, Python 3.9 or newer (for
`./configure` only), and a DNS name pointing at the server with ports 80 and
443 open (or a TLS front forwarding to it: see TLS modes).

```sh
git clone https://github.com/paoloviviani/cerea-deploy && cd cerea-deploy
./configure
docker compose up -d
```

> **While the project is private:** this repository and the images it pulls
> are not public yet. Clone with credentials that can read it (`gh repo clone
> paoloviviani/cerea-deploy`, or an HTTPS token), and build the images
> locally with `dev/build.sh` (below) until they are published. Nothing else
> in these instructions changes when the repository goes public.

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
inside `compose.yaml`, so you never type one. Back up first (see Backup and restore).

Once a release is tagged, a `git pull` lands on a tested pair of versions:
check the release notes, then run the three commands. Between releases, `main`
may pin newer commits.

## What runs

| Service | Profile | What it is |
|---|---|---|
| `proxy` | always | Caddy (stock image) with `caddy/Caddyfile`: TLS, and the routes `/chat`, `/authelia`, everything else to the gateway |
| `postgres` | always | PostgreSQL with pgvector: the gateway's data and the chat's knowledge store |
| `bootstrap` | always | a one-shot on every `up`: creates the chat's database role and extensions, and the bundled Authelia's signing key and first user if absent; it never overwrites anything |
| `gateway`, `migrate`, `valkey` | `gateway` | Pystino: the OpenAI-compatible API at `/v1` and the admin console |
| `chat`, `chat-mongo` | `chat` | Cerea at `/chat` |
| `authelia` | `authelia` | the bundled identity provider at `/authelia` (stock image, `authelia/configuration.yml`) |
| `redaction`, `extractor` | `redaction` | PII redaction and document text extraction for the gateway |
| `playwright` | `fetch` | a headless browser for the chat's web fetch |

Every service names an image and nothing builds on `up`. `COMPOSE_PROFILES`
in `.env` chooses the add-ons.

## Checking an install

```sh
./configure --check          # --offline skips DNS and port probes
```

This reports everything wrong at once:
- keys missing for the profiles you run;
- values that contradict each other, such as a TLS mode whose proxy settings don't match, or a client-secret digest that isn't the secret's;
- leftovers from older installs;
- images that aren't on the host, and whether the registry needs a login;
- the Compose version;
- in `acme` mode, whether the name resolves to this host and ports 80 and 443 answer.

It changes nothing, so it is safe on a running install.

## Changing the configuration later

- **Re-run `./configure`.** It edits the existing `.env` and never overwrites it. Secrets are kept, your hand edits survive unless the answer they depend on changed, and the previous file is saved as `.env.bak-<time>`.
- **Set single values:** `./configure --set KEY=VALUE …` or `./configure --unset KEY …`.
- **Apply** with `docker compose up -d`. Compose recreates only the services whose settings changed.
- **Edited `caddy/` or `authelia/` yourself?** Compose can't see a change inside a mounted file. Run `docker compose up -d --force-recreate proxy authelia`, or `tools/pin` to refresh the `cerea.config-rev` labels that make compose notice.
- **Own routes and headers** go in `proxy.d/*.caddy`. Git ignores those files, and the proxy imports them (see `proxy.d/README.md`).

## TLS modes

| `--tls` | When | What you need |
|---|---|---|
| `acme` (default) | the server is reachable from the internet under its name | DNS pointing at the server; ports 80 and 443 open. Caddy gets and renews a Let's Encrypt certificate |
| `internal` | development, private networks | nothing; Caddy's own CA signs the certificate and browsers warn |
| `upstream` | something in front already terminates TLS (a load balancer, a tunnel, an edge proxy) | the front forwards plain HTTP to `--http-port` on this host |

The origin is always `https://…`, including in `upstream` mode, because the
applications build every URL from it.

In `upstream` mode, have the front:
- pass the original `Host`;
- forward WebSocket upgrades, at least for `/chat/api/v2/code/machine`, where each agent machine holds its link;
- not buffer responses, because chat and completions stream.

The proxy trusts `X-Forwarded-For` only from `TRUSTED_PROXIES` (default
`private_ranges`). If the front reaches this host from another range, such
as a VPN's `100.64.0.0/10`, set `TRUSTED_PROXIES` to that range. Otherwise the
logs show the front's address instead of the client's.

Servers never call the public origin: the gateway and the chat reach the IdP
on the internal network. The TLS mode therefore never means distributing a
CA certificate to containers.

## Identity

People sign in with OpenID Connect only. The stack currently signs both the
console and the chat in against one provider, the bundled Authelia or your own.
If you need several sources of users, federate them in your own IdP
(Keycloak, Authentik and the like) and point the stack at it.

**The bundled Authelia** (`--idp authelia`, the default) needs a dotted host
name, because browsers refuse its session cookie on an IP address. Its first
account is created on the first `up`. Its people are then managed in the
console (Settings → Identity providers → People). The first sign-in with the
administrator email you gave `./configure` makes that account an
administrator.

**Your own IdP** (`--idp external`): Keycloak, Entra ID, Google, Authentik or
any OIDC issuer. Register two confidential clients there, then pass their
details:

| Client | Redirect URI |
|---|---|
| console (`pystino-console`) | `https://<origin>/auth/callback/default` |
| chat (`cerea`) | `https://<origin>/chat/login/callback` |

```sh
./configure --idp external --oidc-issuer https://id.example.org/realms/main \
  --oidc-console-client-id pystino-console --oidc-console-client-secret … \
  --oidc-chat-client-id cerea --oidc-chat-client-secret …
```

Request the scopes `openid profile email groups`. If the IdP publishes no
`end_session_endpoint`, set `--oidc-logout-url 'https://id.example.org/logout?redirect={redirect}'`
so that signing out ends its session too. Arguments on the command line are
visible to other users of the machine; interactive `./configure` asks for
secrets without echoing them.

**Signing out** of either the console or the chat signs you out of both, and
out of the IdP.

**Nobody can administer?**
`docker compose exec gateway pystino admin grant you@example.org`.

## Agent machines

With `--agents` (`CODE_AGENTS_ENABLED='true'`), people can pair their own
machines and drive coding agents on them from `/chat/code`. Each machine runs
galopin, a small agent that dials out to your origin over WebSocket, so no
inbound port is needed on the machine. Your origin serves it:

```sh
curl -fsSL https://<your origin>/chat/galopin/install.sh | sh
galopin enroll --cerea https://<your origin>/chat
galopin run
```

The installer verifies the binary's checksum. `enroll` signs in through the
browser. The machine then appears in `/chat/code`, where its owner confirms
it. Revoking it there disconnects it for good.

## Backup and restore

What to keep:
- **`.env`**. It holds every secret. `GATEWAY_SECRET_KEY` decrypts the provider keys stored in the database. `AUTHELIA_STORAGE_KEY` decrypts every user's identifier. Without them a database backup is only partly usable.
- **Postgres**: users, keys, the ledger, the chat's knowledge store.
- **Mongo**: conversations.
- **The Authelia volumes**: the signing key, the users file, and the subject store.

```sh
B=backup-$(date +%Y%m%d-%H%M%S); mkdir -m 700 "$B"
cp .env "$B/"
docker compose exec -T postgres pg_dumpall -U gateway > "$B/postgres.sql"
docker compose exec -T chat-mongo mongodump --quiet --archive --gzip > "$B/chat-mongo.archive.gz"
docker run --rm -v cerea_authelia-config:/c:ro -v cerea_authelia-data:/d:ro -v "$PWD/$B:/out" \
  alpine tar czf /out/authelia.tgz -C / c d
```

(Volumes are named after `COMPOSE_PROJECT_NAME`, `cerea` by default.)

To restore into a fresh install with the same `.env`:

```sh
cp "$B/.env" .env && chmod 600 .env
docker compose up -d --wait postgres chat-mongo
docker compose exec -T postgres psql -U gateway -d postgres < "$B/postgres.sql"
docker compose exec -T chat-mongo mongorestore --quiet --archive --gzip --drop < "$B/chat-mongo.archive.gz"
docker run --rm -v cerea_authelia-config:/c -v cerea_authelia-data:/d -v "$PWD/$B:/in:ro" \
  alpine tar xzf /in/authelia.tgz -C /
docker compose up -d --wait
```

Take a backup before every upgrade: database migrations only go forward.

## Moving from a `pystino init` install

An `.env` written by `pystino init` uses the same variable names. To move
such an install:

1. Stop the old stack **without** `-v`.
2. Copy its `.env` here and keep its `COMPOSE_PROJECT_NAME`. The volumes are found by that name.
3. Run `./configure --check`. It names the keys that no longer mean anything (`COMPOSE_FILE`, `PYSTINO_DEPLOY_DIR`, the version pins); remove them with `./configure --unset …`.
4. Run `docker compose up -d --wait`.

The Caddy and Authelia configuration now comes from this repository instead
of the `pystino-proxy` and `pystino-authelia` images, which are no longer
needed.

## Troubleshooting

- `docker compose logs <service> --tail 50` is the first stop. The `bootstrap` service explains any refusal in one line ("fix .env and run `docker compose up -d` again").
- `/chat` redirects in a loop, or sign-in never sticks: the origin in `.env` doesn't match the one in the browser, or the host has no dot (bundled Authelia).
- `denied` on `docker compose pull`: the images are private, so log in to the registry once, or build them (below).
- The console shows no models: add a provider and its models in the console. An upstream key in `.env` seeds a provider row, but no model is offered until one is configured.


## Building the images yourself

Only for development, or before a release is published. You need Git access to
the Pystino and Cerea repositories:

```sh
dev/build.sh           # clone Pystino and Cerea at the pinned commits, build, point .env at the result
docker compose up -d
dev/build.sh --reset   # back to the published images
dev/build.sh --pystino-ref main --cerea-ref main   # other commits
dev/build.sh --ner     # the NER redaction image, needed by the enterprise preset (never published)
```

An image is built only when `local/<name>:sha-<commit>` is missing. The
first build of the chat image needs about 2 GB of memory. Maintainers
re-pin a release with `tools/pin --pystino <tag> --cerea <tag>`, and CI
checks the pins with `tools/pin --check`.
