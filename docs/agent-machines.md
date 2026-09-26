# Agent machines: galopin, setting one up, and driving it

The Agents panel in the sidebar drives coding agents that run **on your own
machine**, not here. Your code never leaves it; the chat is a remote control.
`galopin` is the one binary that makes that possible: it lives in this
repository as `agent/`, and this page covers using it: getting the binary,
pairing a machine, and what the panel does once it is paired.

If you are deploying the feature rather than using it, read
[The `/code` panel](code-panel.md) first — none of this works until
`CODE_AGENTS_ENABLED=true`.

## The shape of it

```
your laptop                          the deployment
┌───────────────────────┐            ┌───────────────────────────┐
│ opencode               │──── /v1 ─▶│ the gateway (bills you)    │
│   ▲                    │           │                            │
│   │ shim               │           │ Cerea (the machine link)   │
│ galopin ───────────────┼─ outbound ┼──── WSS ───────────────────▶
└───────────────────────┘            └───────────────────────────┘
```

One binary, one credential. `galopin` supervises `opencode serve`, dials
**out** to this deployment over WSS and authenticates with the same OIDC
access token its enrollment minted — the identical credential that
authenticates its `/v1` calls to the gateway. There is no relay and no second
process to run: revoking your account at the identity provider
kills both the control link and the LLM link within one access-token
lifetime. The wire protocol both ends speak is `agent/PROTOCOL.md`; the
gateway facts galopin's enrollment relies on (the IdP client
`opencode-enrollment`, its refresh-token lifetimes, `x-bill-to`) belong to
the Pystino gateway and are documented there.

## One binary, two jobs

| Job         | What it carries                                                                                                 | Command                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **LLM**     | opencode → the local refreshing shim → gateway `/v1`, billed to the signed-in person                            | `galopin enroll`, then the shim starts with `run` (or alone with `serve`) |
| **control** | the machine dials _out_ to the chat over WSS (`/api/v2/code/machine`), so the chat's `/code` panel can drive it | `galopin run`                                                             |

Nothing else needs pairing: the machine connects outbound with
its own enrollment token, and a person confirms it in the `/code` panel
(`agent/PROTOCOL.md` §4).

## Getting the binary

**From your deployment (the usual way).** Every Cerea image builds the four
binaries from `agent/` and serves them itself, with no sign-in needed, so
nothing has to be published anywhere. On the machine:

```sh
curl -fsSL https://cerea.example.org/chat/galopin/install.sh | sh
```

(Use your deployment's origin and base path; the `/code` pairing dialog
shows the exact line.) The script picks the binary for this OS and CPU
(Linux or macOS, amd64 or arm64), downloads it and `SHA256SUMS` from the same
origin, **refuses to install on a checksum mismatch**, installs to
`~/.local/bin/galopin` (`GALOPIN_INSTALL_DIR` overrides), clears macOS's
quarantine flag, and prints the `galopin enroll` command for this
deployment. It needs `curl` or `wget`, and `sha256sum` or `shasum`.

