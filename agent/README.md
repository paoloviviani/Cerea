# galopin

galopin — Torinese for a clerk or handyman — is the Cerea machine agent: the
one binary a coding-agent machine runs so the chat's `/code` panel can drive
opencode (or any ACP agent) on it. It authenticates a person to the Pystino
gateway, wires up opencode's config, and dials **out** to Cerea over WSS —
with no relay in between and nothing capability-bearing stored in Cerea. The wire
protocol it speaks is `PROTOCOL.md`, in this same directory.

## Licensing

galopin is part of Cerea and shares its licence, the Apache License 2.0
(`LICENSE` at the repository root).

## Building

Go 1.24+, no other build dependency:

```sh
cd agent
go build -o galopin .              # this machine's OS/arch
GOOS=linux GOARCH=arm64 go build -o galopin-linux-arm64 .   # cross-compile
```

Deployments serve these binaries themselves: the Cerea image builds them
into `/app/galopin-dist` and `<base>/galopin/install.sh` installs one
(checksum-verified). See `docs/agent-machines.md`.

`packaging/build-dist.sh [OUT_DIR]` (default `./galopin-dist`) cross-builds
all four targets users run this on (`linux/amd64`, `linux/arm64`,
`darwin/amd64`, `darwin/arm64`) as static binaries (`CGO_ENABLED=0`), and
writes `REVISION` (the Cerea commit built from), `SHA256SUMS`, and copies in
`packaging/galopin.service` and `packaging/org.cerea.galopin.plist`.

## opencode releases

galopin drives opencode's HTTP and ACP surfaces, so an opencode release can
break it (a renamed permission, a changed event). The release galopin is
built and tested against is written once, in `packaging/opencode-version`; the
binary embeds it (`Backend.Version()`), CI installs it, and the panel's
install line (`OPENCODE_VERSION` in `src/lib/codeEnrollCommand.ts`) is
checked equal to it by a spec.

`.github/workflows/opencode.yml` runs the **whole** real-opencode suite (every
`*_it_test.go`, permission tests and `TestUpgradeCanary*` included, with
`GALOPIN_OPENCODE_IT=1 GALOPIN_ACP_IT=1`):

- **`pinned`**: the pinned release. On a push to main that touches `agent/`,
  weekly, and on demand.
- **`latest`**: opencode's newest release, daily (or `version` on a manual
  run, to try a specific release). Does nothing when that is the pin, or
  when the release already passed against this `agent/` tree (cached). Each
  job's summary lists the version, counts and failing tests.

`latest` keeps one open issue, labelled `opencode-pipeline`:

- **`opencode <v> breaks galopin`**: the failing tests, the run link, the
  first failure's message. It is updated on each failing run, not duplicated.
  The pin stays where it is; nothing breaks for users, who install the pinned
  release. Reproduce with the command in the issue, then fix galopin (or
  decide to stay on the pin).
- **`opencode <v> passes galopin's real-opencode suite: ready to bump the
pin`**: a checklist for the next step. It closes an older "ready" issue.

To bump: `packaging/bump-opencode.sh <version>` rewrites both places and
prints the local commands to run (install that release, the full suite, the
TS spec). Review the opencode release notes too: the suite cannot see a new
behaviour it does not test. Commit; the `pinned` job re-runs on the merge.

## goose releases

`galopin enroll --engine goose` runs goose (`goose acp`) instead of opencode
(ADR 0110). The pinned release is `packaging/goose-version`, with archive
checksums in `packaging/goose-sha256` (upstream publishes none).
`.github/workflows/goose.yml` runs the goose suite (`GALOPIN_GOOSE_IT=1`, a fake
OpenAI-compatible model, no secrets) on the pinned release for changes under
`agent/` and weekly, and on goose's latest daily, keeping one issue ("breaks
galopin" or "ready to bump the pin"). Bump with `packaging/bump-goose.sh
<version>`. Locally: install that goose, then `GALOPIN_GOOSE_IT=1 go test -run
Goose .`. `galopin goose setup` configures a user's own goose; see the
agent-machines reference.

## Running

```
galopin enroll   sign in, pick a billing group, write opencode.json,
                 store the refresh credential
galopin auth     sign in again with no re-enroll ('login', alias 'refresh'),
                 change the billing group ('group'), show the state ('status')
