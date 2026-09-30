# Agent machines: galopin, setting one up, and driving it

!!! info "For people using the Agents panel"

    Pairing your own machine and driving it from the chat; **see also**
    [The `/code` panel](code-panel.md), the operator's side of the same feature.

The Agents panel in the sidebar drives coding agents that run **on your own
machine**, not here. Your code stays on it: the agent sends what it needs to the model through your gateway, and the chat shows you files and changes as you look at them but keeps no copy. `galopin` is the one binary that makes that possible: it lives in this repository as `agent/`, and this page covers using it: pairing a machine, and what the panel does once it is paired.

None of this works until the deployment has set `CODE_AGENTS_ENABLED=true`; if
you run the deployment, [The `/code` panel](code-panel.md) is the page for that.

## Pair a machine in three steps

1. **Sign in to the chat once.** Pairing identifies you by the same account, so
   the chat must have seen you at least once.
2. **Copy the line.** In the sidebar's **Agents** side, click **Pair** (or
   **Pair a device** when the list is empty). The **Pair a machine** dialog
   prints one line for this deployment, with the origin, the issuer and the
   gateway filled in. Tick what you want to allow first (see
   [The pairing dialog](#the-pairing-dialog)), then copy it.
3. **Paste it in a terminal on the machine.** Your browser opens to sign in; on
   a machine with no screen it prints a link and a code you can open on your
   phone. The machine then appears in the Agents panel as **Pending**: click the
   green check next to it (its tooltip reads **Confirm this machine**). Only you
   can confirm your machines, and nothing is forwarded to a machine until you
   do. The red cross (**Reject this machine**) refuses one you did not expect to
   see.

That is all. The rest of this page is what the dialog's options mean, how to
use the panel, how to keep the agent running and, marked as background at the
end, how it works.

## The pairing dialog's checkboxes and the machine policy

### The pairing dialog

The **Pair a machine** dialog prints the command for you, with three checkboxes that change what it prints (all off by default):

| Checkbox              | What it adds to the printed command                                                              | Check it when                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Install opencode**  | opencode's own installer line, `curl -fsSL https://opencode.ai/install \| bash`, before `enroll` | the machine is fresh and does not have opencode (the agent runs it as its coding engine); leave it off if it is installed                                          |
| **Allow auto-accept** | `--allow-auto-accept` on `enroll`                                                                | you want the panel's Auto-accept toggle to exist for this machine: the agent may answer its own tool-permission asks without you. Handoffs and questions still ask |
| **Allow terminal**    | `--allow-terminal` on `enroll`                                                                   | you accept that anyone who controls your Cerea session can run commands as you on this machine, with no model and no permission rule in the way                    |

The command is chained with `&&`, so a failed step never runs the next one: the
installer, then (if checked) opencode's installer, then `enroll`, then `run`.
It calls the binary by its installed path rather than a bare `galopin`,
because on a fresh machine `~/.local/bin` is not yet on the shell's `PATH`. The
dialog also lists the binaries and `SHA256SUMS` for a manual download, and the
machines waiting for confirmation.

The checkboxes only set flags on the printed line. Every other policy setting
is a flag you add yourself.

### The machine policy

These are the machine's own vetoes. They are fixed at enroll time, stored in
the machine's `policy.json`, and **the chat can never loosen them over the
link**: whatever the panel sends, the machine refuses what its policy denies.
`galopin policy show` prints what a machine currently allows. `galopin policy
set` can only **tighten**; loosening anything needs a new `enroll`.

| Policy                       | Enroll flag                                                | Default                              | What it decides                                                                                                                                                                                                                                                                                                           | Tighten later                                         |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Files**                    | `--no-files`, `--file-deny GLOB`, `--no-default-file-deny` | read-only browsing, secrets redacted | Whether the `/code` explorer may browse a workspace, and which files it redacts (see [What the file explorer may see](#what-the-file-explorer-may-see)). Off: no explorer at all                                                                                                                                          | `policy set --no-files`, `--file-deny GLOB`           |
| **Terminals**                | `--allow-terminal`, `--max-terminals N`                    | denied; at most 8 open at once       | Whether the panel may open a real shell on the machine. A veto pair: the deployment must also set `CODE_TERMINAL_ENABLED=true` (see [The terminal](#the-terminal-off-by-default))                                                                                                                                         | `policy set --no-terminal`, a lower `--max-terminals` |
| **Auto-accept**              | `--allow-auto-accept`                                      | denied                               | Whether a session may answer the model's tool-permission asks without a person. The machine-side gate behind the panel's Auto-accept toggle: while denied, the agent refuses the toggle and never auto-replies, whatever the panel sends. **Handoff approvals and questions are never auto-accepted**, even when it is on | re-enroll                                             |
| **Slash-command shell**      | `--allow-command-shell`                                    | denied                               | Whether a slash command's template may run its shell snippets. While denied, a command that expands shell, or whose shell behaviour is unknown (MCP prompts, ACP commands), is refused (see [Slash commands](#slash-commands))                                                                                            | `policy set --no-command-shell`                       |
| **Models from elsewhere**    | `--allow-free-models`                                      | denied: the gateway's models only    | Whether the model list may include providers other than the gateway's. By default only `pystino/*` models are listed and accepted, so spend always lands in the account the machine enrolled under. Cerea filters as well, and answers 403 to a disallowed model                                                          | re-enroll                                             |
| **opencode's own providers** | `--allow-opencode-provider`                                | denied                               | Whether opencode's built-in providers stay enabled next to the gateway's. Off, the written `opencode.json` carries `enabled_providers: ["pystino"]` (in that file, not in `policy.json`)                                                                                                                                  | re-enroll                                             |
| **Workspace roots**          | `--workspace-root PATH` (repeatable)                       | unrestricted                         | Workspaces may only be created under these paths; anything outside is refused                                                                                                                                                                                                                                             | re-enroll                                             |

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
directory). The chat therefore shows a re-enrolled machine as a new **Pending** machine, which you confirm again. A machine revoked in the panel is refused for good under
its old id, and `run` reports that and exits with code 78 instead of
reconnecting.

### What the file explorer may see

`run` lets the `/code` explorer browse each workspace, **read-only**, confined
to the workspace directory (symlinks that leave it are listed, never
followed), with secrets redacted: `.env` files (not `.env.example`), private
keys, `.netrc`/`.npmrc`/`.pypirc`, cloud credentials files, `*.tfstate` and
the like. Redaction keeps secrets off screens and out of logs; it is not a
boundary against the agent, which can read any file. The flags that turn it
off or extend the list are in [The machine policy](#the-machine-policy).

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

A terminal's shell starts in the workspace's own directory and never sees
galopin's own secrets (the opencode server password, the shim secret, or
anything shaped like a token or credential) — but once it's running, it is
an ordinary shell: it is not sandboxed to the workspace the way file
browsing is.

Once a terminal is allowed, you can locally **tighten** its policy again
without a full re-enroll (the flags are in [The machine policy](#the-machine-policy)):

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

## The panel

**Chats | Agents** switches the sidebar between the two. The Agents side is a
tree: paired machines, each with its workspaces, each with its sessions.
Everything that _changes_ something lives here — pairing, revoking, adding a
workspace, starting or archiving a session, renaming. The main pane shows whatever you have selected in the tree.

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

A session ("agent") belongs to one workspace on one machine. The backends offered are the ones this machine says it can run.

A session reads exactly like a conversation: the same transcript column, the
same message rendering, the same composer. That is deliberate — the panel is
the chat's own machinery pointed at a different source, which is why updates
arrive live without a refresh.

### The composer's pills

Inside the prompt box, in the chat's own pill idiom:

- **mode** — the backend's own modes (plan, build, …), listed live rather
  than from a hardcoded set that would drift from what it enforces.
- **model** — the models the session's backend offers.
- **auto-accept** — shown only if you enrolled this machine with **Allow auto-accept** (and the backend supports it). It is set once, on that machine, and the chat cannot change it.

Mode and model apply **to the whole session**, not only to the next message, and stay in force until you switch again.

### Slash commands

Type `/` at the start of the prompt box and a menu opens with the commands
this session can run. It is also the help: what it lists is exactly what
there is. The menu groups them under headings, in this order:

- **Panel** — commands this panel runs itself: `/compact`, `/undo`,
  `/redo`, `/model`, `/mode`, `/effort`, `/new`. Each is listed only when the
  agent's backend can do it. They drive the same routes the pills and the
  transcript use; nothing new runs on the machine.
- **Project** (badge "from this repo") — commands defined in the open
  workspace's repository (`.opencode/command/*.md`). Running one is running
  repository code on your machine; the first run asks (see below).
- **Machine** — commands from your user-level or the machine's config.
- **Skills** and **MCP** — when the agent exposes them.

A command whose template expands shell carries a **shell icon** in the menu.
A machine command whose name a panel command already uses is **shadowed**: it
stays in the list, greyed with the reason, and cannot be selected, because the
panel's own command wins.

Type to filter (prefix first, then substring), ↑/↓ to choose, Enter or Tab
to accept. A command that takes arguments shows its placeholder as ghost
text (`/review ‹$ARGUMENTS›`); type the arguments after the name and Enter
sends. A message that begins with a path, such as `/etc/hosts is wrong`, is not a command unless its first word names one, and sends as ordinary text.

**The machine can refuse a command, and says why.** The message names the flag or the file; nothing runs halfway:

| What you see                                                        | Cause                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Needs a setting this machine was not enrolled with" (403)          | the template expands shell (or its shell behaviour is unknown, such as an MCP prompt) and the machine was not enrolled with `--allow-command-shell`; a command pinned to a non-gateway model without `--allow-free-models`; or a file the command reads through `@path` matches the machine's file deny list |
| "This command changed since you approved it; review it again" (409) | the command's template changed since you reviewed it: the confirmation is asked again                                                                                                                                                                                                                        |
| "no longer listed"                                                  | the machine's list is re-read at run time, so a command that was deleted after the menu opened is refused                                                                                                                                                                                                    |
| "The agent is mid-turn. Stop it, or wait for it to finish."         | commands are refused while a turn is running (the send button is hidden then, too)                                                                                                                                                                                                                           |

**The first run of a project command** (or any command that expands shell)
opens a confirmation sheet showing the exact shell snippets it would run and
the files it reads. The template itself never crosses to the chat: the
snippets and a hash of the template are what you confirm against. Accepting
is remembered in this browser, for this machine and this exact version of the command. On another browser, your phone included, you will be asked again. If the definition changes afterwards, the next run is refused until you confirm the new version. The sheet is a speed bump for a person; the machine's
slash-command shell policy is the real veto.

A command cannot move the session out of a more restrictive mode: while the
session is in plan, a command that names the build agent runs under plan
anyway, and a command that would run unsupervised in another agent is
refused.

On a machine whose opencode is too old for slash commands, the menu shows the panel commands only; updating opencode on that machine brings the rest.

### Agent images

When a tool call produces an image, its card shows it inline under "Output":
most often a screenshot from a browser tool such as the Playwright MCP, or an
image the agent read. Only **PNG, JPEG, GIF and WebP** are shown; SVG is never
displayed inline, whatever the machine calls it.

The machine keeps the bytes and the chat fetches each image from it whenever
it is shown; the chat keeps no copy. Before showing one it checks the file's
own header rather than the type the machine claimed, and refuses anything
over 8 MiB or past about 50 megapixels, or that does not match the checksum
the tool listed. At most **8 images are shown per tool call**. When some are
left out, the card says so: _"3 images not shown (too many, too large or not a
supported type)."_ A broken image usually means the machine no longer has it:
an ACP agent keeps images in memory only, so a galopin restart loses them. An
image the agent saved as a file is the file explorer's business, not this.

### Stopping a turn

While a turn is live, the send button's place carries the stop control, exactly
as a chat does. It stays there while a permission card is up, because stopping
a request you do not want to answer is most of the point of it.

### Permissions

When the agent wants to edit a file or run a command, it asks first. The ask appears as the same approval card as in chat, with three choices: **Allow once** lets this one action through, **Always allow** lets the agent do that kind of thing without asking again, and **Deny** refuses it and the agent is told. The machine's own policy decides whether
anything may be auto-accepted at all — the panel is never the last word on
that.

### Subagents

When the session spawns a subagent, the tool call that spawned it is replaced
in the transcript by a card for that subagent — title, status, from the
machine's own roster. Expanding one fetches its own transcript and renders it
as a nested read-only conversation.

### Sessions that talk to sessions

A session's model can start another session on the same machine (`session_spawn`)
or send a message to one (`session_send`). Both are on by default and turned off
with `--no-agent-tools` at enroll (or `galopin policy set --no-agent-tools`
later). Each call asks first, with an approval card that shows the full prompt or
message. The one exception is a session that is already **auto-accepting**:

- **Spawn** goes through without a card. The new session is never more
  permissive than its parent, starts with auto-accept **off**, and asks for its
  own tools.
- **Send** goes through without a card only when the target session is in the
  **same workspace** as the sender and its mode is the same as the sender's or
  stricter (a `build` session can message a `plan` or another `build` session;
  a `plan` session asking a `build` session still gets a card). A message
  borrows the target's powers, so the target has to be no more permissive, and
  the sender's unattended reach stops at its own workspace: a send into another
  workspace always asks. Anything unknown asks too: a custom mode on either
  side, or a session with no explicit mode. Two custom-mode sessions never
  auto-send to each other.
- The machine's auto-accept policy still vetoes: with `autoAccept: denied`
  every call asks. Handoffs and questions are never auto-approved.
- A chain longer than three messages, sent back and forth, asks at every step
  after the third instead of stopping, and more than five messages a minute to
  the same session are refused outright.

An auto-approved call is not invisible: the "Spawned …" / "Sent to …" card in
the sender's transcript carries an **auto-approved** badge, and the machine's
audit log records it as `auto` with the reason.

What this means, plainly: an auto-accepting session can message equal-or-stricter
peers without you seeing a card. It could already run its own tools unattended,
so this is no new capability; the cost is noise and one agent's text steering
another's context, bounded by the hop and rate limits and visible in the badges
and the audit log.

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

**If the agent says your enrollment expired** (after a redeploy, for instance),
run the pairing command again on that machine. The agent reports this at once
instead of hanging; the [details](#when-the-refresh-token-dies) are under "How
it works".

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

`enroll` opens your browser to sign in (or prints a link and code to open on any device, your phone included), asks which billing group to use if you have several, and writes two files: the opencode config at `--output`, and a
refresh credential (mode 0600, default `<config-dir>/galopin/credentials.json`,
where `<config-dir>` is `~/.config` on Linux and `~/Library/Application
Support` on macOS). `run` then supervises opencode and dials out to the
chat. Open the sidebar's **Agents** panel: the machine is listed as **Pending** until you confirm it with the green check (**Confirm this machine**).

| Flag             | When                                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--cerea …/chat` | always include `/chat` when the chat is served there. The machine dials `<cerea>/api/v2/code/machine`, and without the base path it reaches the gateway instead                                                                                                                                                             |
| `--output PATH`  | the file is **replaced whole**. `enroll` asks before replacing an existing one, and `--yes` skips the question. If you keep your own opencode config, point `--output` somewhere else and pass `run --opencode-config PATH`                                                                                                 |
| `--device`       | force the device flow, which prints a URL and a code to open on any other device (the bundled Authelia's `opencode-enrollment` client allows it). Without a flag, `enroll` picks the loopback sign-in in the local browser when there is a display, and the device flow when there is none. `--loopback` forces the browser |
| the policy flags | `--allow-terminal`, `--allow-auto-accept`, `--allow-free-models`, `--workspace-root PATH` and the rest are the machine's own vetoes, fixed at enroll time: see [The machine policy](#the-machine-policy)                                                                                                                    |

If `enroll` warns that model discovery failed, no model is available to you yet. Ask your administrator to grant your group one, then run the same command again.

## How it works

!!! info "Background"

    You do not need any of this to pair a machine or use the panel. It is here
    for anyone who wants to know what runs where.

### The shape of it

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

### One binary, two jobs

| Job         | What it carries                                                                                                 | Command                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **LLM**     | opencode → the local refreshing shim → gateway `/v1`, billed to the signed-in person                            | `galopin enroll`, then the shim starts with `run` (or alone with `serve`) |
| **control** | the machine dials _out_ to the chat over WSS (`/api/v2/code/machine`), so the chat's `/code` panel can drive it | `galopin run`                                                             |

Nothing else needs pairing: the machine connects outbound with
its own enrollment token, and you confirm it in the `/code` panel
(`agent/PROTOCOL.md` §4).

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

### The state directory

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