The same files are there to fetch by hand (the pairing dialog's "Download
manually" lists them): `<base>/galopin/galopin-<os>-<arch>`,
`<base>/galopin/SHA256SUMS` and `<base>/galopin/version`. Nothing else under
that path is served. The binaries are revalidated on every use (ETag), so a
cache in between never pairs an old binary with a new checksum file.

**Building it yourself** needs Go 1.24+ and nothing else:

```bash
agent/packaging/build-dist.sh ~/galopin-dist
```

It writes static binaries (CGO off, so each one runs on any machine of its
OS/architecture), plus a manifest:

| File                                                                    | What                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `galopin-linux-amd64`, `-linux-arm64`, `-darwin-amd64`, `-darwin-arm64` | the binary                                                                  |
| `REVISION`                                                              | the Cerea commit it was built from (`-dirty` if `agent/` had local changes) |
| `SHA256SUMS`                                                            | for `sha256sum -c SHA256SUMS` (macOS: `shasum -a 256 -c SHA256SUMS`)        |
| `galopin.service`, `org.cerea.galopin.plist`                            | the user-service files below, from `agent/packaging/`                       |

Use this for a machine that cannot reach the deployment, or to build from
a checkout you changed; anyone with Go can also run `go build -o galopin .`
in `agent/`.

## Installing on a machine (Linux or macOS)

**Prerequisite:** `opencode` on the PATH, either `npm i -g opencode-ai` or
`curl -fsSL https://opencode.ai/install | bash`. `galopin run` supervises
`opencode serve`, and it is the only runtime dependency.

With the installer above, skip to `enroll`. From a build of your own:

```sh
install -d ~/.local/bin
install -m 0755 galopin-darwin-arm64 ~/.local/bin/galopin   # the file for this OS/arch
xattr -d com.apple.quarantine ~/.local/bin/galopin 2>/dev/null || true   # macOS only

~/.local/bin/galopin enroll \
  --issuer https://cerea.example.org/authelia \
  --gateway https://cerea.example.org \
  --cerea https://cerea.example.org/chat \
  --output ~/.config/opencode/opencode.json
~/.local/bin/galopin run
```

`enroll` signs the person in, picks their billing group (it asks when there
are several), and writes two files: the opencode config at `--output`, and a
refresh credential (mode 0600, default `<config-dir>/galopin/credentials.json`,
where `<config-dir>` is `~/.config` on Linux and `~/Library/Application
Support` on macOS). `run` then supervises opencode and dials out to the
chat. Open the sidebar's **Agents** panel, and the machine is listed as
pending until someone confirms it (**Confirm this machine**).

| Flag                                           | When                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--cerea …/chat`                               | always include `/chat` when the chat is served there. The machine dials `<cerea>/api/v2/code/machine`, and without the base path it reaches the gateway instead                                                                                                                                                             |
| `--output PATH`                                | the file is **replaced whole**. `enroll` asks before replacing an existing one, and `--yes` skips the question. If you keep your own opencode config, point `--output` somewhere else and pass `run --opencode-config PATH`                                                                                                 |
| `--allow-free-models`                          | also offer models from providers other than the gateway's. By default only `pystino/*` models are listed, so spend always lands in the account the machine enrolled under                                                                                                                                                   |
| `--device`                                     | force the device flow, which prints a URL and a code to open on any other device (the bundled Authelia's `opencode-enrollment` client allows it). Without a flag, `enroll` picks the loopback sign-in in the local browser when there is a display, and the device flow when there is none. `--loopback` forces the browser |
| `--allow-auto-accept`, `--workspace-root PATH` | the machine's own vetoes, fixed at enrol time (`agent/PROTOCOL.md` §4)                                                                                                                                                                                                                                                      |

If `enroll` warns that model discovery failed, the gateway offered no model
yet (no provider configured, or none granted to the person's group). It then
writes a placeholder models map. Enrol again once a model is available.

### Why a shim at all

An OIDC access token expires in minutes; opencode holds a **static**
`apiKey` in its config and has no notion of renewal. So the token never
reaches opencode. `enroll` stores the _refresh_ credential, `serve` (which
`run` also starts) holds it, and the written `opencode.json` points its
`baseURL` at `http://127.0.0.1:<port>/v1` — the shim. Every request gets a
fresh bearer and the recorded `x-bill-to` injected on the way past.

The default shim port is **41871**, bumped upward while occupied and then
recorded in the config, so `enroll`'s own loopback callback listener and the
shim never collide.

### When the refresh token dies

A gateway or IdP redeploy can revoke the refresh token the shim holds. That
is expected and recoverable — re-enroll the machine — but the failure has to
be fast and legible, not a 502 that opencode's client quietly retries into a
long hang:

- **A 401, not a 502, once the refusal is permanent.** The token endpoint's
  `invalid_grant` (RFC 6749 §5.2) answers `401` with an OpenAI-shaped body
  (`{"error":{"message","type","code":"enrollment_expired"}}`), which
  opencode's client never retries — a 401 stops it cold and surfaces the
  message verbatim. A transient refusal still answers the old `502`, which
  opencode does retry.
- **Refreshed proactively, not just on request.** The shim refreshes once at
  startup and then every 15 minutes, well inside the access-token lifespan,
  so its state is already known before opencode ever sends a request.
- **A status file and a health endpoint, kept in sync.** Every state change
  (`ok` / `expired` / `unreachable`) is written atomically to
  `<state-dir>/status.json` as `{"state","checkedAt","message"}`, and the
  same JSON is served at `GET http://127.0.0.1:<port>/galopin/health`.

### The device flow prints the code-bearing URL

Both bundled IdPs issue `verification_uri_complete`, which carries the user
code as a query parameter — what `enroll` prints as `open:`, so one paste
does what open-plus-type would; the bare code is still printed on its own
line, because a wrapped URL pastes broken and a typed code does not. An IdP
that omits the complete URI falls back to `verification_uri`.

### What `enroll` writes into `opencode.json`

```json
{
	"$schema": "https://opencode.ai/config.json",
	"enabled_providers": ["pystino"],
	"provider": {
		"pystino": {
			"npm": "@ai-sdk/openai-compatible",
			"name": "Pystino",
			"options": { "baseURL": "http://127.0.0.1:41871/v1" },
			"models": {
				"my-model": {
					"name": "My Model",
					"limit": { "context": 131072, "output": 16384 }
				}
			}
		}
	}
}
```

Three things in there are load-bearing:

- **No `apiKey`.** opencode would send it verbatim and it would expire. The
  shim owns the credential instead (its own per-install secret goes in
  `apiKey`, never the gateway bearer).
- **`enabled_providers: ["pystino"]`.** opencode's own allowlist — without it
  a built-in provider with ambient credentials (an `ANTHROPIC_API_KEY` in the
  environment, a logged-in Copilot) offers models that bypass the gateway
  entirely, and that spend never lands in the account the enrollment exists
  to bill. `--allow-opencode-provider` omits the key for operators who want
  both.
- **`limit.context` and `limit.output` on every model.** Both keys are
  _required_ by opencode's schema for custom-provider models: omit either
  and opencode refuses the whole file. Where the gateway publishes no hint
  the CLI writes defaults (131072 context, 16384 output) rather than
  omitting the key.

Only chat-kind models make the list. An embedding tier in a coding agent's
model picker is one accidental keypress from a 400.

## Setting up a machine

Install galopin from your deployment, then enroll and run it. `<origin>` is
your deployment's origin, for example `https://cerea.example.org`:

```sh
curl -fsSL <origin>/chat/galopin/install.sh | sh

galopin enroll --issuer <origin>/authelia --gateway <origin> --cerea <origin>/chat \
  [--allow-terminal] [--allow-auto-accept] [--workspace-root PATH] …
galopin run
```

(`--issuer` is your identity provider's issuer; `<origin>/authelia` is the
bundled Authelia's.) Then confirm the machine in the `/code` panel.

**The machine's vetoes.** These flags are fixed at enroll time and stored in
the machine's own `policy.json`. The chat can never loosen them over the
link: whatever the panel sends, the machine refuses what its policy denies.

| Flag                        | Default              | What it allows                                                                                                |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--allow-terminal`          | denied               | the `/code` panel may open a real shell on this machine (see below)                                           |
| `--max-terminals N`         | 8                    | how many terminals may be open at once                                                                        |
| `--allow-auto-accept`       | denied               | a session may run the model's commands without asking each time                                               |
| `--workspace-root PATH`     | unrestricted         | workspaces only under this path (repeatable)                                                                  |
| `--allow-free-models`       | denied               | models from providers other than the gateway's; by default only the gateway's, so spend lands in your account |
| `--allow-opencode-provider` | denied               | opencode's built-in providers stay enabled next to the gateway's                                              |
| `--no-files`                | read-only browsing   | no file explorer at all                                                                                       |
| `--file-deny GLOB`          | built-in secret list | redact more files from the explorer (repeatable)                                                              |
| `--no-default-file-deny`    | built-in list on     | drop the built-in secret list, keeping only `--file-deny`'s                                                   |

Other enroll flags: `--device` or `--loopback` to force a sign-in flow,
`--group NAME` to preselect the billing group, `--output PATH` for the
opencode config, and `--yes` to overwrite without asking.

`run` drives opencode by default (it supervises `opencode serve`). `run
--backend acp --acp-command "<agent>"` drives any ACP agent instead:
`opencode acp`, Gemini CLI, Claude Code or Codex through their ACP adapters,
Pi through `pi-acp`. An ACP backend reports fewer capabilities (no usage,
compaction or subagents), and the chat panel hides those controls. The
Changes pane works for either backend, because the agent reads it from git.

Each enrollment mints a new machine id (`machine-id`, in the machine's state
directory). The chat therefore sees a re-enrolled machine as a new pending
device to confirm. A machine revoked in the panel is refused for good under
its old id, and `run` reports that and exits with code 78 instead of
reconnecting.

### What the file explorer may see

`run` lets the `/code` explorer browse each workspace, **read-only**, confined
to the workspace directory (symlinks that leave it are listed, never
followed), with secrets redacted: `.env` files (not `.env.example`), private
keys, `.netrc`/`.npmrc`/`.pypirc`, cloud credentials files, `*.tfstate` and
the like. Redaction keeps secrets off screens and out of logs; it is not a
boundary against the agent, which can read any file. Enroll flags:

- `--no-files`: no browsing at all;
- `--file-deny GLOB` (repeatable): redact more, by name (`*.secret`) or path
  tail (`config/prod.yml`);
- `--no-default-file-deny`: drop the built-in list, keeping only yours.

### The terminal (off by default)

`/code` can also open a real, interactive shell on the machine, but only
when both sides say so. The machine must be enrolled with `--allow-terminal`
(without it, every terminal request is refused), and the deployment must set
`CODE_TERMINAL_ENABLED=true` (off by default). Opening a terminal also needs a
sign-in to Cerea within the last 12 hours. Turning it on means exactly this: **anyone who
controls your Cerea session can run commands as you on this machine.**
There is no model and no permission rule standing in the way once a
terminal is open — it is strictly more power than auto-accept, which only
ever governs the _model's_ unattended commands. `enroll` prints a warning
(not a refusal) if you pass `--allow-terminal` without
`--allow-auto-accept`, since that combination denies the model unattended
commands while still handing a person a shell.

- `--allow-terminal`: turn the terminal on (default: denied);
- `--max-terminals N`: cap how many can be open at once (default 8).

A terminal's shell starts in the workspace's own directory and never sees
galopin's own secrets (the opencode server password, the shim secret, or
anything shaped like a token or credential) — but once it's running, it is
an ordinary shell: it is not sandboxed to the workspace the way file
browsing is.

Once a terminal is allowed, you can locally **tighten** its policy again
without a full re-enroll:

```sh
galopin policy show                       # what this machine currently allows
galopin policy set --no-terminal          # turn it back off
galopin policy set --max-terminals 2      # lower the cap
```

`policy set` can only tighten — turn files or the terminal off, lower the
cap, or add a `--file-deny` entry. Loosening anything back requires
`enroll` again: the policy is never writable over the link.

### The permission posture

opencode's permission rules live in the machine's own config. `enroll`
writes `--output` whole (it asks before replacing an existing file; `--yes`
does not ask), so point it at a dedicated path, or re-add your own rules
afterwards. The chat panel's approval card is the gate because the machine
asks.

## Keeping it running

**Linux**, as a systemd user unit:

```sh
install -D -m 0644 galopin.service ~/.config/systemd/user/galopin.service
systemctl --user daemon-reload && systemctl --user enable --now galopin
loginctl enable-linger "$USER"        # keep it up while you are logged out
journalctl --user -u galopin -f
```

**macOS**, as a LaunchAgent:

```sh
sed "s/USER/$USER/g" org.cerea.galopin.plist > ~/Library/LaunchAgents/org.cerea.galopin.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.cerea.galopin.plist
tail -f ~/Library/Logs/galopin.log
```

Both run `~/.local/bin/galopin run` with a PATH that includes the usual
places opencode installs to. Edit that PATH if yours is elsewhere.

To keep it back up after a revoke, re-enroll (or delete `machine-id`) and
start `run` again. The systemd unit does not restart it after that exit
(`RestartPreventExitStatus=78`, kept from the pre-rename unit); launchd
cannot filter on exit code, so it restarts once, finds the machine id marked
revoked, and exits 0 to end the loop — `launchctl kickstart` the job after
re-enrolling.

## The state directory

Credentials and everything else galopin writes on its own behalf —
`credentials.json` (carries the shim secret), `machine-id`, `policy.json`,
`revoked`, `opencode-overlay.json`, `workspaces.json`, `status.json` and
`audit.log` — live in `<config-dir>/galopin/`. opencode's own config keeps
its own default, `~/.config/opencode/opencode.json`, unaffected.

`audit.log` is the local record of terminal opens/closes and policy
refusals — rotated JSON lines, never a byte of keystrokes, output, or file
content. It is the one record of a machine's `/code` activity that Cerea
itself cannot rewrite.

`opencode-tmp/` there is opencode's TMPDIR while galopin supervises it,
emptied on every (re)start: opencode is a Bun binary that extracts its
native libraries (~5 MB) into TMPDIR on each start and never removes them,
which on a machine whose `/tmp` is tmpfs slowly fills RAM.

## Removing a machine

1. Revoke it in the `/code` panel. The chat tombstones the pairing and
   closes the link, the agent logs `machine revoked, not reconnecting`, and
   a later connection under the same machine id is refused. The agent then
   revokes its own refresh token at the IdP (RFC 7009, the discovery
   document's `revocation_endpoint`) and clears the tokens from its
   credential file, so the revoked machine can no longer reach the gateway
   either. If the IdP can't be reached, it says so in the log; the tokens are
   cleared anyway, and the refresh token lapses at its own expiry.
2. Stop the service: `systemctl --user disable --now galopin`, or
   `launchctl bootout gui/$(id -u)/org.cerea.galopin`.
3. Delete `<config-dir>/galopin/`. Re-enrolling later mints a new machine
   id, which is paired afresh.

## Pairing a machine (in the panel)

On the machine, with `opencode` on the PATH and `galopin` installed:

```bash
galopin enroll --issuer https://cerea.example.org/authelia \
  --gateway https://cerea.example.org --cerea https://cerea.example.org/chat
galopin run
```

`--cerea` is the chat's address **including its base path** (`/chat` behind
the Pystino stack): the machine dials `<cerea>/api/v2/code/machine`. The
pairing dialog prints it that way; `enroll` asks for the issuer and the
gateway when they are not given. `enroll` signs the machine into your
account through this deployment's identity provider (the same login the
chat uses) and writes a local credential; `run` starts the agent, which
dials out here and appears in the sidebar's **Agents** panel, in
**Pending**, as soon as it checks in.

**Log into the chat at least once before pairing**: pairing identifies you by
the same account, and a bearer for somebody the chat has never seen is
refused before the connection even completes.

Nothing is forwarded to a pending machine. In the Agents panel, click
**Confirm** next to it — that click is the human approval a stolen or
phished token alone can never produce, since it has to happen in your own
signed-in browser. **Reject** works the same way on a machine you did not
expect to see.

## The panel

**Chats | Agents** switches the sidebar between the two. The Agents side is a
tree: paired machines, each with its workspaces, each with its sessions.
Everything that _changes_ something lives here — pairing, revoking, adding a
workspace, starting or archiving a session, renaming. The main pane only ever
shows what the address names (`/code?device=&ws=&agent=`).

A machine that is not currently connected renders as **offline** — the tree
never tries to load its workspaces, so one offline machine never freezes the
rest of the list.

### Workspaces

A workspace is a directory on the paired machine. Add one by typing its
**absolute** path — a relative path would resolve against whatever working
directory the agent process was born with, which is unguessable from here, so
the server refuses it. The machine refuses a path outside its own configured
roots (its own veto, never overridable from the panel) or one it cannot see,
and either refusal arrives as a visible failure rather than a row that
pretends.

### Sessions

A session ("agent") belongs to one workspace on one machine. The backend list
comes from the machine's own `hello` rather than from anything hardcoded
here, so the panel cannot offer something the machine cannot actually run.

A session reads exactly like a conversation: the same transcript column, the
same message rendering, the same composer. That is deliberate — the panel is
the chat's own machinery pointed at a different source, which is why updates
arrive live without a refresh.

### The composer's pills

Inside the prompt box, in the chat's own pill idiom:

- **mode** — the backend's own modes (plan, build, …), listed live rather
  than from a hardcoded set that would drift from what it enforces.
- **model** — the models the session's backend offers.
- **auto-accept** — shown only when the backend supports it _and_ the
  machine's own policy allows it (`allowFreeModels`/`autoAccept` in its local
  `policy.json` — set once, on that machine, and never writable over the
  link). It is the session's live state, not a claim the panel makes.

Mode and model apply **to the session**, live, not to one send. Switching
either changes the licence the session runs under until it is switched again.

### Stopping a turn

While a turn is live, the send button's place carries the stop control, exactly
as a chat does. It stays there while a permission card is up, because stopping
a request you do not want to answer is most of the point of it.

### Permissions

When the agent wants to edit a file or run a command, it asks, and the ask
renders as the chat's approval card. Approving replies `once` (this call
only); denying replies `reject`. The machine's own policy decides whether
anything may be auto-accepted at all — the panel is never the last word on
that.

### Subagents

When the session spawns a subagent, the tool call that spawned it is replaced
in the transcript by a card for that subagent — title, status, from the
machine's own roster. Expanding one fetches its own transcript and renders it
as a nested read-only conversation.

### The diff pane

The **diff** control opens the shared side pane — the same frame artifacts open
in — with the session's file changes, rendered by the same diff machinery the
artifact panel uses. The before/after pairs come from the machine; nothing is
reconstructed here.

### Archiving and revoking

Archiving a session or a workspace confirms first, then asks the machine and
redraws that device's subtree from its answer — never an optimistic removal,
because the machine owns the listings. If the archived row was the one open
in the address, the panel navigates away from it.

Revoking a machine tombstones the pairing record: it is refused if it tries
to reconnect, and its live socket (if any) is closed immediately. Re-running
`galopin enroll` mints a **new** machine id — it re-pairs as a fresh
`pending` row, not a resurrection of the revoked one.

## What is kept where

|                                                             | Where it lives                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| your code, your working tree, the session's live transcript | your machine                                                    |
| the pairing record — name, machine id, policy, owner        | the chat's database                                             |
| prompts, replies, file contents                             | in flight only, over your machine's own outbound TLS connection |
| your LLM spend                                              | the gateway's ledger, against your account and billing group    |

Pairing records are scoped to you: nobody else's panel can see or revoke your
machines.
