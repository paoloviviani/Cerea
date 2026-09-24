# Agent machines: setting one up, and driving it

The Agents panel in the sidebar drives coding agents that run **on your own
machine**, not here. Your code never leaves it; the chat is a remote control.
This page is both halves of that: getting a machine paired, and what the panel
does once it is.

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
│ pystino-agent ─────────┼─ outbound ┼──── WSS ───────────────────▶
└───────────────────────┘            └───────────────────────────┘
```

One binary, one credential. `pystino-agent` supervises `opencode serve`,
dials **out** to this deployment over WSS and authenticates with the same
OIDC access token its enrollment minted — the identical credential that
authenticates its `/v1` calls to the gateway. There is no relay and no daemon
process to run separately: revoking your account at the identity provider
kills both the control link and the LLM link within one access-token
lifetime.

## Pairing a machine

On the machine:

```bash
pystino-agent enroll --cerea <this deployment's origin>
pystino-agent run
```

`enroll` signs the machine into your account through this deployment's
identity provider (the same login the chat uses) and writes a local
credential; `run` starts the agent, which dials out here and appears in the
sidebar's **Agents** panel, in **Pending**, as soon as it checks in.

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
`pystino-agent enroll` mints a **new** machine id — it re-pairs as a fresh
`pending` row, not a resurrection of the revoked one.

## What is kept where

|                                                             | Where it lives                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| your code, your working tree, the session's live transcript | your machine                                                    |
| the pairing record — name, machine id, policy, owner         | the chat's database                                             |
| prompts, replies, file contents                              | in flight only, over your machine's own outbound TLS connection |
| your LLM spend                                               | the gateway's ledger, against your account and billing group    |

Pairing records are scoped to you: nobody else's panel can see or revoke your
machines.
