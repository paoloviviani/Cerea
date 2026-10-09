# The `/code` panel: operating it

!!! info "For operators"

    Deploying and running the Agents panel; people using it want [Agent machines](agent-machines.md).

The Agents panel drives **coding agents running on people's own machines**
from the chat's sidebar. The agent (opencode, or any ACP agent) runs on the
person's machine under **galopin**, a single binary built from this
repository's `agent/`. galopin dials **out** to the deployment over WSS and
authenticates with its own OIDC credential. The deployment runs no model and
stores no code for it.

This page is for operators. The person using the panel wants
[Agent machines](agent-machines.md) instead.

## What gets deployed

Nothing extra. The machine link is one WebSocket endpoint
(`GET /api/v2/code/machine`), served by the chat process itself. There is no
relay, no extra container and no extra port. The chat also serves the galopin
binaries and their checksums at `<base>/galopin/`, with an installer at
`<base>/galopin/install.sh`.

## Turning it on

In the deploy kit: `./configure --agents` at install time, or
`./configure --set CODE_AGENTS_ENABLED=true` on an existing install, then
`docker compose up -d`.

| Variable                      | What                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `CODE_AGENTS_ENABLED`         | `true` shows the Agents switch and serves `/code`; anything else hides it and `/code` answers 404 |
| `CODE_TERMINAL_ENABLED`       | `true` allows browser terminals on machines that also allow them (below); off by default          |
| `CHAT_SCHEDULES_ENABLED`      | on with the panel; exactly `false` is the kill switch for scheduled actions (below)               |
| `CHAT_SCHEDULES_MAX_PER_USER` | how many schedules one person may have; default `20`                                              |
| `CODE_MACHINE_ISSUER`         | the issuer a machine's token must come from; defaults to the chat's own (`OPENID_PROVIDER_URL`)   |
| `CODE_MACHINE_AUDIENCE`       | the audience a machine's token must carry; default `pystino-api`                                  |
| `CODE_MACHINE_CLIENT_ID`      | the client a machine's token must be issued to; default `opencode-enrollment`                     |

The last three only need setting when machine tokens come from somewhere
unusual; the deploy kit's defaults match its bundled Authelia.

## Setting up a machine

On the machine, with `<origin>` the deployment's origin:

```sh
curl -fsSL <origin>/chat/galopin/install.sh | sh
galopin enroll --issuer <origin>/authelia --gateway <origin> --cerea <origin>/chat \
  [--no-terminal] [--permission-max KEY=ACTION] [--workspace-root PATH] …
galopin run
```

The pairing dialog prints this as one command, one step per line, calling the
installed binary as `~/.local/bin/galopin`. With its **Install opencode** box
ticked it adds opencode's own installer, pinned to the release galopin is tested
against (`agent/packaging/opencode-version`), before `enroll`.

The installer checks the binary against the deployment's `SHA256SUMS` and
refuses a mismatch. The machine then appears in the panel as **pending**
until its owner confirms it.