galopin serve    the local refreshing proxy shim alone (opencode with no /code panel)
galopin run      serve, plus supervise opencode (or an ACP agent) and dial out to Cerea
galopin models   'models refresh': re-discover the gateway's models, no re-enroll
galopin policy   show, or locally tighten, this machine's policy.json
galopin licenses the third-party licence notices compiled into the binary
```

```sh
export GATEWAY_BASE_URL=https://cerea.example.org   # the kit: your PUBLIC_ORIGIN
export CEREA_BASE_URL="$GATEWAY_BASE_URL/chat"
export OIDC_ISSUER="$GATEWAY_BASE_URL/authelia"     # bundled Authelia; else your IdP's issuer

galopin enroll --issuer "$OIDC_ISSUER" \
  --gateway "$GATEWAY_BASE_URL" --cerea "$CEREA_BASE_URL"
galopin run
```

A satellite or standalone chat on another host sets `CEREA_BASE_URL` to that
address. The chat's Pair dialog shows this command with your addresses filled
in.

`enroll` writes the opencode config to `<config-dir>/galopin/opencode.json`
(beside `credentials.json`, whatever directory you run it from) unless
`--output` says otherwise, and records that file's absolute path in
`credentials.json`. `run` reads it from there and hands it to opencode, so no
flag is needed. A machine enrolled before the path was recorded gets a warning
from `run`: re-run `enroll`, or pass `run --opencode-config PATH`.

### Using opencode yourself: `galopin launch opencode`

```sh
galopin launch opencode [--opencode PATH] [--port PORT] [-- opencode arguments…]
```

Starts your own interactive opencode, in the current directory, set up the way
galopin sets up the one it supervises, but **without dialing Cerea**: no
pairing, no machine link, nothing in the Agents panel. It uses

- the `opencode.json` `enroll` wrote (as `OPENCODE_CONFIG`), so the same
  gateway provider and models;
- the same local proxy, so the same refreshed credential and billing group.
  A `run` or `serve` already listening on the shim port is reused; otherwise
  galopin starts the proxy for as long as this opencode runs and stops it when
  it exits (never two on one port);
- the machine's project-config setting (`--allow-project-config`; off by
  default, in which case opencode starts with `--pure`), and a private
  `TMPDIR` of its own, so it never disturbs a running `galopin run`.

Everything after `--` goes to opencode untouched, and galopin exits with
opencode's exit code; SIGINT, SIGTERM and SIGHUP are forwarded. A machine that
is not enrolled stops with "run 'galopin enroll' first". `--opencode PATH`
picks the binary (default `opencode` on PATH, then `$HOME/.opencode/bin`); one
that differs from the version galopin is tested against only draws a warning.

Provider credentials and routing selectors in your shell (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, the other
well-known provider keys and base URLs, `OPENCODE_PERMISSION`, `OPENCODE_MODEL`)
are removed from opencode's environment, so nothing is billed outside the
gateway by accident. Your own opencode configuration (`~/.config/opencode`,
`opencode auth`) still applies, exactly as under `run`.

**Not supervised.** galopin prints, on stderr:
`galopin: local opencode, billed to <group>; not supervised by Cerea (no
Plan/Ask/Auto, no review log)`. opencode is given the "everything asks"
permission floor, so every tool call asks you, in the terminal. What cannot
apply is anything that needs galopin to answer for you: the refusal of
galopin's own state and credentials, the Plan/Ask/Auto selector, the delegated
permissions and the review log. Treat it as opencode with the gateway wired in.
The command is `launch <tool>` so other tools can follow; only opencode exists.

### Models

`enroll` discovers the gateway's models once and writes them into
`provider.pystino.models`. A model added to the gateway later needs no
re-enroll (which would re-ask the options and mint a new machine id):

```sh
galopin models refresh     # rewrites only provider.pystino.models
```

It signs in with the stored refresh credential, prints the ids added and
removed, and leaves every other key of the file alone. If discovery fails or
lists no chat model it changes nothing and exits non-zero. A running `run`
keeps the list it started with, so restart it. `run` also refreshes at start,
best-effort and bounded to 10 seconds (one warning line on failure, the old
list kept); `run --no-refresh-models` skips that. A machine enrolled with
`--no-discover` gets its placeholder replaced the same way.

Re-enrolling (`enroll` again, e.g. after a revocation) reuses the issuer,
gateway, Cerea origin, client id, billing group, shim port and opencode.json
path recorded in the existing `credentials.json`, so only the login is asked;
a flag you pass wins, and the group is asked only if the recorded one is no
longer billable.

### Auth

`credentials.json` is the machine's sign-in: an OIDC refresh credential that
the shim exchanges for short-lived access tokens, so opencode never sees one.
Three things go wrong with it, and `galopin auth` fixes two of them without
re-enrolling (which mints a new machine id and re-asks every option):

```sh
galopin auth status            # issuer, user, billing mode, token expiry,
                               # the shim's last verdict, revoked or not
