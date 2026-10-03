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
all four targets people run this on (`linux/amd64`, `linux/arm64`,
`darwin/amd64`, `darwin/arm64`) as static binaries (`CGO_ENABLED=0`), and
writes `REVISION` (the Cerea commit built from), `SHA256SUMS`, and copies in
`packaging/galopin.service` and `packaging/org.cerea.galopin.plist`.

## Running

```
galopin enroll   sign in, pick a billing group, write opencode.json,
                 store the refresh credential
galopin serve    the local refreshing proxy shim alone (opencode with no /code panel)
galopin run      serve, plus supervise opencode (or an ACP agent) and dial out to Cerea
galopin policy   show, or locally tighten, this machine's policy.json
```

```sh
galopin enroll --issuer https://llm.example.org/authelia \
  --gateway https://llm.example.org --cerea https://llm.example.org/chat \
  --output ~/.config/opencode/opencode.json
galopin run
```

Full flag reference, keeping it running as a systemd user unit or a
macOS LaunchAgent, revocation and re-enrollment: `docs/agent-machines.md` at
the Cerea repository root.

## Machine powers: files and a terminal (PROTOCOL.md §9)

Two more things `/code` can do on an enrolled machine, each behind its own
veto that only `enroll` can loosen:

- **Files**, read-only, confined to each workspace: on by default
  (`enroll --no-files` turns it off), with a secret deny list (`.env`,
  private keys, credentials files — `--file-deny GLOB` extends it,
  `--no-default-file-deny` drops the defaults).
- **What the agent may do without asking** is a per-session selector in
  the /code composer — **Deny, Ask or Allow** — not a machine setting.
  Every session starts on **Ask**, including on a machine enrolled before
  the selector existed (no re-enroll needed): the agent asks before it
  edits, runs a command, fetches a page or starts a subagent. Reading stays
  allowed under all three words, and under Allow two asks survive: a write
  outside the project folder and the stuck-agent brake. "Always allow" on
  a card is an exception for that command in that session only, removable
  in the panel. A change applies **from the session's next turn**: the
  turn that is running is not stopped and finishes under the word it
  started with. A **new subagent's first turn always asks** for edits, commands
  and the like, even under Allow (opencode starts it before galopin can give it
  the session's word); exceptions do not reach it either. What **is** the machine's is the **ceiling**
  (`enroll --permission-max KEY=ACTION`, default `bash=ask` and
  `session_spawn=ask`): the most any key may ever be, whatever a session's
  word or exceptions say. The old auto-accept toggle and
  `--allow-auto-accept` are gone (the flag is accepted for one more
  release and does nothing).
- **A terminal**: a real, interactive shell, **off by default**.
  `enroll --allow-terminal` turns it on — and means exactly what it says:
  _anyone who controls your Cerea session can run commands as you on this
  machine._ There is no model and no permission rule in the way once a
  terminal is open, so treat it like handing out shell access, because
  that's what it is. `--max-terminals N` caps how many can be open at once
  (default 8). Enrolling with `--allow-terminal` always prints a warning:
  the shell is outside every permission rule.

`galopin policy show` prints the current policy in plain words.
`galopin policy set` can locally **tighten** it without a full re-enroll —
turn files or the terminal off, lower `--max-terminals`, a
`--permission-max` ceiling or a `--permission-rule`, or add a
`--file-deny` entry — but never loosen it back; loosening always requires
`enroll` again, since the policy is never writable over the link (§4).

## State directory

Credentials and every other file galopin writes on its own behalf —
`credentials.json` (carries the shim secret), `machine-id`, `policy.json`,
`revoked`, `opencode-overlay.json`, `workspaces.json`, `status.json` and
`audit.log` (terminal opens/closes and policy refusals — never keystrokes,
output, or file content: the local record Cerea itself cannot rewrite) —
live in `<config-dir>/galopin/` (`~/.config/galopin` on Linux,
`~/Library/Application Support/galopin` on macOS). opencode's own config
keeps its own default, `~/.config/opencode/opencode.json`, unaffected.

`opencode-tmp/` there is opencode's TMPDIR while galopin supervises it,
emptied on every (re)start: opencode is a Bun binary that extracts its
native libraries (~5 MB) into TMPDIR on each start and never removes them,
which on a machine whose `/tmp` is tmpfs slowly fills RAM.

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