`galopin run` in a terminal stops when the terminal closes. To keep it running,
the machine's owner installs it as a systemd user unit on Linux or a
LaunchAgent on macOS ([Keeping it running](agent-machines.md#keeping-it-running));
after updating galopin, `systemctl --user restart galopin` picks up the new
binary.

## Two vetoes: the machine's and the deployment's

The machine's owner decides at enroll time what the machine allows (files,
terminals, the permission ceiling, slash-command shell, models from elsewhere,
workspace roots). The panel's **Pair a machine** dialog offers every one of
those flags, so nobody edits the printed command by hand. Those settings are stored on the machine, and the chat can never
loosen them over the link. The table of every flag, its default and what it
decides lives in one place, [The machine policy](agent-machines.md#the-machine-policy);
the owner can tighten a machine later without re-enrolling, but loosening
needs a new enrollment.

**The terminal needs both sides to say yes.** The machine allows it unless it
was enrolled with `--no-terminal` (a machine enrolled before terminals were on
by default needs enrolling again), and the deployment must set
`CODE_TERMINAL_ENABLED=true`.
Everything in /code needs a sign-in within the last 7 days; the machine's own
link is unaffected (see below). A terminal also re-checks that every minute.
An open terminal is an ordinary shell running as the machine's owner:
**anyone who controls that person's Cerea session can run commands on the
machine**, with no model and no permission rule in between. Enable it only
where that is acceptable. Both sides record terminal opens and closes, never
their content.

## The 7-day sign-in

Everything in /code needs a sign-in within the last 7 days
(`src/lib/server/code/stepUp.ts`); the machine's own link is unaffected. It is
one deny-by-default guard in `hooks/handle.ts`: every request under
`/api/v2/code/` except `GET /api/v2/code/status` answers
`401 {code: "reauth_required"}` while the session's `authTime` is older than the
window, or missing (the hook reads it off the session document it already
loaded, with no extra query). A route added under that prefix later is
protected without anyone remembering to; the guard spec fails if one appears
that it has not been told about.

`/status` is the one open route. It returns only
`{enabled, signedIn, fresh, reauthPath, signInPath}` plus `freshUntil` when
fresh, and nothing derived from a machine: no names, counts or inbox badge.
`reauthPath` is a `/login?reauth=1&next=/code` path (with the app base) for the
**Sign in** button; `signInPath` is the same destination without the force, for
a caller with no session at all. A session can be unusable two ways, and the
panel says which: **stale** (signed in, older than 7 days) gets the forced
re-login, **signed out** (no session at all — the ordinary expiry of a chat
without a refresh token) gets the plain sign-in, which the identity provider's
own SSO session answers silently. A signed-out open tab leaves for that plain
sign-in by itself (guarded against a loop: a redirect that already happened in
the last minute is not repeated, and the card shows instead); with
Authelia's bundled session settings, ticking **Remember me** at sign-in is what
makes that re-login silent — without it the provider asks for the password
again after an hour regardless of Cerea.

Three things the hook cannot see, each handled where it lives: the machine link
and the terminal socket are WebSocket upgrades that bypass hooks (the terminal
re-checks freshness in its own 60-second loop and closes with `4403
reauth_required`), and an event stream opened while fresh ends itself with a
`reauth_required` frame at `authTime + 7d`. The page asks `/status` on load, and
a shared `codeReauth` store flips on any `reauth_required` answer or on a
`freshUntil` timer: the panel then closes its streams, drops its in-memory
machine state and shows one card. The Needs-you inbox goes dark with the rest,
which is the price of the guard covering every route.

## How machines are trusted

- **Tokens are checked locally.** A machine's access token is verified
  against the issuer's keys (JWKS): the issuer, the audience, the authorised
  client and the expiry must all match, and ID tokens are refused. The
  token's subject must belong to someone who has signed in to this chat; if
  not, the connection is refused.
- **A person confirms each machine.** The first connection creates a
  _pending_ device. Nothing is sent to it until its owner clicks **Confirm**
  in the panel. **Reject** and **Revoke** tombstone the device: that machine
  id is refused from then on, its connection is closed, and galopin revokes
  its own refresh token and exits.
- **The browser never talks to a machine.** Every browser request goes to
  the chat, which maps each allowed path onto exactly one machine operation,
  after checking that the device belongs to the caller.

## What the chat stores

- **Pairing records** (the `codeDevices` collection): a name, the machine id,
  the token subject and issuer it last used, the capabilities and policy it
  reported, and its credential health. None of it can reach a machine; only
  a live connection can, and those are held in memory.
- **Files attached** to agent messages, in the chat's attachment store, so
  they still show after a reload. They are deleted when the device is.

Everything else (workspaces, sessions, transcripts, the code) stays on the
machine. That includes **images a tool produced** (a browser tool's
screenshot, an image the agent read): the panel fetches each from the machine
whenever it is shown, and the chat keeps no copy.

## What the panel does

An affordance shows only when the session's backend reports the capability,
and the machine's policy can still refuse it.

| Feature                      | What the person sees                                                                | How it works                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcript                   | the chat's message column, opened at the newest message                             | One subscription replays the session's whole log (`session.sync`) and then tails it live. The replay folds behind a **Loading conversation…** skeleton, and the transcript renders once, landed at the bottom — a long session never renders progressively from the top, and nothing is scrollable while it loads, so a scroll during the load cannot strand the reader away from the newest message. After that, live turns stick to the bottom as anywhere in chat, until the reader scrolls up. The replay's end is a `historyDone` marker frame the bridge emits (Cerea-internal, no machine involvement).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Modes and models             | pills in the composer                                                               | Live lists (`backend.modes` / `backend.models`). Non-gateway models (anything outside `pystino/*`) are hidden unless the machine was enrolled with `--allow-free-models`. The agent filters them and reports how many it hid; Cerea filters again and answers 403 to a disallowed set or create (`src/lib/server/code/modelPolicy.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Permission selector          | a **Deny · Ask · Allow** selector in the composer's pill row, and its note          | **The machine's word, never a guess.** `GET v1/agents/:id` carries `permissionMode` (`session.get`; a subagent reports its root's); the selector shows it, and `POST v1/agents/:id/permission-mode {mode}` (`session.setPermissionMode`) sets it, after which the view re-reads the snapshot and `permission.rules` rather than claim the new word from the click. A bad mode is a 400 here; the machine answers `invalid` for a subagent's id (it follows its root) and `not_found` for an unknown session, and both come back as their HTTP statuses. Under Allow the note names what `permission.rules`'s `ceiling` still holds back (_Allow · bash asks (machine limit)_). Disabled on a subagent's view, hidden on a machine that sends no `permissionMode` and while the sign-in is stale. The change is audited here as `permission.mode` (session and mode). New sessions start on **Ask**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Permissions                  | chat's approval card, and a **Permissions** item in the Agents sidebar              | **opencode's permission rules decide; Cerea shows their asks.** `permission.asked` becomes the card; Allow once / **Always allow (this session)** / Deny become `permission.reply` once / always / reject, for galopin's own `gp_` asks and opencode's alike. "Always" adds a per-session **exception** (the machine answers opencode "once" and stores it itself), and the card does not offer the button for a key the ceiling holds below allow (it would store nothing). The item reads `GET v1/agents/:id/permission-rules` (`permission.rules`) — the session's rules in evaluation order, the ceiling and the session's **Exceptions** — and opens the same content in a dialog, so the transcript stays in view: one plain row per capability (_Allowed_ / _Asks first_ / _Blocked_, with _limited by this machine_ where the ceiling holds it down), the exceptions as _Allowed for this session: …_ with Remove, and the raw rules behind a troubleshooting disclosure, where a rule from the person's own config that Cerea or the machine replace reads _overridden by Cerea_ (the match is literal, so a broader glob is not worked out). `DELETE v1/agents/:id/permission-approvals/:id` (`permission.saved.remove {id, sessionId}`) removes one exception, so that command asks again, and can only tighten; it is audited here (session and exception id, never patterns) and on the machine. There is no free-form rules writer. No route reaches the ceiling, the machine's own rules or its policy. The selector and Remove sit behind the stale-sign-in guard like every other route under `/api/v2/code/`. |
| Questions                    | the SAME card chat's own `ask_user_question` uses, lifted to the composer           | `question.asked`/`question.resolved` (opencode's built-in "question" tool, the `questions` capability), each `Question` normalized to one `select` field via `AskQuestion.svelte`'s `onanswer` prop; `POST v1/agents/:id/questions/:requestId` translates accept/decline into `question.reply` answer/reject. Not offered when the backend's capability is false (ACP: always).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Stop                         | chat's stop button                                                                  | `session.cancel`; an abort ends the turn normally, it is not shown as a failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Usage and context            | a ring in the composer (`ContextMeter.svelte`)                                      | The `usage` side channel: a percentage when the model's context window is known, otherwise a token count; "Compact now" calls `session.compact`. No cost is shown: Pystino's own ledger is the spend authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Changes                      | the Changes side pane                                                               | `session.diff`, which asks git for the workspace's uncommitted changes (untracked files included, capped) rather than trusting a backend's own diff, which misses files a shell command wrote.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Subagents                    | a card at the task call that spawned it, expandable into the child's own transcript | `session.children`, each child carrying `parentToolCallId`; children are not listed as sessions of their own. A background child (`background:true`, unless the machine was enrolled with `--no-background-subagents`) outlives its parent turn — the strip says so — and its result folds into an automatic marker; a `task_id` resume reads as a follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Sessions talking to sessions | "Spawned …" / "Sent to …" / "Read …" cards, linked to the other session             | `session_spawn` / `session_send` / `session_read` tool calls (agent-tools). Whether each asks is decided by the machine's own rules for the asking agent (`session_spawn` / `session_send` / `session_read`), or by a grant a schedule gave the session: allow shows an **allowed by this machine's rules** badge and no card, deny refuses, ask or no rule raises a card. See [Sessions that talk to sessions](agent-machines.md#sessions-that-talk-to-sessions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Images and files             | the chat's attach picker, chips and rendering                                       | See [Attachments](#attachments-what-a-surface-uploads-keeps-and-renders) below. Offered when the backend advertises `files` or `images`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Forks                        | "Fork from here" on a finished assistant message                                    | `POST v1/agents/:id/handoff`: a new session (same machine or another of the person's paired machines, any allowed mode/model), prompted with the person's text plus, optionally, the conversation up to that turn as a `chat-history.md` attachment. The new session is titled `Fork: …` (older forks: `Handoff: …`) and says where it came from.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Retry and rollback           | ↻ on an answer, or editing a prompt (when the machine reports `revert`)             | `POST v1/agents/:id/revert {messageId}` rolls the session back to before that prompt (opencode `POST /session/:id/revert`), then the prompt (or the edited text) is sent again. The confirmation says whether files come back: opencode restores them from its snapshots in a git repository only. `POST v1/agents/:id/unrevert` undoes it before the next prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Workspaces and worktrees     | path autocomplete in "Add workspace"; "New worktree…" on a git workspace            | `workspace.suggest` (inside the machine's `workspaceRoots`, or `$HOME` with none) and `workspace.create {worktree}` (`git worktree add`, branch and base of the person's choosing); archiving a worktree workspace can also remove the worktree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

!!! warning "What the coordination gates do not cover"
An approved shell command can do anything you can on that machine
(opencode's server password sits in its process environment, readable by
same-user processes); the coordination gates constrain the model's tools,
not an approved shell. See
[Sessions that talk to sessions](agent-machines.md#sessions-that-talk-to-sessions).

### Tool images (the `toolImages` capability)

When a tool call produces an image, its card shows it under "Output". The
machine lists the image on the tool part (a sha256, a type and a size) and
keeps the bytes: galopin holds up to 64 MiB of recent tool images, and for
opencode an older one is re-read from opencode's own history. A person's
browser asks the chat for the image, the chat asks the machine, and the answer
is cached in the browser only.

- **Only PNG, JPEG, GIF and WebP are shown, inline as images.** SVG is never
  displayed inline, whatever the machine calls it.
- **The chat does not take the machine's word for the type.** It checks the
  file's own header, refuses anything over 8 MiB or past about 50 megapixels
  (a tiny file can decompress to gigabytes), and refuses bytes that do not
  match the checksum the tool part listed. Seeing a broken image usually
  means the machine no longer has it: an ACP agent keeps images in memory
  only, so a galopin restart loses them.
- Up to 8 images are shown per tool call. An image the agent saved as a file
  is the file explorer's, not this.

### Slash commands (the `commands` capability)

The machine lists each workspace's slash commands (`backend.commands`):
name, description, where the definition lives (the agent's own `init`/
`review` are `builtin`; a name only the workspace list reports is
`project` — repository code, listed only when the machine was enrolled with
`--allow-project-config`; by default a repo's own opencode config is
ignored), whether its template expands shell, the
exact snippets it would run (at most ten, each truncated), the `@path`
files it reads, and a hash of the template. **The template itself never
crosses the link** — the snippets and the hash are what a person confirms
against.

`session.command` runs one behind the machine's gates, each refused before
anything runs and each audited in the machine's own `audit.log` as
`command {name, origin, shell, decision}` — never the arguments, never the
expanded text:

- unknown name → `not_found` (the list is re-read at run time, never
  trusted from an old menu);
- the panel's confirmation carried a `templateHash` that no longer matches
  → `conflict` (the definition changed since it was reviewed);
- `commandShell: denied` (the default) and the template expands shell — or
  its shell behaviour is unknown (MCP prompts, ACP commands) → `forbidden`;
- an `@path` ref matching `fileDeny` → `forbidden`;
- a command pinned to a non-gateway model with `allowFreeModels` denied →
  `forbidden` (the same gate `session.setModel` applies);
- a command naming a more permissive agent while the session sits in a
  more restrictive mode → the session's mode is sent instead and the
  command's agent ignored; a `subtask` command in that spot is refused
  outright (it would run unsupervised in the other agent).

The capability is probed, never versioned: opencode advertises `commands`
only when its own `GET /doc` lists the operation (cached per process,
re-probed on restart). Cerea maps a 404 to "panel commands only".

The panel's first run of a project or shell-expanding command opens a
confirmation sheet (snippets, file refs, "running a project command is
running repository code"), remembered per device in `localStorage` keyed
by the template hash; a later run whose hash differs answers the 409 above
and the sheet re-asks.

A machine can run an ACP agent instead of opencode (`galopin run --backend acp
--acp-command "<agent>"`): Gemini CLI, Claude Code or Codex through their ACP
adapters, or `opencode acp`. Those report fewer capabilities (no usage,
compaction or subagents), and the panel hides the matching controls.

## Scheduled actions

People can put a prompt on a timetable: **Schedules**, under the devices in the
Agents sidebar. A schedule names a machine, a workspace on it and either "a new
session each run" or one existing session, and sends its prompt at the times
set (every N hours, daily, weekdays, weekly, or a cron expression; at least 15
minutes apart; read in the schedule's timezone, DST included).

**What runs where.** The scheduler is a loop inside the chat process (every 30
seconds). It claims a due schedule atomically in MongoDB, so two chat instances
never fire the same run, and it moves the next run forward _before_ it runs
anything. The run itself is the panel's own operations over the machine link:
create a session, set its Deny / Ask / Allow word, (optionally) grant its
coordination tools, send the prompt. **Nothing runs in the chat**; the session
is the machine's, and it pays for the run with its own credential, as for any
other prompt.

Every scheduled prompt starts with one line the person did not write:
`[Scheduled run of "<name>", <timetable> (<timezone>); previous run <3 h ago | none>; coordination: <keys granted | none>]`,
then a blank line and the prompt as written. It tells the agent nobody is
watching live, when it last ran and which session tools it may use without a
card, so it can avoid repeating itself across runs. galopin's
[delegation skill](agent-machines.md#the-delegation-skill) tells the model how
to read that line (`src/lib/server/schedules/runHeader.ts` writes it).

**Rules the operator should know.**

| Situation                                   | What is recorded                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| the machine is offline at run time          | `missed-offline`; nothing is queued                                                               |
| the machine was revoked                     | the schedule is switched off, with the reason shown on it                                         |
| the previous run's session is still working | `skipped-still-running`                                                                           |
| the workspace or pinned session is gone     | `failed` with that reason; three failures in a row switch the schedule off                        |
| the chat was down when a run was due        | one catch-up if it is under half the interval late (at most an hour); otherwise `missed-downtime` |

Every occurrence, fired or not, is a row in `scheduleRuns`: that is the
history people see per schedule and the audit record. Rows are kept 90 days.

**The Ask warning.** Unattended, a session on **Ask** stops at its first
approval and waits. The approval card appears in the Needs-you inbox. The
editor says so beside the selector. **Allow** is for work that must finish on
its own, and it is still capped by the machine's own ceiling (a key the machine
caps at Ask still asks).

**Working with other sessions.** Two options in the editor, both off:
**Can find, read and message other sessions** (`session_list`, `session_read`,
`session_send`) and **Can start new sessions** (`session_spawn`). They let an
unattended run orchestrate the machine's other sessions without stopping at an
approval card. At each run, after the session is created or chosen and before the
prompt, Cerea sends the machine `session.grantCoordination {sessionId, keys}`
(see [Granting a session its coordination tools](agent-machines.md#granting-a-session-its-coordination-tools)).
The grant is the machine's to limit: a key its ceiling caps at Ask still asks
(the card waits in the Needs-you inbox, and the editor says so), another
workspace's sessions still ask, the hop and rate limits stand. A galopin that
predates the op is not an error: the run goes ahead without the grant and its
row says "this machine's galopin is too old to grant coordination; update it"
(the editor shows the same warning once such a machine is chosen; a machine
enrolled with `--no-agent-tools` says so instead). A schedule pinned to one
session sends the grant each run, and when its options are turned off the next
run takes the grant back (`keys: []`).

**Schedules made by agents.** A coding session can list, create, update, pause
and delete schedules on its own machine through galopin's schedule tools (see
[Scheduling work](agent-machines.md#scheduling-work) for when those ask). They
are `call` frames on the machine link, answered by `server/code/machineCalls.ts`
as the machine's owner: Cerea's `welcome` advertises
`features.machineCalls: ["schedule"]`, and a galopin with the tools reports
`scheduleTools` among its backend capabilities. The ops are `schedule.context`
(is the caller's session, or its root, a run of a schedule: looked up in the
run records), `schedule.list`, `schedule.create`, `schedule.update` and
`schedule.delete`. On top of the store's rules (floor, cap, timezone, switch),
Cerea refuses:

| Refused                                                                  | Answer        |
| ------------------------------------------------------------------------ | ------------- |
| another machine as the target, or a workspace not on this one            | `invalid`     |
| a permission mode looser than the calling session's (deny < ask < allow) | `forbidden`   |
| coordination the calling session does not have itself                    | `forbidden`   |
| a sixth running agent-made schedule on the machine                       | `limit`       |
| an eleventh change in an hour from the machine (pause and delete exempt) | `limit`       |
| updating or deleting another machine's schedule                          | `not_found`   |
| anything but `schedule.context` while `CHAT_SCHEDULES_ENABLED=false`     | `unavailable` |

A new prompt, a new target or switching a schedule back on is checked against
the caller too, so an Ask session cannot rewrite a person's Allow schedule. A
created schedule's timezone defaults to that of the person's most recent
schedule (there is no per-person setting), else UTC; `session: "this"` pins the
caller's root session. `agentMode` (`plan` or `build`, the executor's `modeId`)
defaults to `build` on create and is not bounded by the caller: the permission
word is what bounds a run. The row records `createdBy: {kind: "agent", deviceId,
workspaceId, sessionId, title}`, the list and the editor show **Created by an
agent in ‹session›** linking to it, and each change is a `schedule.create` /
`schedule.update` / `schedule.delete` row in `codeAudit` with the session id
(refusals as `<op>.refused` with the code). A person's schedules look as before.

**Limits and the switch.** `CHAT_SCHEDULES_MAX_PER_USER` (default 20) caps a
person's schedules. `CHAT_SCHEDULES_ENABLED` is on unless exactly `false`, and
only matters where `CODE_AGENTS_ENABLED=true`: a deployment that has turned on
remote agents has already accepted what agents can do, each schedule is
something a person built, and the default permission word is Ask. Off stops the
loop, answers the API 404 and hides the sidebar entry; schedules are kept, and
whatever came due meanwhile is judged by the downtime rule above rather than
replayed. Schedules are owner-only, erased with the account and moved on a merge.
The API is under `/api/v2/code/schedules`, so the 7-day sign-in rule covers it.

## When it does not work

| Symptom                                                | Where to look                                                                                                                                                                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no Agents switch in the sidebar                        | `CODE_AGENTS_ENABLED` is not exactly `"true"`, or the person is not signed in                                                                                                                                                                |
| `/code` answers 404                                    | same flag; the route gates on it independently of the sidebar                                                                                                                                                                                |
| a machine never appears, even `pending`                | its bearer is failing local validation — check `CODE_MACHINE_ISSUER`/`CODE_MACHINE_AUDIENCE`/`CODE_MACHINE_CLIENT_ID` match what the enrollment minted, and that the machine's `sub` has signed into this chat at least once                 |
| a machine appears `pending` forever                    | its owner hasn't clicked **Confirm** yet; only the owner can, from their own signed-in panel                                                                                                                                                 |
| every call to a paired machine answers "not connected" | the machine's process is not running, or its WSS dial to this origin is failing (check its own logs)                                                                                                                                         |
| a machine that was working now gets `4401` closes      | its access token stopped renewing — re-run its enrollment                                                                                                                                                                                    |
| a schedule never fires                                 | `CHAT_SCHEDULES_ENABLED=false`, or `CODE_AGENTS_ENABLED` is off; or its history says why (offline, skipped, switched off after three failures)                                                                                               |
| a terminal will not open                               | the deployment lacks `CODE_TERMINAL_ENABLED=true`, the machine was enrolled with `--no-terminal` (or before terminals were on by default), or the person's last sign-in is older than 7 days (which blocks all of /code, not only terminals) |

## For developers

The wire protocol between the chat and galopin is `agent/PROTOCOL.md`.

### Attachments: what a surface uploads, keeps and renders

The images and files a person sends an agent live in **chat's attachment
store**: the same GridFS bucket (`files`), the same writer, the same limits
and the same once-at-upload document extraction as a chat message. There is
no second store. Only the owner tag differs. A chat file is tagged with its
conversation id; an agent file is tagged with an **owner key**:

```
code:<deviceId>:<sessionId>
```

`deviceId` is the `codeDevices` row (24 hex characters). `sessionId` is
whatever id your backend gives the session, `[A-Za-z0-9_.:~-]{1,200}`, and
nothing interprets it. The store itself (`src/lib/server/files/attachmentStore.ts`)
is surface-agnostic: any key of the form `<surface>:<rest>` works. A
conversation id never contains a colon, so an owner key can never reach a
chat's files, and chat's routes can never reach an owner-keyed file.

Nothing here depends on the agent transport. The contract is only the key and
a `messageId` that you choose.

#### 1. Upload before you send

Pick a `messageId` for the outgoing message (for example the client message
id you will hand the agent), then upload its files:

```
POST /api/v2/code/attachments/<urlencoded key>
multipart/form-data: messageId=<id>, files=<File> (repeat, at most 10)
→ superjson { files: MessageFile[] }
```

The rules:

- **Limits.** 10 MB per file (`MAX_ATTACHMENT_BYTES`, chat's limit), which
  answers 413. The declared type must match `AGENT_ATTACHMENT_MIME_ALLOWLIST`
  (chat's text and document lists, png/jpeg/gif/webp, and chat's long-paste
  type `application/vnd.chatui.clipboard`, which a transport should treat as
  `text/plain`). Anything else answers 400.
- **Documents.** PDFs and office files are extracted once, at upload, through
  the gateway and billed to the caller, exactly as in chat. The returned
  `MessageFile.extracted.value` is the sha of the markdown.
- **Ownership.** The key's device must be one of the **caller's paired**
  devices. Somebody else's device, or one that does not exist, answers 404;
  a pending device answers 409; a malformed key answers 400.

From the browser, `uploadComposerFiles(endpoint, messageId, files)` in
`$lib/utils/composerFiles` does this and throws the server's message on
refusal.

#### 2. Keep the `MessageFile` references

Each `MessageFile` is `{type: "hash", value: <sha256>, mime, name,
extracted?}`, the same shape as a chat message's `files`. Put them on the
user message you render. After a reload you can get them back from either
side:

- **Server** (for example your bridge, when it replays a user frame):
  `findAttachments(key, messageId)` from `attachmentStore.ts`. It returns the
  same `MessageFile[]`, in upload order, with extracted text folded in.
- **Browser**: `GET /api/v2/code/attachments/<key>?messageId=<id>`, which
  returns superjson `{ files: MessageFile[] }`.

To hand bytes to the agent, the server calls `readAttachment(sha, key)`,
which returns the base64 value and the sniffed mime.

#### 3. Render them

`ChatMessageColumn` and `ChatMessage` take an optional `fileBaseUrl`, which
`UploadedFile` uses for user files as `<fileBaseUrl>/<sha>`. Pass:

```ts
fileBaseUrl = `${base}/api/v2/code/attachments/${encodeURIComponent(key)}`;
```

That route (`GET …/<key>/<sha256>`) makes the same device check, then serves
the bytes with chat's headers: `Content-Disposition: attachment` and a
sandbox CSP. An `<img>` still displays it; opening it in a tab downloads it.
Leave the prop unset on chat. Chat's page-relative
`/conversation/<id>/output/<sha>` is the default and has not changed.

#### The composer pieces

Chat's attachment affordances are reusable pieces, and each takes your own
MIME allowlist:

- **picking**: `ChatInput`, with `mimeTypes` set and a bindable `files`. An
  empty `mimeTypes` hides the button, which is what `AgentComposer` does
  today;
- **pasting**: `pastedAttachments(clipboardData, {mimeTypes, directPaste})`,
  which turns a long paste into a clipboard chip and filters pasted files;
- **dropping**: `FileDrag` (`$lib/utils/fileDrag.svelte`) on
  `<svelte:window ondragenter ondragleave>`, plus `FileDropzone` with
  `bind:onDrag={drag.active}`;
- **chips**: `ComposerFileChips`, with a bindable `files`.

`ChatWindow` wires the same pieces for chat.

#### Cleanup

`DELETE /api/v2/code/devices?id=` deletes every file under `code:<deviceId>:`
after it tombstones the row (`deleteCodeDeviceAttachments`). Deleting one
session's files is `deleteAttachments(key)`. Nothing calls that yet, so call
it when your backend deletes a session. The deletions match on
`metadata.conversation`, never on the filename, and a prefix must end at a
`:`, so `code:abc:` never matches `code:abcdef:…`.