galopin auth login             # sign in again, alias: galopin auth refresh
galopin auth group             # show the billing mode; list the billable groups
galopin auth group NAME        # bill this machine to NAME instead
galopin auth group --default   # follow your console default instead of pinning
```

- **The refresh credential was refused** (`invalid_grant` — expired, or
  revoked server-side): `galopin auth login` signs in again with the issuer,
  client id and flow the credential file already records, and rewrites only
  the token fields of that file. The machine id, billing group, gateway,
  shim port and opencode.json path stay exactly as they are, so the /code
  panel never shows the machine as a new Pending device. A machine that was
  **revoked** in the panel is refused by design — its machine id is dead at
  the other end, and only `galopin enroll` (a new machine id) brings it
  back. A running `galopin run` picks the new tokens up at its next request
  or refresh: no restart.
- **The billing group changed** (you moved teams, or want the other
  project's models): `galopin auth group NAME` re-bills this machine after
  checking NAME against the live list, then re-discovers the models, since
  the visible models depend on the group. A running `run` bills to the new
  group from its next request on; restart it for the new model list.
- **Pinned versus following your default.** By default a machine pins the
  group it was enrolled with (`group` in `credentials.json`, sent as
  `x-bill-to` on every request). With `--default-group` at enroll, or
  `galopin auth group --default` later, it instead sends **no** group and
  the gateway bills each request to your **default billing group** — the one
  set in the Pystino console's group picker. One console setting then moves
  billing and model visibility for the chat and for every machine following
  it at once; `galopin auth group NAME` pins again. Enrolling or switching
  to follow-default refuses when you have no default set in the console,
  because the gateway would refuse every request.

`galopin auth status` is read-only and answers "why are requests 401-ing"
without touching anything: it names the issuer, the user, the billing mode
(pinned group or following your default), when the access token expires,
whether the refresh credential is present, whether the shim last saw the
credential permanently refused (its `status.json` verdict), and whether the
machine is revoked.

To keep `run` up, install it as a systemd user unit (Linux) or a
LaunchAgent (macOS). The files are `packaging/galopin.service` and
`packaging/org.cerea.galopin.plist`, and each says how to install it in its
header comment:

```sh
install -D -m 0644 packaging/galopin.service ~/.config/systemd/user/galopin.service
systemctl --user daemon-reload && systemctl --user enable --now galopin
loginctl enable-linger "$USER"     # keep it up while logged out
```

The unit runs `~/.local/bin/galopin run` and does not restart after exit
code 78 (the machine was revoked). After installing a new binary,
`systemctl --user restart galopin`. Full flag reference, the same steps in
more detail, revocation and re-enrollment: `docs/agent-machines-reference.md` at the
Cerea repository root.

## Machine powers: files and a terminal (PROTOCOL.md §9)

Two more things `/code` can do on an enrolled machine, each behind its own
veto that only `enroll` can loosen:

- **Files**, read-only, confined to each workspace: on by default
  (`enroll --no-files` turns it off), with a secret deny list (`.env`,
  private keys, credentials files — `--file-deny GLOB` extends it,
  `--no-default-file-deny` drops the defaults).
- **What the agent may do without asking** has two parts: a per-session
  selector in the /code composer, and a fixed floor. The machine has no limits of its own (ADR 0109).
  The selector is **Plan, Ask, Allow or Auto** (on the wire `deny`, `ask`,
  `allow`, and `ask` with an `autoClasses` map for Auto). Every session starts on **Ask**, including on a machine enrolled
  before the selector existed: the agent asks before it edits, runs a command,
  fetches a page or starts a subagent; reading the project always runs. Under
  Plan every call that would change something is refused with a message
  naming the word and the way out. "Always allow" on a card is an exception
  for that command in that session only, removable in the panel. Any other
  change applies from the session's next turn. A new subagent follows its
  root's word from its first turn (galopin answers its first asks `once` when
  the word and exceptions allow, audited `by: "galopin"`). A session whose
  stored rules still carry an earlier Plan is flagged `staleDeny` /
  `stalePolicy` and the panel says to start a new session.
  **No limits, a fixed floor.** The session's word decides: Plan refuses
  everything that would change something, Ask raises a card, Allow runs
  everything, and Auto runs the classes of action the user chose to run (Cerea
  sends the per-class map `autoClasses {class: "run"|"ask"}` with the word,
  see [PROTOCOL.md](PROTOCOL.md) §6) and raises a card for the others, which
  Cerea routes to the reviewer or to the user. The classes are labels for that
  routing and for audit: `edit`, `command`, `web`, `outside`, `secrets`,
  `agents`, `tools`, `loop`. The floor is in code and not configurable:
  galopin's **own state and configuration** (the state directory,
  `policy.json`, the credentials, the opencode config it owns) are refused
  always; a write into `.git` or a CI configuration file, a `.env` file or a
  credential store, and a repeating agent are a card even on Allow and Auto;
  read-only commands always run. `policy.json` limits and the flags `--limit`,
  `--permission-max` and `--permission-rule` are **retired**: for one more
  release they are accepted and ignored with a warning, and `policy show` says
  so.
  **Local deny (advanced).** An owner who does not fully trust the Cerea server
  can refuse a class here whatever any session says: `galopin enroll ... --deny
