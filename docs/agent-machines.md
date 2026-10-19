# Agent machines: galopin, setting one up, and driving it

!!! info "For people using the Agents panel"

    Pairing your own machine and driving it from the chat; **see also**
    [The `/code` panel](code-panel.md), the operator's side of the same feature.

The Agents panel in the sidebar drives coding agents that run **on your own
machine**, not here. Your code stays on it: the agent sends what it needs to the model through your gateway, and the chat shows you files and changes as you look at them but keeps no copy. `galopin` is the one binary that makes that possible: it lives in this repository as `agent/`, and this page covers using it: pairing a machine, and what the panel does once it is paired.

None of this works until the deployment has set `CODE_AGENTS_ENABLED=true`; if
you run the deployment, [The `/code` panel](code-panel.md) is the page for that.

## Pair a machine in three steps

The commands on this page use three variables for your deployment's addresses:

```sh
export GATEWAY_BASE_URL=https://cerea.example.org   # the kit: your PUBLIC_ORIGIN
export CEREA_BASE_URL="$GATEWAY_BASE_URL/chat"
export OIDC_ISSUER="$GATEWAY_BASE_URL/authelia"     # bundled Authelia; else your IdP's issuer
```

A satellite or standalone chat on another host sets `CEREA_BASE_URL` to that address.

1. **Sign in to the chat once.** Pairing identifies you by the same account, so
   the chat must have seen you at least once.
2. **Copy the line.** In the sidebar's **Agents** side, click **Pair** (or
   **Pair a device** when the list is empty). The **Pair a machine** dialog
   prints one line for this deployment, with the origin, the issuer and the
   gateway filled in. Set what this machine may ever allow first (see
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

The **Pair a machine** dialog prints the command for you. It offers **every
`enroll` flag that sets what the machine will allow**, so nobody has to edit the
printed line by hand. Every control starts at `enroll`'s own default, a default
prints **no flag**, and the line above updates as you change things, with paths
and globs quoted so they reach `enroll` as single arguments. The dialog says it
once, plainly: _"These are fixed when the machine enrolls. Loosening one later
means enrolling again; `galopin policy set` on the machine can only tighten."_
(A control shown in an amber tone is one that opens something up.)

**Common options**, at the top:

| Control                                                                                       | What it adds to the printed command                                                                                                                                        | Default                                   | Use it when                                                                                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **The most any session may do here** (three pills: Allow · Ask · Deny, for all tools at once) | `--permission-max KEY=ACTION` for every tool                                                                                                                               | none pressed: `bash` Asks, the rest Allow | you want one cap for every tool (see below). Allow shows a warning about `bash`                                           |
| **Trust the repos this machine opens** (amber)                                                | `--allow-project-config`                                                                                                                                                   | off                                       | the machine opens repositories you trust, and you want their own opencode setup to load                                   |
| **Install opencode**                                                                          | opencode's own installer line, pinned to the release galopin is tested against (`curl -fsSL https://opencode.ai/install \| bash -s -- --version 1.18.34`), before `enroll` | off                                       | the machine is fresh and does not have opencode (the agent runs it as its coding engine); leave it off if it is installed |

**The cap** is "the most any session may do here": whatever a session's Deny /
Ask / Allow setting or an "always allow" says, a tool never goes past it. The
three pills set every tool at once; the per-tool rows (`edit`, `bash`,
`webfetch`, `task`, `session_spawn`, `session_send`, `session_read`, `schedule`)
are under Advanced. **The
flag replaces `enroll`'s default set rather than adding to it**, so the dialog
prints either nothing (the cap is as `enroll` has it) or the whole set: change
one tool and the line carries every tool that is capped, including the defaults
you left alone (`bash=ask`), and names a default you set to
Allow (`bash=allow`) explicitly, which is how an owner opts out of it.

**Advanced**, collapsed until opened (its summary counts what you changed, and
the printed line carries every changed value whether it is open or not):

| Control                                                       | What it adds                                                          | Default                     | What it does                                                                                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Terminals** (amber)                                         | unticked: `--no-terminal`; a number other than 8: `--max-terminals N` | on; at most 8 open at once  | the panel may open a real shell on this machine: anyone who controls your Cerea session can run commands as you, with no model and no permission rule in the way |
| **Slash commands that run shell** (amber)                     | unticked: `--no-command-shell`                                        | on                          | a slash command whose template runs a shell snippet may run it, before any permission is asked; plain slash commands work either way                             |
| **Background subagents**                                      | unticked: `--no-background-subagents`                                 | on                          | a task can keep running after its parent turn ends                                                                                                               |
| **The cap, tool by tool** (eight pill rows)                   | `--permission-max KEY=ACTION`, the whole set                          | `bash` Asks, the rest Allow | a different cap per tool                                                                                                                                         |
| **No agent tools**                                            | `--no-agent-tools`                                                    | installed                   | installs none of the agent tools (`session_*` and `schedule_*`), so sessions cannot start or message each other, and agents cannot make schedules                |
| **Allow free models**                                         | `--allow-free-models`                                                 | the gateway's models only   | models from providers other than the gateway's may be listed and used                                                                                            |
| **Keep opencode's own providers**                             | `--allow-opencode-provider`                                           | gateway only                | opencode's built-in providers stay enabled next to the gateway's                                                                                                 |
| **Workspace folders** (a list)                                | `--workspace-root PATH`, one per entry                                | anywhere                    | workspaces may only be created under these folders                                                                                                               |
| **No file explorer**                                          | `--no-files`                                                          | read-only browsing          | keeps the explorer out of the machine's files                                                                                                                    |
| **Hide files** (a list)                                       | `--file-deny GLOB`, one per entry                                     | the built-in secret list    | the explorer also redacts files matching these globs                                                                                                             |
| **Drop the built-in secret list** (amber)                     | `--no-default-file-deny`                                              | the secret list stays       | stops redacting `.env` files and private keys, keeping only your globs                                                                                           |
| **Agents may work outside the project folder without asking** | `--permission-rule external_directory=allow`                          | off: the agent asks         | by default an agent asks before reading or writing files outside the workspace folder; ticked, it does not                                                       |
| **Agents may read secret files without asking** (amber)       | `--permission-rule read=allow`                                        | off: the agent asks         | by default an agent asks before reading `.env` and similar files; ticked, it reads them like any other file, so their contents reach the model                   |

The two checkboxes at the bottom of Advanced answer, for every session on the
machine, a question an agent would otherwise ask. **Work outside the project
folder** stops the agent asking before it reads or writes files outside the
workspace folder. **Read secret files** stops it asking before it reads `.env`
and similar files, so their contents reach the model; that is why it is amber.
Both are off by default, and the cap above still applies on top. On the command
line the same answers are `--permission-rule external_directory=allow` and
`--permission-rule read=allow`; `--permission-rule` also takes other names for
people who write the command by hand.

Connection plumbing (`--issuer`, `--gateway`, `--cerea`, `--client-id`,
`--creds`, `--output`, `--device`, `--device-endpoint`, `--loopback`, `--group`, `--shim-port`,
`--no-discover`, `--yes`) is not offered: the dialog fills in what it knows, and the
rest you add yourself if you need it.

The command is chained with `&&`, so a failed step never runs the next one: the
installer, then (if checked) opencode's installer, then `enroll`, then `run`,
one step per line and one `enroll` flag per line; it pastes into a shell as
is. It calls the binary by its installed path, `~/.local/bin/galopin`, rather
than a bare `galopin`, because on a fresh machine `~/.local/bin` is not yet on
the shell's `PATH` (if you set `GALOPIN_INSTALL_DIR` for the installer, edit
the path to match). The
dialog also lists the binaries and `SHA256SUMS` for a manual download, and the
machines waiting for confirmation.

