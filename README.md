# cerea-deploy

Run **Cerea** on your own server: the chat (Cerea), the model gateway and
admin console (Pystino), a bundled identity provider (Authelia), the reverse
proxy with automatic TLS (Caddy), and optional add-ons: PII redaction, a
headless browser for web fetch, and agent machines (`/chat/code`).

Everything is in this repository, and you can read all of it before running anything: one
`compose.yaml`, one documented `.env.example`, the proxy's `caddy/Caddyfile`,
the IdP's `authelia/configuration.yml`, and `./configure`, a single
standard-library Python script that writes `.env` for you.

Licence: Apache-2.0, Copyright 2026 Paolo Viviani ([LICENSE](LICENSE),
[NOTICE](NOTICE)). This kit contains no third-party code; see
[AI-DISCLOSURE.md](https://github.com/paoloviviani/cerea-deploy/blob/main/AI-DISCLOSURE.md) for how it was written.

## Third-party software

This kit contains no third-party code. It references stock images you
pull from their publishers under their own licences: Authelia
(Apache-2.0), Caddy (Apache-2.0), PostgreSQL with pgvector (PostgreSQL
Licence), Valkey (BSD-3-Clause) and MongoDB 4.4 (Server Side Public
License v1, run here as Cerea's internal database, not offered as a
service). The optional backup sidecar's image, built on your machine from
`tools/backup/`, copies in the official restic (BSD-2-Clause) and rclone
(MIT) binaries and installs Alpine's PostgreSQL client (PostgreSQL Licence),
MongoDB Database Tools (Apache-2.0) and supercronic (MIT). The Cerea and
Pystino images carry their own NOTICE files.

## First run

You need Docker Engine with Compose 2.24 or newer, Python 3.9 or newer (for
`./configure` only), and a DNS name pointing at the server with ports 80 and
443 open (or a TLS front forwarding to it: see TLS modes).

```sh
git clone https://github.com/paoloviviani/cerea-deploy && cd cerea-deploy
./configure
docker compose up -d
```

The images are public on the GitHub Container Registry
(`ghcr.io/paoloviviani/cerea`, `pystino-gateway`, `pystino-redaction`); Compose
pulls the versions this release pins, with no login.

`./configure` asks for your origin (`https://chat.example.org`), the
administrator's email, a preset, the TLS mode and the identity provider. It
generates every secret and writes `.env` at mode 0600. The first sign-in for
the bundled Authelia goes to `first-sign-in.txt` (mode 0600). Sign in at `https://<your origin>/` (the console; the chat is at `/chat/`), then delete that file.

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

Among them, what identity configuration turns up:
- an external IdP with no admin rule — set `--admin-email`, or `--admin-claim` with `--admin-claim-value`; a half-set claim pair, or an `OIDC_ADMIN_EMAIL` entry that is not a valid address, is reported the same way;
- `OIDC_LINK_BY_EMAIL` on — the reminder to turn it off when the transition is done;
- the `team` preset without SMTP — people cannot reset their own password;
- `pystino idp check --discovery-only`, run in the gateway container against the configured issuer.

It changes nothing, so it is safe on a running install.

## Changing the configuration later

- **Re-run `./configure`.** It edits the existing `.env` and never overwrites it. Secrets are kept, your hand edits survive unless the answer they depend on changed, and the previous file is saved as `.env.bak-<time>`.
- **Set single values:** `./configure --set KEY=VALUE …` or `./configure --unset KEY …`.
- **Apply** with `docker compose up -d`. Compose recreates only the services whose settings changed.
- **Edited `caddy/` or `authelia/` yourself?** Compose can't see a change inside a mounted file. Run `docker compose up -d --force-recreate proxy authelia`, or `tools/pin` to refresh the `cerea.config-rev` labels that make compose notice.
- **Own routes and headers** go in `proxy.d/*.caddy`. Git ignores those files, and the proxy imports them (see `proxy.d/README.md`).
- **Own services** go in `compose.override.yaml`: see [Adding your own services](#adding-your-own-services).

## Adding your own services

Four files, four owners:

| File | Owner |
|---|---|
| `.env` | `./configure`. It keeps keys it doesn't know in a final "Not in .env.example" section, so your own variables (a setup key, say) survive a re-run |
| `compose.yaml` | this kit; `git pull` replaces it |
| `compose.override.yaml` | you. Compose merges it into `compose.yaml` by itself, and git ignores it |
| `proxy.d/*.caddy` | you: extra routes and headers |

`./configure`, `./configure --check`, `tools/pin` and `dev/build.sh` leave the
override alone, and `--check` reads the merged result. Name no `-f` of your own
on the command line: it turns the automatic merge off.

### Example: a NetBird client in the stack

A NetBird client in the same Compose project gives the stack an address on
your NetBird network without publishing a port on the host. The proxy joins
the client's network namespace, so Caddy listens on the NetBird address:

```yaml
# compose.override.yaml
services:
  netbird:
    image: netbirdio/netbird:latest
    restart: unless-stopped
    hostname: cerea                 # the peer's name on the NetBird network
    environment:
      NB_SETUP_KEY: ${NB_SETUP_KEY:?add NB_SETUP_KEY to .env}
      NB_HOSTNAME: cerea
    cap_add: [NET_ADMIN, SYS_ADMIN, SYS_RESOURCE]
    devices: ["/dev/net/tun"]
    volumes:
      - netbird-state:/var/lib/netbird

  proxy:
    network_mode: "service:netbird"  # Caddy shares the client's namespace
    ports: !reset []                 # the client owns the network now

  gateway:
    ports: !reset []                 # drop the loopback port 8000 as well

volumes:
  netbird-state:
```

Put the key in `.env` with `./configure --set NB_SETUP_KEY=…`. The caps and
the `/dev/net/tun` device are what NetBird's own
[Docker instructions](https://docs.netbird.io/get-started/install/docker) list;
check them there for your version. The client sits on the stack's network, so
the proxy still reaches `gateway`, `chat` and `authelia` by name.

`!reset` needs Docker Compose 2.24, which `./configure` already requires. On an
older Compose, set `PUBLIC_BIND=127.0.0.1` instead: the ports stay published,
but only on the host's loopback.

**TLS.** Two setups work:
- `--tls upstream`: NetBird's reverse proxy, or another edge, terminates TLS and forwards plain HTTP to the NetBird address on port 80. It must pass `Host`, forward WebSocket upgrades and not buffer (see [TLS modes](#tls-modes)). Set `TRUSTED_PROXIES` to the range it connects from; for NetBird that is `100.64.0.0/10`.
- `--tls internal`: people reach the NetBird address or name directly, with Caddy's own certificate. Every browser and agent machine must trust that CA ([Certificate trust](#certificate-trust-with-internal-tls)).

**`PUBLIC_ORIGIN` must be the address people type into the browser** (with
`https://`), and the agent machines have to reach it as well: they join the
same NetBird network, or the origin is published some other way. The stack
builds every sign-in redirect from it.

### Example: backups with restic

A `backup` service takes the four parts of [Backup and restore](#backup-and-restore)
on a schedule — `.env`, the Postgres dump, the Mongo archive and the Authelia
volumes — and stores them in a [restic](https://restic.net) repository:
encrypted, deduplicated, on any backend restic speaks (S3, B2, Azure, GCS,
SFTP, a REST server, a local path) and on any of [rclone](https://rclone.org)'s
(`rclone:<remote>:<path>`). It is configured by environment variables in `.env`.

```sh
cp tools/backup/compose.override.example.yaml compose.override.yaml   # or merge it into yours
./configure --set RESTIC_REPOSITORY=s3:s3.eu-central-1.amazonaws.com/my-bucket/cerea \
                  RESTIC_PASSWORD=… AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…
docker compose up -d --build backup
docker compose logs backup               # "repository initialised", then "scheduler up"
docker compose exec backup backup-now    # a backup right now, in the foreground
docker compose exec backup restic snapshots
```

The image is built from `tools/backup/` on your machine, because no published
image carries restic, rclone, a Postgres 18 client and the Mongo tools
together. It is Alpine, 250 MB, with pinned sources: the official `restic/restic:0.18.1`
and `rclone/rclone:1.73.0` binaries, `alpine:3.23.6` for the rest. After a
`git pull` that changes `tools/backup/`, run `docker compose up -d --build backup`.

**Keep the repository password somewhere else.** `.env` is in every snapshot,
and it holds `RESTIC_PASSWORD`: the backup that explains how to open itself is
no use on the day `.env` is gone. Put the password (and the backend's
credentials) in a password manager as well.

#### Settings

All in `.env` (`./configure --set KEY=VALUE`); `docker compose up -d` applies a change.

| Variable | Default | |
|---|---|---|
| `RESTIC_REPOSITORY` | required | where the backups go; `rclone:remote:path` for rclone |
| `RESTIC_PASSWORD` | required | or `RESTIC_PASSWORD_FILE` (a mounted file) or `RESTIC_PASSWORD_COMMAND` |
| `AWS_*`, `B2_*`, `AZURE_*`, `GOOGLE_*`, `OS_*`, `ST_*`, … | | whatever credentials [restic reads for the backend](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html) |
| `RCLONE_CONFIG_<NAME>_TYPE`, `…_<OPTION>` | | an rclone remote defined by variables, see below |
| `BACKUP_SCHEDULE` | `17 3 * * *` | cron, five fields; `TZ` sets the timezone (UTC by default) |
| `RESTIC_FORGET_ARGS` | `--keep-daily 7 --keep-weekly 4 --keep-monthly 6` | retention, applied with `forget --prune` after each backup; set it empty to keep everything |
| `BACKUP_CHECK_EVERY` | `7` | run `restic check` every N backups (`0`: never); `RESTIC_CHECK_ARGS=--read-data-subset=5%` also reads a share of the data |
| `BACKUP_MAX_AGE_HOURS` | `36` | the container turns `unhealthy` when no backup has succeeded for this long |
| `BACKUP_HOST` | the project name | the host name recorded on every snapshot, and the one retention groups by; keep it constant |
| `BACKUP_REPO_TIMEOUT` | `120` | seconds to wait for the repository to answer before a run fails as unreachable |
| `BACKUP_WORK_SIZE` | `2g` | size of the RAM disk the dumps are written to; at least the combined size of the dumps |
| `BACKUP_MONGO` | `auto` | `auto` backs up Mongo when the `chat` profile is on; `yes` or `no` forces it |

**Repositories.**
- **A local path.** Mount it in the override (`- /srv/backups/cerea:/repo`) and set `RESTIC_REPOSITORY=/repo`. Keep it on another disk, or it protects you from nothing.
- **A restic backend with its own credentials**, as above. Check the variable names in restic's documentation for your backend.
- **rclone, with the remote defined in `.env`:** `RESTIC_REPOSITORY=rclone:cloud:cerea` and `RCLONE_CONFIG_CLOUD_TYPE=webdav`, `RCLONE_CONFIG_CLOUD_URL=…`, `RCLONE_CONFIG_CLOUD_USER=…`, `RCLONE_CONFIG_CLOUD_PASS=…` (obscured with `rclone obscure`). The remote's name is the `CLOUD` in the variable names, in lower case in the repository.
- **rclone, with an `rclone.conf`:** uncomment the `rclone.conf` volume in the override and set `RCLONE_CONFIG=/rclone.conf`. Mounted read-only, so a remote whose token rclone must refresh (Google Drive, OneDrive) needs the file writable: drop the `:ro`.
- rclone prints `Config file "/root/.rclone.conf" not found - using defaults` for every call when no file is mounted. It is harmless.

#### What a run does

1. Opens the repository, and runs `restic init` once, with a log line, if there is none. A wrong password or an unreachable backend stops here, with restic's own message.
2. Writes, into a RAM disk inside the container: `.env`, `postgres.sql` (`pg_dumpall`, over the stack's network, as `POSTGRES_USER`), `chat-mongo.archive.gz` (`mongodump`), `authelia.tgz` (both Authelia volumes, mounted read-only) and a small `backup.info`. They are the files [Backup and restore](#backup-and-restore) names, taken one after the other in a few seconds, so they belong together. `.env` is never written to a disk; the RAM disk is deleted when the run ends, however it ends.
3. `restic backup`s that directory as one snapshot, tagged `cerea`, host = the project name.
4. `restic forget --prune` with `RESTIC_FORGET_ARGS`, and every `BACKUP_CHECK_EVERY`-th run a `restic check`.

The stack keeps running throughout and nothing is stopped. `pg_dumpall` and
`mongodump` read consistent data while the services write. Authelia's SQLite
store is copied with SQLite's own online backup, so it is consistent too; the
rest of its volumes are a few small files that change rarely. A person who
changes their password during the few seconds of a run is the only race, and
the next run holds the result. The two stores are not one transaction: schedule
the run for a quiet hour, and take a manual backup with the stack idle before an upgrade.

The container is not root on the host. It has no Docker socket, a read-only
root filesystem, `cap_drop: ALL` (plus `DAC_OVERRIDE`, for Authelia's 0600
files and a repository directory that is not root's), and mounts `.env` and
the Authelia volumes read-only.

#### Failures

Every run ends in a log line you can search for: `BACKUP OK` or
`BACKUP FAILED at step '…'`, on stderr, with restic's message above it, and the
run exits non-zero. `docker compose logs backup | grep -E 'BACKUP|PREFLIGHT'`
is the whole history. The container's health turns `unhealthy`
(`docker compose ps`) after a failed run, or when the last success is older than `BACKUP_MAX_AGE_HOURS`,
which also catches a scheduler that never fired. At start the sidecar opens the repository
and logs `PREFLIGHT FAILED` if it cannot, so a wrong password shows when you
`up` it, not at 03:17. A run that finds another one still going stops with exit 75.

#### Restoring from the repository

On the machine you are rebuilding, with the kit cloned. All it needs are the
repository's address, password and credentials, from your password manager:

```sh
docker build -t cerea-backup:1 tools/backup
cat > restore.env <<'EOT'        # no quotes: docker's --env-file keeps them
RESTIC_REPOSITORY=…
RESTIC_PASSWORD=…
EOT
mkdir -m 700 restore
docker run --rm -e BACKUP_RESTORE_CHOWN="$(id -u):$(id -g)" --env-file restore.env \
  -v "$PWD/restore:/restore" cerea-backup:1 restore          # or: restore <snapshot-id>
B=restore
```

Add what your backend needs: `-v /srv/backups/cerea:/repo` for a local
repository, the `RCLONE_CONFIG_*` variables to `restore.env`, or `-v
"$PWD/rclone.conf:/rclone.conf:ro" -e RCLONE_CONFIG=/rclone.conf`. On a box that still
has its `.env` and override, `docker compose run --rm --no-deps --cap-add CHOWN -e BACKUP_RESTORE_CHOWN="$(id -u):$(id -g)" -v "$PWD/restore:/restore" backup restore` does the same.
With restic installed on the host, `restic restore latest:/work/cerea --tag cerea --target restore` lands the same files.

`restore` prints the repository's snapshots and fills `restore/` with the five
files, newest snapshot by default (`BACKUP_RESTORE_CHOWN` hands them to you). Then follow the restore steps in
[Backup and restore](#backup-and-restore) from `cp "$B/.env" .env`. Delete
`restore/` afterwards: it holds every secret in the clear.

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

### Certificate trust with internal TLS

Caddy signs the certificate with its own CA, so every browser shows a warning
until you trust that CA, or accept the warning once. The CA certificate is
created on the first start; copy it out of the proxy:

```
docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt cerea-root.crt
```

Agent machines (galopin) have no flag to skip certificate checks and no
setting for an extra CA; they use the machine's own trust store. Install
`cerea-root.crt` there: in the system store (macOS Keychain, Windows
"Trusted Root Certification Authorities", or `update-ca-certificates` on
Debian and Ubuntu), or, on Linux, point galopin at it with
`SSL_CERT_FILE=/path/to/cerea-root.crt` (Go reads that variable). An agent
machine on a server with a real certificate needs nothing.

Servers never call the public origin: the gateway and the chat reach the IdP
on the internal network. The TLS mode therefore never means distributing a
CA certificate to containers.

## Identity

People sign in with OpenID Connect only: the console, the chat and galopin
all sign in against **one identity provider**, named in `.env` by
`./configure`. The gateway takes its settings from `.env` on every start, so
the provider is never edited anywhere else — the console shows it read-only.

Only one provider is supported at a time. To combine several sources of users
(a corporate directory plus social logins, say), federate them in an IdP that
brokers logins and point the stack at it. In Keycloak: create a realm, add the
upstream providers under **Identity providers** (each an OIDC or SAML
broker), and Keycloak signs everyone in itself — the stack sees a single
issuer, Keycloak's, with a single set of clients. Use mappers to put what the
stack reads into Keycloak's tokens: a groups claim, and `email` with
`email_verified`.

**The bundled Authelia** (`--idp authelia`, the default) works with a dotted
DNS name (`cerea.example.org`) or an IP address (`https://192.168.1.10`, with
`:port` if you use one). It does not work with a single-word name such as
`myserver`: Authelia rejects that as its cookie domain. If you would rather
have a name than an IP on a private network, a wildcard DNS service gives you
one: `192-168-1-10.sslip.io` (or `nip.io`) resolves to `192.168.1.10`. An IP
or a private name cannot get a Let's Encrypt certificate, so use
`--tls internal` there (see "Certificate trust" below). Its first account is created on the first `up`; the first sign-in with the
administrator email you gave `./configure` makes that account an
administrator.

Its accounts are managed from the console's **Users** page:

- **Add user** creates the Authelia login and the gateway account together
  and shows a one-time password once. Pass it on through a one-time channel
  (a password manager share, or in person); Authelia cannot force a change at
  first sign-in.
- **Create sign-in** gives an existing account a bundled login — the case
  after a switch back from an external IdP or break-glass, for someone who
  only ever had an identity at the other provider.
- **Reset password** mints a fresh one-time password for their login.
- **Disable** and **Enable** cut a person's access everywhere without
  erasing anything (below).
- **Delete** erases the person everywhere, chat included (below).

Groups and roles live in the console too (the **Groups** page): the bundled
users file carries no groups of its own.

With SMTP set (`./configure --smtp-host …`), people reset their own password
from the sign-in page. Without it, only an administrator can, by issuing a
one-time password from the Users page.

**Need MFA?** The bundled Authelia is one-factor: its TOTP and WebAuthn are
switched off. Deployments that need a second factor use an external IdP such
as Keycloak — TOTP or WebAuthn is configured there — and point the stack at
it through `.env`.

**Your own IdP** (`--idp external`): Keycloak, Entra ID, Google, Authentik or
any OIDC issuer. Register three clients there, then pass their details:

| Client | Kind | Redirect |
|---|---|---|
| console (`pystino-console`) | confidential | `https://<origin>/auth/callback/default` |
| chat (`cerea`) | confidential | `https://<origin>/chat/login/callback` |
| galopin (`opencode-enrollment`) | public | the device flow, and loopback `http://localhost/callback` |

The machine client needs the device-flow and refresh-token grants and
`offline_access` in its scopes; the other two take the scopes
`openid profile email groups`. Map the groups claim the IdP sends
(`--oidc-groups-claim`, `groups` by default), and make sure `email` arrives
with `email_verified` as the JSON boolean `true`. If the IdP publishes no
`end_session_endpoint`, set
`--oidc-logout-url 'https://id.example.org/logout?redirect={redirect}'` so
that signing out ends its session too.

**Signing out** of either the console or the chat signs you out of both, and
out of the IdP.

```sh
./configure --idp external --oidc-issuer https://id.example.org/realms/main \
  --admin-email ops@example.org \
  --oidc-console-client-id pystino-console --oidc-console-client-secret … \
  --oidc-chat-client-id cerea --oidc-chat-client-secret …
```

Arguments on the command line are visible to other users of the machine;
interactive `./configure` asks for secrets without echoing them.

**Who is an administrator** is decided in `.env`, and re-checked at every
sign-in and at every gateway start:

- `--admin-email` (`OIDC_ADMIN_EMAIL`): a comma-separated list of addresses.
  An address grants admin only when the IdP asserts `email_verified: true`
  for it. Removing an address takes its admin away at the next start; the
  last active administrator is never revoked.
- `--admin-claim` and `--admin-claim-value`: the values of a claim (the
  groups claim, typically) that confer admin.

With an external IdP and neither set, the gateway refuses to start:

```
an external identity provider needs an admin rule: set OIDC_ADMIN_EMAIL, or
OIDC_ADMIN_CLAIM with OIDC_ADMIN_CLAIM_VALUE, in .env
(./configure --admin-email / --admin-claim --admin-claim-value)
```

`./configure --check` runs the same rule offline before you commit to it,
and probes the configured issuer with `pystino idp check --discovery-only`
in the gateway container. To test the admin rule with a real sign-in before
switching, run the device-flow variant and sign in on any browser:

```sh
docker compose run --rm --no-deps gateway pystino idp check --device
```

It reports the token's `sub`, the email and `email_verified` **with its JSON
type** (the string `"true"` is not accepted), the groups claim's value, the
audience and client, whether each admin rule would grant, and — with
link-by-email on — how many existing accounts a first sign-in would link to.

### Switching the identity provider

1. **Back up** (see [Backup and restore](#backup-and-restore)).
2. **Ask everyone to sign in once** since upgrading, before you switch. Accounts are
   keyed by their gateway id, which the chat learns at each person's first
   sign-in; for anyone who has not signed in yet, keeping their chat history
   falls to the merge in the next step.
3. **Switch:** `./configure --idp external …` (or `--idp authelia` to switch
   back), then `./configure --check`, then `docker compose up -d`.
4. **Existing users.** Their accounts and chat history stay. A person keeps
   theirs when one of these happens:
   - **Link by email.** With `OIDC_LINK_BY_EMAIL=true` (off by default; set
     it with `--link-by-email`), a first sign-in with a verified email
     attaches to the one existing account with that address. It never
     attaches to an administrator. Turn it off with `--no-link-by-email`
     once the transition is done; a warning prints at every start while it
     is on.
   - **Merge.** An administrator picks **Merge into…** on the Users page and
     moves the old account into the new one (or the other way round). The
     chat follows automatically: the person's conversations appear under the
     surviving account at their next sign-in, or within a minute of their
     next activity.
5. **Each person with an agent machine re-enrolls it.** Their `/chat/code` shows **Re-enroll this machine: the identity provider changed** with the command to run on that machine; tell them before you switch.

### Merging accounts

The merge moves everything that belongs to the person: their identities at
every issuer, group memberships, model access, API keys, spend history, and
their quota and redaction rules. The target keeps their own profile and
settings; an identity both accounts hold at one issuer is dropped, and named
in the preview. The dialog asks you to type the source account's address to
confirm, plus a reason for the audit trail.

**The merge is irreversible.** There is no split-back: the undo is the backup
taken before it.

### Break-glass

When nobody can administer, or the identity provider itself is gone:

```sh
./configure --break-glass --admin-email ops@example.org --reason "IdP outage"
```

It rewrites `.env` to the bundled Authelia — your external settings are kept
in the `.env.bak-<timestamp>` file it makes and nowhere else — brings the
stack up, and grants admin to the account with that email: creating it if it
does not exist, re-enabling their bundled login if it was disabled, or
creating one if they never had it. It prints the sign-in URL, the login and
a one-time password, once. Everyone else's accounts, memberships and chat
history are untouched. Each person with an agent machine has to re-enroll it, because its tokens name the old issuer; tell them before you switch.

To go back to your external IdP afterwards, switch again with its values from
the backup file: `./configure --idp external … --oidc-issuer …`, then
`--check`, then `docker compose up -d`. The accounts and identities that
provider held resolve again.

For someone who **can** already sign in,
`docker compose exec gateway pystino admin grant you@example.org` grants or
revokes admin without touching anything else.

### Disabling and deleting a user

**Disable** (Users page) ends the person's console and chat sessions and
closes their machine links within a minute, and refuses new sign-ins.
Already-issued IdP tokens keep working at the IdP until they expire — the
stack refuses them regardless. **Enable** brings the account back; sessions
and machine links stay revoked, so they sign in again and re-enroll their
machines.

**Delete** erases the person everywhere, chat included: conversations, files
and attachments, projects, assistants, knowledge bases, memories, skills,
MCP connectors, settings, sessions and machine links. Content they shared
with other people disappears for them too; the delete confirmation names it
and asks you to tick it before it proceeds. Their spend history stays in the
ledger, anonymised. If the chat is down at delete time, the erasure is queued
and retried until the chat confirms — `docker compose exec gateway pystino
erasure list` shows the queue.

## Agent machines

With `--agents` (`CODE_AGENTS_ENABLED='true'`), people can pair their own
machines and drive coding agents on them from `/chat/code`. Each machine runs
galopin, a small agent that dials out to your origin over WebSocket, so no
inbound port is needed on the machine.

The pairing dialog prints **one command** to copy, already filled in with
this deployment's issuer, gateway and client — install, enroll and run in a
single line:

```sh
curl -fsSL '<origin>/chat/galopin/install.sh' | sh && \
  galopin enroll --issuer '<issuer>' --gateway '<origin>' --cerea '<origin>/chat' && \
  galopin run
```

An **Allow terminal** checkbox on the same dialog adds `--allow-terminal` to
the command. It grants interactive shell access on the machine to whoever
controls your chat session — no model and no permission rule in the way once
a terminal is open — so it stays off unless you want it. The installer
verifies the binary's checksum; `enroll` signs in through the browser. The
machine then appears in `/chat/code`, where its owner confirms it. Revoking
it there disconnects it for good. A machine whose identity provider changed,
or whose access was revoked, shows **Re-enroll this machine** in the device
list, with the same command.

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
P=cerea    # COMPOSE_PROJECT_NAME: the volumes are named after it
docker run --rm -v ${P}_authelia-config:/authelia-config:ro -v ${P}_authelia-data:/authelia-data:ro \
  -v "$PWD/$B:/out" alpine tar czf /out/authelia.tgz -C / authelia-config authelia-data
```

Prefer it automatic, scheduled and off the box? The [restic sidecar](#example-backups-with-restic)
writes exactly these four files, encrypted, to a repository of your choice.

To restore into a fresh install with the same `.env`:

```sh
cp "$B/.env" .env && chmod 600 .env
docker compose up -d --wait postgres chat-mongo
docker compose exec -T postgres psql -U gateway -d postgres < "$B/postgres.sql"
docker compose exec -T chat-mongo mongorestore --quiet --archive --gzip --drop < "$B/chat-mongo.archive.gz"
# The archive stores `authelia-config/` and `authelia-data/` at its root;
# unpack, then move each into its volume.
P=cerea    # COMPOSE_PROJECT_NAME
docker run --rm -v ${P}_authelia-config:/c -v ${P}_authelia-data:/d -v "$PWD/$B:/in:ro" \
  alpine sh -c "tar xzf /in/authelia.tgz -C /tmp && cp -a /tmp/authelia-config/. /c/ && cp -a /tmp/authelia-data/. /d/"
docker compose up -d --wait
```

Restoring from the restic sidecar's repository? `$B` is the directory
[its `restore` command](#restoring-from-the-repository) fills; the steps are the same.

Take a backup before every upgrade: database migrations only go forward.

Restore the four parts **from the same backup**: Postgres (accounts, keys,
the ledger), Mongo (conversations), the `authelia-config` volume (the users
file) and `authelia-data` (every person's subject identifier and sessions)
reference one another, and restoring one without the others leaves accounts
pointing at logins or subjects that no longer exist. The bootstrap creates
the first account only when the users file is absent — it never recreates or
overwrites an existing one — so a restored file stays exactly as backed up.

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
- `/chat` redirects in a loop, or sign-in never sticks: the origin in `.env` doesn't match the one in the browser, or the host is a single-word name such as `myserver` (the bundled Authelia needs a dotted name or an IP address).
- `denied` or `manifest unknown` on `docker compose pull`: `.env` names a version or registry that is not published (an old `CEREA_VERSION`/`PYSTINO_VERSION` override, or `*_REGISTRY='local'` left by `dev/build.sh`). Run `dev/build.sh --reset`, or remove those keys.
- The console shows no models: add a provider and its models in the console. An upstream key in `.env` seeds a provider row, but no model is offered until one is configured.


## Building the images yourself

Only for development, or to run commits that have no published image yet
(both source repositories are public):

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