CLASS` (repeatable; `edit`, `command`, `web`, `outside`, `secrets`, `agents`,
  `tools`), `galopin policy set --deny CLASS` and `--no-deny CLASS`. It only
  refuses, is stored locally, is never settable over the link and is shown by
  `galopin policy show`.
  The machine's **safe external directories** (`enroll --safe-dir PATH`
  repeatable, replacing the default; `--no-safe-dirs` for none) are not
  "outside": `/tmp`, the temp dir and the toolchain caches
  (`~/.cache/{go-build,pip,uv,pnpm,node-gyp}`, `~/go/pkg/mod`, `~/.npm`,
  `~/.local/share/pnpm`; never the whole `~/.cache`) — those that exist —
  never raise a card, under every word. A safe directory is one the agent may
  write into, so the list stays short, and `galopin policy set --no-safe-dir
PATH` may only remove from it.
  **Re-enrolling keeps every setting the machine has except the options you
  pass.** `galopin reset` returns the whole policy to the defaults (it asks to
  confirm, `--yes` skips that) and keeps the credentials and the pairing.
  `--allow-auto-accept` still does nothing.

- **Agent tools** (on by default; `--no-agent-tools`): `session_list`,
  `session_read`, `session_send` and `session_spawn`, so a session's model can
  find, **read** (the other session's user and assistant text only, never its
  tool output, truncated at 4 KB a message and 32 KB an answer), message and
  start other sessions on this machine. What happens is the **agents** class (above): a call from a session on Allow (or on Auto when its map runs `agents`) to a session whose word is the same or more cautious needs no card, a call from a session on Ask still asks unless the session was **granted** it (`session.grantCoordination {sessionId, keys}`, only those four keys; `[]` clears); with `--deny agents` none works. A spawned session
  inherits its spawner's exceptions and grant, and its word only as Allow (an
  Allow spawner starts an Allow child, any other starts on Ask), never more;
  Cerea's scheduled runs orchestrate other sessions
  with nobody to answer a card this way. A grant persists with the session, and is never
  more than a local deny, another workspace, the hop limit or the rate limits
  allow. An older galopin has no such op and answers `unsupported`; Cerea runs
  the schedule without it and says so. Every read, send, spawn and grant is a
  row in `audit.log`, never the text. See [PROTOCOL.md](PROTOCOL.md) §6.
- **Schedule tools** (installed with the agent tools): `schedule_list`,
  `schedule_create`, `schedule_update` and `schedule_delete` let a session's
  model manage its owner's scheduled actions on this machine, through Cerea
  (a machine call over the link; a Cerea too old for it is named in the
  refusal). Creating one follows the session's Deny / Ask / Allow — the
  blanket Allow covers it — except from a scheduled run, which always asks;
  a run pausing or deleting its own schedule needs no card, even on Deny; any other change
  or delete always asks. A local `--deny agents` refuses
  all of it. Audited by schedule
  id or name, never the prompt. See [PROTOCOL.md](PROTOCOL.md) §5 "Machine
  calls" and §6 "Schedule tools".
- **The delegation skill** (written with the agent tools, never without
  them): `skills/delegation/SKILL.md` in the opencode config directory galopin
  owns (`internal/backend/opencode/skill.go`). It tells the model when to use
  `task`, the session tools and the schedule tools, what to do when its prompt
  starts with Cerea's `[Scheduled run …]` header, and how to schedule work.
  It must describe only what the tools do today: change it with them.
  If a `task` subagent reports its tools refused on its first turn (an
  earlier Deny stuck in the session's history — the panel says so on the
  session), it resumes it once with the same `task_id`: later turns run
  under the session's current rules.
- **Models pinned outside the gateway.** opencode merges its own global
  config into every session, so an agent file or config key there pinning a
  non-Pystino model bypasses the gateway — and breaks background results,
  which carry no model. At every start galopin scans those sources and
  reports any pin (a log warning naming file and key, an audit
  `global_config.model_pin` row, `status.json` and hello warnings for the
  device card); it never edits them. With `--allow-free-models` the
  generated config allows the `pystino` and `opencode` providers, nothing
  else; see [PROTOCOL.md](PROTOCOL.md) §6.
- **A terminal**: a real, interactive shell, **on by default** (as are
  slash commands that run shell and background subagents; `enroll