Nothing here lets a session do "anything": what a session may do is the
**Plan / Ask / Allow selector** in its composer, inside the limits this dialog
sets (see [Permissions](#permissions)).

### The machine policy

These are the machine's own vetoes. They are fixed at enroll time, stored in
the machine's `policy.json`, and **the chat can never loosen them over the
link**: whatever the panel sends, the machine refuses what its policy denies.
`galopin policy show` prints what a machine currently allows. `galopin policy
set` can only **tighten**; loosening anything needs a new `enroll`.

| Policy                           | Enroll flag                                                            | Default                                                                                                                                                                                | What it decides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Tighten later                                         |
| -------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Files**                        | `--no-files`, `--file-deny GLOB`, `--no-default-file-deny`             | read-only browsing, secrets redacted                                                                                                                                                   | Whether the `/code` explorer may browse a workspace, and which files it redacts (see [What the file explorer may see](#what-the-file-explorer-may-see)). Off: no explorer at all                                                                                                                                                                                                                                                                                                                  | `policy set --no-files`, `--file-deny GLOB`           |
| **Terminals**                    | `--no-terminal`, `--max-terminals N`                                   | allowed; at most 8 open at once                                                                                                                                                        | Whether the panel may open a real shell on the machine. A veto pair: the deployment must also set `CODE_TERMINAL_ENABLED=true` (see [The terminal](#the-terminal))                                                                                                                                                                                                                                                                                                                                | `policy set --no-terminal`, a lower `--max-terminals` |
| **Permission ceiling**           | `--permission-max KEY=ACTION` (repeatable)                             | `bash=ask`                                                                                                                                                                             | The most a permission key (`edit`, `bash`, `webfetch`, `task`, `session_spawn`, `session_send`, `session_read`, `schedule`, …) may ever be, whatever the session's setting, an exception or a reply says. Given, the flag replaces the default set. `policy set` can only lower it. The selector's Allow is capped by it.                                                                                                                                                                         |
| **Machine rules**                | `--permission-rule KEY=ACTION` (repeatable)                            | none                                                                                                                                                                                   | Fixed answers for every session on this machine. A deny there always holds; an allow or ask only matters for reading files, working outside the project folder, the stuck-agent brake, and agents starting or messaging sessions. The ceiling still caps them.                                                                                                                                                                                                                                    |
| **Safe directories**             | `--safe-dir PATH` (repeatable, replaces the default), `--no-safe-dirs` | `/tmp`, the temp dir, the toolchain caches (`~/.cache/{go-build,pip,uv,pnpm,node-gyp}`, `~/go/pkg/mod`, `~/.npm`, `~/.local/share/pnpm`), never the whole `~/.cache`, those that exist | Directories outside the workspace whose contents **never ask**, for any session under any setting, subagents included (see [Permissions](#permissions)). A safe directory is one the agent may write into — external_directory does not separate read from write, so a poisoned build cache is the residual risk, which is why the list stays short and never names the home folder itself, a config directory or a credential store. The ceiling key `external_directory` still caps every entry | `policy set --no-safe-dir PATH` (removal only)        |
| **Agent tools**                  | `--no-agent-tools`                                                     | installed                                                                                                                                                                              | Whether galopin installs `session_list`, `session_read`, `session_spawn` and `session_send`, and the schedule tools (`schedule_list`, `schedule_create`, `schedule_update`, `schedule_delete`), into the backend (see [Sessions that talk to sessions](#sessions-that-talk-to-sessions)). Denied: no tool at all                                                                                                                                                                                  | `policy set --no-agent-tools`                         |
| **Slash-command shell**          | `--no-command-shell`                                                   | allowed                                                                                                                                                                                | Whether a slash command's template may run its shell snippets. While denied, a command that expands shell, or whose shell behaviour is unknown (MCP prompts, ACP commands), is refused (see [Slash commands](#slash-commands))                                                                                                                                                                                                                                                                    | `policy set --no-command-shell`                       |
| **A repo's own opencode config** | `--allow-project-config`                                               | ignored                                                                                                                                                                                | Whether opencode loads the config a workspace's repository carries. Ignored by default (see [A repo's own opencode config](#a-repos-own-opencode-config))                                                                                                                                                                                                                                                                                                                                         | `policy set --no-project-config`                      |
| **Background subagents**         | `--no-background-subagents`                                            | allowed                                                                                                                                                                                | Whether the task tool may run a subagent in the background. While denied, `background:true` fails closed inside opencode; when allowed, a background child keeps running after its parent turn ends and its result returns as a synthetic message the panel shows (see [Subagents](#subagents))                                                                                                                                                                                                   | `policy set --no-background-subagents`                |
| **Models from elsewhere**        | `--allow-free-models`                                                  | denied: the gateway's models only                                                                                                                                                      | Whether the model list may include providers other than the gateway's. By default only `pystino/*` models are listed and accepted, so spend always lands in the account the machine enrolled under. Cerea filters as well, and answers 403 to a disallowed model                                                                                                                                                                                                                                  | re-enroll                                             |
| **opencode's own providers**     | `--allow-opencode-provider`                                            | denied                                                                                                                                                                                 | Whether opencode's built-in providers stay enabled next to the gateway's. Off, the written `opencode.json` carries `enabled_providers: ["pystino"]` (in that file, not in `policy.json`)                                                                                                                                                                                                                                                                                                          | re-enroll                                             |
| **Workspace roots**              | `--workspace-root PATH` (repeatable)                                   | unrestricted                                                                                                                                                                           | Workspaces may only be created under these paths; anything outside is refused                                                                                                                                                                                                                                                                                                                                                                                                                     | re-enroll                                             |

Other enroll flags: `--device` or `--loopback` to force a sign-in flow,
`--group NAME` to preselect the billing group or `--default-group` to bill to
your console default instead of pinning one, `--output PATH` for where the
opencode config goes (default `<config-dir>/galopin/opencode.json`), and `--yes` to overwrite without asking.

`run` drives opencode by default (it supervises `opencode serve`). `run
--backend acp --acp-command "<agent>"` drives any ACP agent instead:
`opencode acp`, Gemini CLI, Claude Code or Codex through their ACP adapters,
Pi through `pi-acp`. An ACP backend reports fewer capabilities (no usage,
compaction or subagents), and the chat panel hides those controls. The
Changes pane works for either backend, because the agent reads it from git.

Each enrollment mints a new machine id (`machine-id`, in the machine's state
directory). The chat therefore shows a re-enrolled machine as a new **Pending** machine, which you confirm again. A machine revoked in the panel is refused for good under
its old id, and `run` reports that and exits with code 78 instead of
reconnecting. A model the gateway gains later needs none of that:
`galopin models refresh` re-discovers the gateway's models into the same config
(`run` does the same at every start), so a re-enroll is for the machine's
policy, not its model list.

### A repo's own opencode config

A workspace is usually a repository you cloned, and a cloned repository is
someone else's input. It can carry an `opencode.json`, an `.opencode/`
directory (commands, agents, tools, plugins, MCP servers) and an `AGENTS.md`.
Loaded blindly, an `opencode.json` can point the gateway provider at another
endpoint, so **every prompt, and every file the prompt pulls in with `@`,
goes to a stranger's server instead of your gateway**; and its `{env:...}` and
`{file:...}` settings can read your environment and files into that request.
Both were reproduced against opencode 1.18.32.

So by default the machine **ignores** it: `run` starts opencode with
`OPENCODE_DISABLE_PROJECT_CONFIG=1`. That skips the repo's `opencode.json`,
its project commands, agents and MCP servers, and its `AGENTS.md`/`CLAUDE.md`;
your own global config, your user-level commands and galopin's agent tools
still load. The cost is real: a repo's own commands and agents do not show up,
and the panel says so on such a workspace ("this repo's opencode config is
ignored on this machine") so a missing command does not look like a bug.

**Known gap:** on opencode 1.18.32 neither that switch nor `--pure` stops a
repo's `.opencode/plugin/` scripts from being executed when opencode opens
the directory. Do not open a repository you do not trust in an agent, whatever
this setting says.

`enroll --allow-project-config` (the pairing dialog's checkbox) opts in for
machines whose repositories you trust: the repo's config loads, **including
its plugins, which run as you**. galopin still pins the gateway provider,
`enabled_providers`, `model` and `small_model` above whatever the repo sets, so
a repo cannot redirect your prompts; an attempt to (a repo's `opencode.json`
setting `provider`, `enabled_providers`, `model`, `small_model` or an agent's
model) is written to the machine's `audit.log` as
`project_config.override_attempt`, listing the keys and never the values. An
agent-level model naming a provider outside the allowlist fails with an error
rather than routing anywhere. With `--allow-opencode-provider` as well there is
no allowlist to pin and this last guarantee does not hold (**known: no
guarantee**): a repo agent can name the repo's own provider.

### What the file explorer may see

`run` lets the `/code` explorer browse each workspace, **read-only**, confined
to the workspace directory (symlinks that leave it are listed, never
followed), with secrets redacted: `.env` files (not `.env.example`), private
keys, `.netrc`/`.npmrc`/`.pypirc`, cloud credentials files, `*.tfstate` and
the like. Redaction keeps secrets off screens and out of logs; it is not a
boundary against the agent, which can read any file. The flags that turn it
off or extend the list are in [The machine policy](#the-machine-policy).

### The terminal

`/code` can also open a real, interactive shell on the machine, but only
when both sides say so. The machine allows it unless it was enrolled with
`--no-terminal` (or enrolled before terminals were on by default; then every
terminal request is refused until it is enrolled again), and the deployment
must set `CODE_TERMINAL_ENABLED=true` (off by default). Everything in /code needs a
sign-in within the last 7 days; the machine's own link is unaffected
([The 7-day sign-in](#the-7-day-sign-in)). A terminal re-checks that every
minute, so one opened just before the window closes ends at the next check
rather than living as long as its socket. Turning it on means exactly this: **anyone who
controls your Cerea session can run commands as you on this machine.**
There is no model and no permission rule standing in the way once a
terminal is open — it is strictly more power than any permission rule or the
selector's Allow, which only ever covers the _model's_ tool calls (within the
ceiling). `enroll` prints a warning (not a
refusal) whenever terminals are on: _"terminals are on: the /code panel can open
a remote shell here, outside every permission rule (--no-terminal turns them
off)."_

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

**galopin answers every permission ask; it writes no rules into opencode.**
(ADR 0097 in the ai-stack repository)
opencode is configured, once per start, so that **every tool call asks** — one
constant "everything asks" floor, the same for every agent, subagents from their
first call included. galopin receives each ask and answers it itself: **reject**,
**once**, or a **card** for you. It never answers "always", and it never writes a
rule into a session. Your setting (Plan · Ask · Allow), your exceptions and the
machine's ceiling are galopin's own state, read at each ask, so a change takes
effect at the very next call, mid-turn included. The approvals galopin keeps for
itself are the ones with no opencode equivalent (`session_read`, `session_spawn`
and `session_send`, see [Sessions that talk to sessions](#sessions-that-talk-to-sessions)),
plus hard limits that are not permissions at all (hop and rate limits, the
same-workspace check on sends).

**How a call is decided**, first match wins: (1) the machine's ceiling denies it
→ refused; (2) the ceiling asks → a card, in every setting (nothing an exception
or Allow says can lift it); (3) on **Plan**, a read inside the project is fine
and anything that changes something is refused; (4) a spawner and the session it
spawned talking to each other → fine; (5) a schedule's coordination grant; (6) a
matching exception → fine; (7) the machine's own `allow` rule; (8) on **Allow**,
fine; (9) on **Ask**, a read inside the project is fine and everything else is a
card. A subagent is decided by **its main session's** setting, from its first
call.

**Reads ask too, and it is cheap.** Measured on this stack, each ask costs
about 0.2 s at the median (0.3 s at the 95th percentile) for a local round
trip, small next to a model step.

**What `enroll` and `run` put where.** `enroll` writes `edit`, `bash` and
`webfetch` as `ask` into the galopin-owned `opencode.json` of a **new** machine;
under the floor that file is now harmless redundancy. Every `run` rebuilds the
`OPENCODE_CONFIG_CONTENT` opencode is started with: the ask floor plus the
built-in read-only agents' own denies restated (opencode merges the global
config after an agent's rules, so a bare ask would otherwise turn `plan`'s and
`explore`'s denies into asks). At start galopin also reads every agent back; a
**custom agent's own allows are no longer honoured natively** — they are closed
with one more start — because the way to give a standing allow is the machine's
own rules (`--permission-rule KEY=allow`), which sit under the ceiling. A call
no agent routes through a permission (a custom tool you installed in opencode's
own config directory) still runs unasked; galopin logs and reports any native
allow it finds. `enroll` writes `--output` whole (it asks before replacing an
existing file; `--yes` does not ask), so point it at a dedicated path.

**Machines enrolled before ceilings.** A machine whose `policy.json` predates
ceilings has none: nothing caps its Allow, so on Allow an edit, a command or a
fetch runs without asking, in subagents too. It does **not** need a re-enroll to
ask by default: every session starts on **Ask**, on every machine, enrolled
earlier or not. The panel does not show such a machine a clean bill. When the
machine's `hello` reports an empty ceiling and its rules carry no rules from the
file, the dialog says up front _"Re-enroll this machine to set limits…"_ with a
button into the enroll flow, and the machine's row in the sidebar carries the
same notice with the one-line enroll command. One re-enroll sets a ceiling, and
the notice goes away when the machine reports one.

**Sessions from before this version.** An older galopin wrote rules into each
session, and opencode keeps them for good. On the first message after the
update galopin adds one final "everything asks" rule to such a session and never
writes again. It cannot remove what is stored: an old Deny a subagent inherits
can still refuse that session's new subagents, and an old `external_directory`
allow can still pass to them. The panel shows the **stuck Deny** banner for
those sessions only; the way out is to **start a new session**. New sessions
never have the problem.

**What the ceiling is, stated plainly.** Until the OS sandbox exists, the
ceiling is galopin refusing or asking about calls it is shown, and **a shell
can do anything the ask for it does not name**. A ceiling that denies or asks for
`bash` is meaningful against a hijacked Cerea session; `webfetch=deny` while
`bash` is allowed is not (a command can fetch). `galopin enroll` and
`galopin policy set` warn about that combination. The embedded terminal is a
machine-side setting outside every permission, and enabling it lets a Cerea
session change the ceiling; so does `bash` that is allowed to run, because a
command can edit `policy.json` and the config galopin starts opencode with.
That is why `enroll` defaults `bash` to `ask`, and why raising that is a
decision about the machine, not the session. An agent reached over ACP asks
only as far as its own policy does: a tool it runs without asking never
reaches galopin.

## The panel

**Chats | Agents** switches the sidebar between the two. The Agents side is a
tree: paired machines, each with its workspaces, each with its sessions.
Everything that _changes_ something lives here — pairing, revoking, adding a
workspace, starting or archiving a session, renaming. The main pane shows whatever you have selected in the tree.

A machine that is not currently connected renders as **offline** — the tree
never tries to load its workspaces, so one offline machine never freezes the
rest of the list.

### The 7-day sign-in

Everything in /code needs a sign-in within the last 7 days; the machine's own
link is unaffected. Older than that, the panel draws one card — _"Your sign-in
is older than 7 days. Sign in again to see your machines."_ — with a **Sign in**
button, and nothing else: no device tree, no Needs-you inbox, no terminal tab,
no counts. The server is what enforces it: every request under
`/api/v2/code/` except `/status` answers `401 {code: "reauth_required"}` while
the sign-in is stale (or has no recorded time at all), so no part of the panel
can be asked for a machine's data, whichever way it asks. A tab that is open
when the window closes finds out by itself: its event stream ends with a
`reauth_required` frame at the 7-day mark, and the page also flips on its own
timer, with no request. Composer drafts stay in the browser but are not shown
until you are back.

A tab whose chat session merely **expired** (no session at all — the ordinary
hourly expiry of a chat without a refresh token) shows a different card —
_"You were signed out. Sign in again to see your machines."_ — and its
**Sign in** goes through a plain `/login?next=/code`, never the forced
`reauth=1` prompt: with the provider's SSO session alive (tick **Remember
me** at the bundled Authelia) the re-login is silent and the panel comes
back on its own; an open tab even leaves for that sign-in by itself, once
per minute at most. Only the 7-day staleness forces the password.

Your machines keep working while you are signed out of the panel. The machine's
link to Cerea is its own credential and is not part of this; what stops is
you seeing and driving them from the browser.

### The Needs-you inbox

The inbox lists, across all your machines, the approvals and questions that are
waiting for you, each answerable in place and linked to its session. It is part
of /code, so it **goes dark with the rest** when the sign-in is older than 7
days. That is a trade: nothing in the browser will tell you that a session is
waiting, and a session waiting for an approval waits (it does not proceed) until
you sign in again. For work you leave running for days, either keep the
sign-in current, or put the session on **Allow** for the tool calls you are
content to have run without asking, within the machine's ceiling (questions
still wait for you).

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

A long session opens on its newest 40 messages under a "Loading conversation…"
skeleton; scrolling up fetches the earlier ones (on a machine with the current
galopin; an older one sends the whole log). The last 8 sessions you had open are
kept in the browser tab's memory, so going back to one shows it at once; that
copy is display only until the fresh one arrives, and nothing is stored on disk.
While a turn works the animated mountain is the progress mark, and answers use
the full row on desktop. The agent's task plan is one card per message, after
its thinking and tool steps and before the answer. **Fork from here** on a
finished answer starts a new session from that point. When the model provider
refuses a turn, the failed turn shows the provider's own text — the newest
failure expanded, earlier ones folded to one line you can reopen — and while the
agent retries a rate limit or overload the view says "Retrying — …" beside Stop
(both need the galopin update).

### The composer's pills

Inside the prompt box, in the chat's own pill idiom:

- **mode** — the backend's own modes (plan, build, …), listed live rather
  than from a hardcoded set that would drift from what it enforces.
- **model** — the models the session's backend offers.
- **permission** — the **Plan · Ask · Allow** selector: what this session does
  about a tool call it has no rule for, until you change it. A new session
  starts on **Ask**. It shows what the machine says (never a guess), and a click
  is only reflected once the machine has confirmed it. Under **Allow** it names
  what the machine's limits still hold back, e.g. _"Allow · bash asks (machine
  limit)"_. On a **subagent**'s view it is disabled, showing its main session's
  setting: _"Follows the main session"_. It is hidden while the sign-in is stale.
  Beside it a shield button, hidden on a subagent and while the sign-in is
  stale, opens this session's [Permissions dialog](#permissions) and shows the
  exceptions count when there is one.
  What each setting means is under [Permissions](#permissions).

Mode, model and the permission setting apply **to the whole session**, not only to the next message, and stay in force until you switch again.

### Slash commands

Type `/` at the start of the prompt box and a menu opens with the commands
this session can run. It is also the help: what it lists is exactly what
there is. The menu groups them under headings, in this order:

- **Panel** — commands this panel runs itself: `/compact`, `/undo`,
  `/redo`, `/model`, `/mode`, `/effort`, `/new`. Each is listed only when the
  agent's backend can do it. They drive the same routes the pills and the
  transcript use; nothing new runs on the machine.
- **Project** (badge "from this repo") — commands defined in the open
  workspace's repository (`.opencode/command/*.md`). Listed only on a machine
  enrolled with `--allow-project-config`; by default a repo's config is ignored
  (see [A repo's own opencode config](#a-repos-own-opencode-config)). Running
  one is running repository code on your machine; the first run asks (see
  below).
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

| What you see                                                        | Cause                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Needs a setting this machine was not enrolled with" (403)          | the template expands shell (or its shell behaviour is unknown, such as an MCP prompt) and the machine was enrolled with `--no-command-shell`; a command pinned to a non-gateway model without `--allow-free-models`; or a file the command reads through `@path` matches the machine's file deny list |
| "This command changed since you approved it; review it again" (409) | the command's template changed since you reviewed it: the confirmation is asked again                                                                                                                                                                                                                 |
| "no longer listed"                                                  | the machine's list is re-read at run time, so a command that was deleted after the menu opened is refused                                                                                                                                                                                             |
| "The agent is mid-turn. Stop it, or wait for it to finish."         | commands are refused while a turn is running (the send button is hidden then, too)                                                                                                                                                                                                                    |

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

Every session has one **permission setting**, the **Plan · Ask · Allow**
selector in the composer. It covers the whole session until you change it, and
**new sessions start on Ask**, on every machine, whether enrolled yesterday or
long ago. It is the machine's word that the selector shows: a click is reflected
once the machine has confirmed it.

| Setting   | What it does with a tool call the session has no rule for                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plan**  | the agent plans and reads; every call that would change something is refused, with no card. The agent is told. Choosing Plan switches the session to opencode's `plan` agent |
| **Ask**   | asks you, with the approval card (a read inside the project does not ask)                                                                                                    |
| **Allow** | lets it through without asking, **up to the machine's limits** (the ceiling you set at enroll)                                                                               |

**What the setting covers.** Editing (writes and patches), `bash`, `webfetch`,
`websearch`, `codesearch`, the `task` tool that starts a subagent, and every MCP
and custom tool follow the setting. **Reading inside the project stays allowed on all three**, and
so does the rest of what the agent does to look around and plan: `read` (its
`.env` files still ask, as the agent's own rules say), `glob`, `grep`, `list`,
`lsp`, `question`, the todo and plan tools and `skill` keep their normal
behaviour whatever you choose, and starting a subagent (`task`) is not a change
in itself: on **Plan** an explore-style subagent can look around, and its own
edits are refused by the same Plan setting.

**Two asks survive Allow:** writing **outside the project folder**
(`external_directory`) and the **stuck-agent brake** (`doom_loop`, an agent
repeating itself). Allow never silences them. The machine's ceiling is the other
thing Allow cannot pass: where the machine says `bash` asks, `bash` asks on
Allow too, and the selector says so (_"Allow · bash asks (machine limit)"_).
Nothing in the panel can raise the ceiling; loosening it means enrolling again.

**What never asks, on every machine:** the **safe directories** the machine was
enrolled with — by default `/tmp`, the temp directory and the toolchain caches
(`~/.cache/go-build`, `~/.cache/pip`, `~/.cache/uv`, `~/.cache/pnpm`,
`~/.cache/node-gyp`, `~/go/pkg/mod`, `~/.npm`, `~/.local/share/pnpm`), those
that exist. Never the whole `~/.cache`: it also holds programs other tools run
(opencode's own `bin/`, Playwright's browsers). A machine enrolled before this
list existed gets the default with the galopin update. The Permissions dialog names them in the _Work outside the project
folder_ row ("Allowed: /tmp, ~/.cache/go-build, …; elsewhere asks"), and no session —
Deny, Ask or Allow, a fresh one or an old one, a subagent's first turn
included — is shown the external_directory card for anything inside them. They
are machine policy, not a setting: re-enrolling with `--safe-dir PATH` replaces
the list, `--no-safe-dirs` empties it, and `galopin policy set --no-safe-dir
PATH` removes entries without a re-enroll. Because external_directory does not
separate read from write, a safe directory is one the agent may write into: a
build cache it can poison, which is the residual risk of the convenience, and
why the default list stays short. The ceiling still has the last word — with
`external_directory` capped at ask or deny, the safe directories ask or are
refused like everything else.

**A subagent follows the session's setting from its first turn.** Its asks are
decided by its main session's setting, exceptions and the machine's limit, like
any other call: on **Allow** it runs without a card, on **Ask** it asks, on
**Plan** it is refused at its first call that would change something. The
machine's limit still holds: where it says `bash` asks (the default), the
subagent's `bash` asks too.

**The approval card.** When a tool call asks, the card offers **Allow once**,
**Always allow (this session)** and **Deny**. The panel relays your answer
unchanged to galopin, which answers opencode once.

- **Always allow (this session)** adds an **exception** for that command or
  pattern, **for this session only**, on top of the setting: it is not a
  standing grant, and it is no longer shared with other sessions in the
  workspace. The button is **not offered** for a kind of call the machine's
  ceiling holds below allow (by default `bash`), because an exception there
  would store nothing: those cards offer Allow once and Deny.
- **Deny** refuses that call and tells the agent. It ends every other pending
  ask in the session.

**Exceptions** are kept while the setting is **Plan** and blocked then: Plan
beats them. Switching back to **Ask** restores them, and on **Allow** they are
redundant but harmless. They are removed one by one from the Permissions
dialog.

**The Permissions dialog** opens from a session's ⋯ menu (the
**Permissions…** item, not offered on a subagent, which follows its main
session) or from the shield button beside the **Plan · Ask · Allow** selector
in the composer; the transcript and its approval cards stay in view while you
read it. It is titled _Permissions — <session title>_ and reads that session's
rules itself, so it can be opened for any row, selected or not. Besides the
selector and **Remove** it holds a **Coordination** section: two switches —
_Can find, read and message other sessions_ and _Can start new sessions_ — for
the sessions this one may touch without a card. That is the standing answer to
the orchestrator's repeated `session_read` cards: granting it once replaces
asking every time, from the session's next turn. Still asks, grant or not: a
session in another workspace, a send past three hops, anything the machine's
ceiling caps, and the rate limits. A session it spawns starts with the same
grant. It gives one row per
capability
(edit and write files, run commands, fetch from the web, start subagents, read
files, work outside the project folder, start or message other sessions, ask you
questions) with the **final answer**: _Allowed_, _Asks first_ or _Blocked_.
opencode's rules are last-match-wins and the same permission can repeat with
different answers, so the panel works the answer out the way opencode does
instead of listing them. Reading says _except secret files like .env: ask_ when
a narrower rule asks about those. A row the machine's ceiling holds below what
the session's setting would give says _limited by this machine_. Under the rows
come the session's **exceptions**, each _Allowed for this session: `git status *`_
with a **Remove** that makes that command ask again. Remove can only tighten,
and the machine records each removal. An exception the machine marks as not
removable shows "held by the machine" instead. The full rule list, in evaluation
order, stays behind _Show the raw rules (for troubleshooting)_; there a rule
from the person's own opencode config that Cerea or the machine replace is
struck through and labelled _overridden by Cerea_ (or _by this
machine's rules / floor / limits_); the match behind that label is literal, so a
rule that a broader glob in fact replaced can still be listed as in force. While
the sign-in is [stale](#the-7-day-sign-in) the shield button and Remove are
hidden, and the server refuses them anyway. The shield button carries the
session's exceptions count; a machine enrolled before ceilings is answered with
the re-enroll notice instead of a clean bill. A machine whose galopin predates
permission reporting says so in the dialog instead of listing rules.

### Subagents

When the session spawns a subagent, the tool call that spawned it is replaced
in the transcript by a card for that subagent — title, status, from the
machine's own roster. Expanding one fetches its own transcript and renders it
as a nested read-only conversation.

A subagent may run in the background (the task tool's `background:true`,
behind opencode's experimental `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`). The
machine allows that unless enrolled with `--no-background-subagents`; then
the flag is never set and a background task fails closed. A
background child keeps running after its parent turn ends — the parent reads
idle while the child is still working, and the panel says so — and its result
is injected back into the parent as a synthetic message the panel folds into
the task's own card as completed or failed, never as model text. Passing
`task_id` follows up the same running child; the card names it a follow-up
rather than a new spawn.

**A subagent has no setting of its own: it follows its main session.** Its
rules are the main session's setting and exceptions, capped by the machine's
limits, never the machine's own allows. They are applied when the subagent
appears and re-applied to every live subagent whenever you change the main
session's setting or remove an exception, so Deny stops a running child too.
Until they land, the machine starts a subagent from an ask floor rather than
from allow-everything; galopin answers the first turn's asks that the main
session's rules allow (above). On a subagent's
own view the selector shows the main session's setting, disabled (opencode
itself hands a subagent only its parent's _deny_ rules, which is why galopin
sets the rest explicitly).

### Sessions that talk to sessions

A session's model can start another session on the same machine (`session_spawn`),
send a message to one (`session_send`) or read what one has said (`session_read`).
All are on by default and turned off
with `--no-agent-tools` at enroll (or `galopin policy set --no-agent-tools`
later), which installs no tool into the backend at all. There are four:

- `session_list` reads the machine's sessions and needs no approval.
- `session_read` returns another session's most recent **user and assistant
  text** as plain text (the last 1 to 50 messages, ten by default, each with its
  role and time). It never returns tool calls or their output, reasoning or
  attachments; a message over 4 KB is cut, and the whole answer is capped at
  32 KB (the oldest messages go first, and the answer says so). It cannot read
  the session that calls it; a subagent of the caller's own tree is allowed.
  Its card shows the **target** and how many messages.
- `session_spawn` starts a new session. Its approval card shows the new
  session's **title**, its **mode** and the **full prompt**.
- `session_send` sends a message to an existing session. Its card shows the
  **target** session, the **full message** and the **hop** (how many agent
  sends deep this chain is).

Whether a spawn or send asks is decided from the asking session's **effective
rules as galopin composes them** (the agent's, then the session's: the machine's
own rules, what you set for it, and the ceiling last), looked up under the names
`session_read`, `session_spawn` and `session_send`:

- **allow** — no card, and the card in the transcript carries an **allowed by
  this machine's rules** badge.
- **deny** — refused.
- **ask, or no rule** — a card, as for any other ask. Nothing you answer on it is
  remembered: it has no "Always", and answering "once" is the only form.
- A blanket `"*": allow` never grants a **read** (otherwise opencode's permissive
  default would let any session read any transcript), but under the session's
  **Allow** word it grants a **spawn or a send**, like any other tool; a blanket
  `"*": deny` refuses them. A transcript can hold secrets, which is why a read
  stays as hard to get as a send.
- A send or a read into another workspace always asks.
- A session can also be **granted** them without a rule: see below. Prompts and messages over 8 KiB
  are refused before any card is raised, so a card never shows a truncated text.
- A chain longer than three messages, sent back and forth, asks at every step
  after the third instead of stopping; the card says why. More than five
  messages, and separately more than five reads, a minute from one session to the
  same target are refused outright.

#### Granting a session its coordination tools

A scheduled run has nobody to answer a card. Cerea's schedules therefore have two
options, both off: **Can find, read and message other sessions**
(`session_list`, `session_read`, `session_send`) and **Can start new sessions**
(`session_spawn`). At each run Cerea sends the machine
`session.grantCoordination {sessionId, keys}` for the session it just created or
chose, before the prompt. galopin records the grant with the session (it
survives a restart) and treats those tools as **allowed** for it. It is never
more than you allowed: the machine's **ceiling** still caps a granted key (at
Ask the card still appears, in the Needs-you inbox; at Deny it is refused), your
own `ask`/`deny` rule for the tool beats it, another workspace's sessions still
ask, the hop limit and the rate limits stand, and Deny on the session wins. A
galopin from before this op answers `unsupported`: the schedule still runs, and
its run row says "this machine's galopin is too old to grant coordination; update
it". Each grant is a row in `audit.log` with its keys and outcome.

Questions always wait for a person, and a rule never answers a handoff. An allowed call is not invisible: the badge shows in the sender's transcript and
the machine's audit log records it.

#### Limits

Spawning is bounded so a session cannot fork without end: a spawn chain is at
most two deep (a spawned session can spawn once more, its child cannot), at most
three spawned sessions are live under one root, and a root that has started six
in ten minutes is refused. A spawned session runs in the spawner's own
workspace and inherits its permission word, coordination grant and exceptions,
never more (an Allow spawner makes a child that runs without a card; a
read-only child comes from `mode: "plan"`) — still under the machine's ceiling,
which caps the child exactly as it caps the caller. The exceptions are the
"always" answers the person gave the spawner, copied as they are; removing one
from the spawner later does not remove it from children already spawned. It
appears as its own top-level row with a "spawned by" link, not inside the
spawner's tree.

#### Scheduling work

The agent tools include four for the owner's **scheduled actions** (see
[Scheduled actions](code-panel.md#scheduled-actions)): `schedule_list`,
`schedule_create`, `schedule_update` and `schedule_delete`. They reach Cerea
over the machine link as `call` frames (PROTOCOL.md §5) and act as the
machine's owner, only on schedules that run on this machine. They need a Cerea
that advertises `features.machineCalls: ["schedule"]` in its welcome; against an
older one each tool answers that this Cerea does not support schedules from
agents.

Whether a call asks is the permission key **`schedule`** (a ceiling key too,
uncapped by default):

- `schedule_list` never asks.
- `schedule_create` follows the session's word like any tool: **Allow covers
  it**, Ask raises a card, Deny refuses. Except in a scheduled run (a session a
  schedule started or used, or one of its subagents): there it always asks, even
  under Allow or a machine allow rule, so a schedule cannot multiply itself.
- `schedule_update` that only pauses, or `schedule_delete`, of the schedule the
  session is a run of: no card ("stop when you are done").
- Any other update or delete always asks, even under Allow.
- A ceiling of `schedule=ask` or `schedule=deny` wins over all of the above.

The card shows the whole schedule (name, timetable, timezone, workspace,
session, agent mode (`plan` or `build`, default `build`), permission mode, coordination and the full prompt), the changed fields for an
update, the name for a delete.

Cerea then holds every call to its own rules, whatever the card said: the store's
(15-minute floor, per-person cap, timezone, `CHAT_SCHEDULES_ENABLED`); a
permission mode no looser than the calling session's own and coordination no
wider than its grant; at most five running agent-made schedules per machine;
at most ten changes per machine per hour (a pause or a delete is never refused).
Each change is in the `/code` audit trail with the calling session, and the
Schedules list shows the schedule as **Created by an agent in ‹session›**.

#### Steering

A message that arrives while the target is mid-turn is folded into that turn as
steering; to an idle target it starts a turn. The message reaches the target
marked as coming from another agent session, and the target's transcript shows
it as a distinct "From agent" bubble with a link back to the sender. The same
steering applies to your own messages: with a turn running, the composer's
**Send** sits beside **Stop** (its chevron is stop-and-send), and slash
commands are still refused mid-turn.

What this means, plainly: where a machine's rules allow `session_send` (or a
session was granted it), a
session can message others in its workspace without you seeing a card. The cost
is noise and one agent's text steering another's context, bounded by the hop and
rate limits and visible in the badges and the audit log. A machine that leaves
these two on ask, which is the default, shows a card for every one.

#### What these gates do not cover

An approved shell command can do anything you can on that machine (opencode's
server password sits in its process environment, readable by same-user
processes); the coordination gates constrain the model's tools, not an approved
shell.

#### The delegation skill

Tools alone do not tell a model when to use them, so galopin installs one
opencode skill beside them, named `delegation`
(`skills/delegation/SKILL.md` in the directory galopin owns for its tools). It
is written with the tools and only with them: a machine enrolled with
`--no-agent-tools` gets neither. Like any skill, its description rides every
turn and the model loads the full text when a task matches. It tells the model:

- **subagents first:** fan out read-only work as several `task` calls in one
  message, keep every edit in the parent, and summarise what the children found
  before acting on it;
- **other sessions:** find a target with `session_list` rather than guess an
  id, expect every read, spawn and send to raise a card, never route around a
  declined card, and treat a message from another session as a peer's request,
  not the person's;
- **background subagents:** use `background: true` for long work where the
  machine allows it, and do not promise it where it does not;
- **long waits:** never sleep-and-poll in the foreground (CI, a release, a full
  test suite): hand the wait to a background `task`, end the turn and pick up
  when its result arrives;
- **when it runs on a schedule** (its prompt starts with the
  `[Scheduled run …]` line, see [Scheduled actions](#scheduled-actions)): nobody
  is watching, so look with `session_list` and `session_read` before steering,
  do not resend a message the target has not acted on yet, reuse a session with
  the same job instead of spawning a new one, and end with a short summary of
  what the run checked, sent, started and left waiting for the person;
- **scheduling work:** list schedules before creating one, prefer
  `session: "this"` for a follow-up, write a prompt that stands on its own,
  name each schedule so the person knows what it does, and pause or delete the
  schedule it is a run of when the job is done.

The skill only describes what the tools and opencode's own `task` tool do; the
gates above are what enforce it.

### The diff pane

The **diff** control opens the shared side pane — the same frame artifacts open
in — with the session's file changes, rendered by the same diff machinery the
artifact panel uses. The before/after pairs come from the machine; nothing is
reconstructed here.

### Scheduled actions

**Schedules** (under the devices in the sidebar) send a prompt to one of your
sessions on a timetable. Pick the **machine** (online or offline), then a
**workspace** on it (or **New workspace…**, created when you save, under the
machine's own `workspaceRoots`), then **a new session each run** (titled
"name · date", and marked with a clock in the tree) or **one existing session**.
Then the mode, model and permission word, the prompt, and when: every N hours,
daily, weekdays, weekly, or a cron expression, never closer than 15 minutes, in
the timezone you choose with the next three run times shown as you edit. "Schedule
this…" in a session's ⋯ menu starts the editor on that machine, workspace and
session.

- **The machine pays.** Cerea only sends the prompt over the link you already
  have; the run uses the machine's own credential and policy, and the machine's
  ceiling caps the permission word you pick.
- **Ask stalls.** Nobody is watching a scheduled run. On Ask it stops at its
  first approval and waits; the card is in the **Needs-you inbox**. Pick Allow
  for work that must finish unattended (a key your machine caps at Ask still asks).
  For "always this session", the word is set on that session each run and stays.
- **The agent knows it is a scheduled run.** Each prompt arrives with one line
  above what you wrote: `[Scheduled run of "<name>", <timetable> (<timezone>);
previous run <3 h ago | none>; coordination: <granted tools | none>]`. The
  [delegation skill](#the-delegation-skill) tells the agent what to do with it.
- **Missed runs.** Machine offline: recorded as missed, not queued. Previous
  run's session still working (or waiting on an approval): skipped. Chat down:
  one late run is made up only if it is under half the interval late (at most an
  hour), otherwise recorded as missed. The workspace or session is gone:
  the run fails with that reason, and three failures in a row switch the schedule
  off. A revoked machine switches its schedules off at once.
- **History.** Every occurrence is a row in the schedule's history, with why, and
  a link to the session it reached. **Run now** fires one run immediately (the
  skip rule applies).

### Archiving and revoking

Archiving a session or a workspace confirms first, then asks the machine and
redraws that device's subtree from its answer — never an optimistic removal,
because the machine owns the listings. If the archived row was the one open
in the address, the panel navigates away from it.

Revoking a machine tombstones the pairing record: it is refused if it tries
to reconnect, and its live socket (if any) is closed immediately. Re-running
`galopin enroll` mints a **new** machine id — it re-pairs as a fresh
`pending` row, not a resurrection of the revoked one.

A machine the **gateway** refused (a disabled account, or sessions
invalidated since it enrolled) stays listed as **access revoked**, with the
re-enroll command beside it, until you remove it with its bin icon; removing
it only takes it off the list. A refused **token** is not a refused account:
when the gateway refuses the token a machine holds, the chat checks the token
on its own first, and if that token no longer validates (it expired, or the
identity provider revoked it on refresh, as GitLab does) the link is closed
with 4401 and the machine renews and reconnects, with nothing revoked.

A machine refused for **access groups or capabilities** is neither: the link
is closed with 4404 and the device **stays enrolled** — no re-enroll, no bin
icon. Regaining the group, or a group granting the coding-agents capability,
reconnects it by itself. What you see depends on which one bit:

- outside the required groups: the gateway's join gate refused the account;
- no coding-agents capability: the account may use the chat but not `/code`
  (a _chat-only_ person — the gateway console's Users page badges them **Chat
  only**). The Agents switch is gone from the sidebar and `/code` answers
  "not available for your account"; the chat itself keeps working throughout.

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

**Linux**, as a systemd user service, so galopin starts at boot, restarts if it
crashes, and keeps running after you log out. Run these as the user that
enrolled the machine (not root), once `galopin run` works in a terminal:

1. Stop the `galopin run` you started by hand (Ctrl-C in its terminal), so two
   copies don't fight over the machine's link.
2. Write the unit. It's the same file as `agent/packaging/galopin.service` in
   the Cerea repository:

   ```sh
   mkdir -p ~/.config/systemd/user
   cat > ~/.config/systemd/user/galopin.service <<'UNIT'
   [Unit]
   Description=galopin: this machine's link to the chat's /code panel
   After=network-online.target
   Wants=network-online.target

   [Service]
   ExecStart=%h/.local/bin/galopin run
   Restart=on-failure
   RestartSec=10
   # 78 = this machine was revoked in the /code panel: restarting cannot fix it.
   RestartPreventExitStatus=78
   # opencode must be on this PATH; add its directory if it lives elsewhere
   # (`command -v opencode` tells you where).
   Environment=PATH=%h/.local/bin:%h/.opencode/bin:%h/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

   [Install]
   WantedBy=default.target
   UNIT
   ```

3. Start it now and at every boot, and keep it running while you're logged out:

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now galopin
   loginctl enable-linger "$USER"
   ```

   `enable-linger` is what lets a user service run with nobody logged in. Some
   distributions ask for `sudo loginctl enable-linger <user>`.

4. Check it:

   ```sh
   systemctl --user status galopin       # "active (running)"
   journalctl --user -u galopin -f       # its log; Ctrl-C to stop following
   ```

   The machine shows as online in the /code panel within a few seconds.

**After updating galopin** (re-running the install line from the pairing
dialog), restart the service so it runs the new binary:
`systemctl --user restart galopin`.

**Over SSH,** if `systemctl --user` answers "Failed to connect to bus", your
session has no user bus. Log in again, or run
`export XDG_RUNTIME_DIR=/run/user/$(id -u)` first.

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
sign in again with `galopin auth login` on that machine — no re-enroll, no new
machine id, and a running agent picks the new credential up without a restart.
Only a machine **revoked** in the `/code` panel needs the pairing command
again. The agent reports this at once instead of hanging; the
[details](#when-the-refresh-token-dies) are under "How it works".

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
curl -fsSL "$CEREA_BASE_URL/galopin/install.sh" | sh
```

(The `/code` pairing dialog shows this command with your addresses filled in.) The script picks the binary for this OS and CPU
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

**Prerequisite:** `opencode` on the PATH, at the release galopin is tested
against (currently 1.18.34; the one place it is written is
`agent/packaging/opencode-version`): `npm i -g opencode-ai@1.18.34`, or
`curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.34`. A newer
opencode usually works, but it can change something galopin relies on; a daily
CI job runs galopin's real-opencode suite against each new release
(`agent/README.md`, "opencode releases"). `galopin run` supervises
`opencode serve`, and it is the only runtime dependency. opencode is a
separate open-source project (MIT licence) installed from its own
installer; Cerea does not redistribute it and is not affiliated with it.

With the installer above, skip to `enroll`. From a build of your own:

```sh
install -d ~/.local/bin
install -m 0755 galopin-darwin-arm64 ~/.local/bin/galopin   # the file for this OS/arch
xattr -d com.apple.quarantine ~/.local/bin/galopin 2>/dev/null || true   # macOS only

~/.local/bin/galopin enroll \
  --issuer "$OIDC_ISSUER" \
  --gateway "$GATEWAY_BASE_URL" \
  --cerea "$CEREA_BASE_URL"
~/.local/bin/galopin run
```

`enroll` opens your browser to sign in (or prints a link and code to open on any device, your phone included), asks which billing group to use if you have several, and writes two files: the opencode config, by default
`<config-dir>/galopin/opencode.json` (beside the credential, whatever directory
you ran `enroll` from; `--output` moves it), and a
refresh credential (mode 0600, default `<config-dir>/galopin/credentials.json`,
where `<config-dir>` is `~/.config` on Linux and `~/Library/Application
Support` on macOS). `enroll` records the opencode config's absolute path in
the credential file, and `run` finds it there and hands it to opencode, so
neither command needs a path. `run` then supervises opencode and dials out to the
chat. Open the sidebar's **Agents** panel: the machine is listed as **Pending** until you confirm it with the green check (**Confirm this machine**).

| Flag             | When                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--cerea …/chat` | always include `/chat` when the chat is served there. The machine dials `<cerea>/api/v2/code/machine`, and without the base path it reaches the gateway instead                                                                                                                                                                                |
| `--output PATH`  | where the opencode config goes (default `<config-dir>/galopin/opencode.json`). The file is **replaced whole**: `enroll` asks before replacing an existing one, and `--yes` skips the question. Its absolute path is recorded, so `run` finds it. Never point it at your own `~/.config/opencode/opencode.json` unless you mean to replace that |
| `--device`       | force the device flow, which prints a URL and a code to open on any other device (the bundled Authelia's `opencode-enrollment` client allows it). Without a flag, `enroll` picks the loopback sign-in in the local browser when there is a display, and the device flow when there is none. `--loopback` forces the browser                    |
| the policy flags | `--no-terminal`, `--permission-max KEY=ACTION`, `--allow-free-models`, `--workspace-root PATH` and the rest are the machine's own vetoes, fixed at enroll time, and all of them are in the pairing dialog: see [The machine policy](#the-machine-policy)                                                                                       |

### With GitLab as the identity provider

GitLab mints its own application ids, so the default machine client
`opencode-enrollment` cannot exist there. Signing in with it ends on GitLab's
page with _Client authentication failed due to unknown client_. Set it up
once:

1. On GitLab, add an application for agent machines: **not confidential**
   (galopin has no secret), scopes `openid profile email`, the device
   authorization grant enabled, and redirect URI `http://127.0.0.1/callback`
   (used only by the browser flow on a laptop).
2. In the kit's `.env`, set `OIDC_MACHINE_CLIENT_ID` (or run `./configure --machine-client-id`) to that application's
   **Application ID**, then `docker compose up -d`. The gateway then accepts
   the machine's tokens, and the pairing dialog prints `--client-id` with it.
3. Enroll with the dialog's command, or by hand with
   `--client-id <Application ID>`.

GitLab's access tokens are opaque, not JWTs, so neither the chat nor the
gateway can check their signature. Both ask GitLab instead, at its
`/oauth/token/info`, with the token itself: it must belong to the machine
application and expire. The chat does this when a machine connects (from
0.10.14; before, a GitLab machine's link was refused with HTTP 401 right
after a successful enroll), and the gateway on every `/v1` call (Pystino 0.4.2).

GitLab's discovery lists the device grant but does not advertise its device
endpoint. galopin uses `<issuer>/oauth/authorize_device`, GitLab's, and says
so (`note: the identity provider does not advertise a device endpoint; using
…`); a headless box needs no `--loopback`. For any other provider that leaves
the endpoint out, name it with `--device-endpoint URL`.

A machine enrolled before `enroll` recorded the path has no `opencode_config` in
its credential file, and `run` says so on stderr: the supervised opencode may
have no pystino provider, so the panel reports that the daemon lists no models.
Re-run `enroll`, or pass `run --opencode-config PATH` with the opencode.json
`enroll` wrote.

If `enroll` warns that model discovery failed, no model is available to you
yet. Ask your administrator to grant your group one, then run
`galopin models refresh` — or just restart `run`, which re-discovers the
gateway's models at every start. Neither re-enrolls, so the machine id stays.

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

### Which scopes `enroll` asks for

`enroll` asks for `openid profile email groups offline_access`, narrowed to
what the issuer's discovery lists in `scopes_supported` (`openid` always stays;
without a list, all five are asked for). Some providers, Infomaniak among them,
answer `invalid_scope` to a scope they do not list, and publish `groups` as a
claim only. `enroll` prints a note when it leaves something out.

`offline_access` is how most IdPs are told to issue a refresh token. One that
does not list it but lists the `refresh_token` grant is asked without it, and
`enroll` checks the token response: **no refresh token means no enrollment**.
It stops with "the IdP issued no refresh token … so this machine could not
stay signed in" rather than write a machine that would lose its sign-in
within the hour. Enable refresh tokens for the `opencode-enrollment` client at
the IdP, then enroll again. Without a `groups` scope, billing by group needs
the IdP to put a groups claim in its tokens anyway (the gateway's
`--oidc-groups-claim`).

### When the refresh token dies

A gateway or IdP redeploy can revoke the refresh token the shim holds. That
is expected and recoverable — sign in again with `galopin auth login` (only a
machine revoked in the `/code` panel needs a re-enroll) — but the failure has
to be fast and legible, not a 502 that opencode's client quietly retries into
a long hang:

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
- **The dead state is not for ever.** Once the shim has latched `expired` it
  answers from that verdict instead of hitting the IdP again — but
  `galopin auth login` rewrites the credential file's token fields under the
  same lock the shim refreshes under, and the shim notices the newer file on
  its next request or 15-minute tick: it adopts the new tokens, clears the
  verdict and serves again, with no restart.

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
`audit.log` — live in `<config-dir>/galopin/`, and so does the `opencode.json`
`enroll` writes by default (its path is recorded in `credentials.json` as
`opencode_config`, which is how `run` finds it). opencode's own config,
`~/.config/opencode/opencode.json`, is left alone.

`audit.log` is the local record of terminal opens/closes and policy
refusals — rotated JSON lines, never a byte of keystrokes, output, or file
content. It is the one record of a machine's `/code` activity that Cerea
itself cannot rewrite.

`opencode-tmp/` there is opencode's TMPDIR while galopin supervises it,
emptied on every (re)start: opencode is a Bun binary that extracts its
native libraries (~5 MB) into TMPDIR on each start and never removes them,
which on a machine whose `/tmp` is tmpfs slowly fills RAM.