--no-terminal`, `--no-command-shell` and `--no-background-subagents`
  turn each off). A terminal means exactly what it says:
  _anyone who controls your Cerea session can run commands as you on this
  machine._ There is no model and no permission rule in the way once a
  terminal is open, so treat it like handing out shell access, because
  that's what it is. `--max-terminals N` caps how many can be open at once
  (default 8). Enrolling with terminals on always prints a warning: the
  shell is outside every permission rule.

`galopin policy show` prints the current policy in plain words: that the machine
has no limits of its own, the local deny, the safe directories, and any note a
retired field owes (limits in `policy.json` that are ignored).
`galopin policy set` can locally **tighten** it without a full re-enroll —
turn files, file writes or the terminal off, lower `--max-terminals`, add a
local `--deny CLASS` (and `--no-deny CLASS` to lift one), remove a safe
directory with `--no-safe-dir PATH`, or add a `--file-deny` entry — but never
loosen the rest back; loosening always requires `enroll` again, since the
policy is never writable over the link (§4). The **file editor is on by default**
(`enroll --no-file-write` turns it off; `--allow-file-write` is accepted and
restates the default).

## State directory

Credentials and every other file galopin writes on its own behalf —
`credentials.json` (carries the shim secret), `machine-id`, `policy.json`,
`revoked`, `opencode-overlay.json`, `workspaces.json`, `status.json` and
`audit.log` (terminal opens/closes and policy refusals — never keystrokes,
output, or file content: the local record Cerea itself cannot rewrite) —
live in `<config-dir>/galopin/` (`~/.config/galopin` on Linux,
`~/Library/Application Support/galopin` on macOS). So is the `opencode.json`
enroll writes by default (`opencode_config` in `credentials.json` records
where it went); opencode's own config, `~/.config/opencode/opencode.json`, is
left alone.

opencode's TMPDIR while galopin supervises it is a directory of its own,
emptied on every (re)start: opencode is a Bun binary that extracts its
native libraries (~5 MB) into TMPDIR on each start and never removes them,
which on a machine whose `/tmp` is tmpfs slowly fills RAM. It is
`$XDG_RUNTIME_DIR/galopin/opencode-tmp` when that exists, else
`galopin/opencode-tmp` in the user cache directory (`~/.cache` on Linux,
`~/Library/Caches` on macOS), and never the config directory: every shell
the agent starts inherits TMPDIR, so temporary files a command makes would
otherwise land beside the credentials. An older galopin kept it there as
`opencode-tmp/`; the first start after upgrading deletes it.

A machine enrolled before this move kept those files beside opencode's own
config, each name prefixed `pystino-` to avoid colliding with opencode's
files in that shared directory. The first `run`, `enroll` or `serve` after
upgrading migrates them into `<config-dir>/galopin/` automatically (atomic
rename, mode preserved, one line logged naming what moved) — nothing to do
by hand. An explicit `--creds`/`--state-dir` opts out of the migration, and
if both directories already have credentials the new one wins outright with
nothing overwritten.

## What stays the same

The wire protocol (`PROTOCOL.md`), the `pystino-machine.v1` WebSocket
subprotocol, the `/api/v2/code/machine` path, the `X-Pystino-Machine-*`
headers and the `opencode-enrollment` OIDC client id are all unchanged by
this move — live machines depend on them, and none of it is specific to the
old name.
