# Agent machines: setting one up, and driving it

The Agents panel in the sidebar drives coding agents that run **on your own
machine**, not here. Your code never leaves it; the chat is a remote control.
This page is both halves of that: getting a machine paired, and what the panel
does once it is.

If you are deploying the feature rather than using it, read
[The `/code` panel](code-panel.md) first — none of this works until the relay
is up and `CODE_AGENTS_ENABLED=true`.

## The shape of it

```
your laptop                          the deployment
┌──────────────────────┐             ┌───────────────────────────┐
│ opencode             │──── /v1 ───▶│ the gateway (bills you)   │
│   ▲                  │             │                           │
│   │ local shim       │             │ Cerea ───▶ relay ─┐       │
│ paseo daemon ────────┼── outbound ─┼──────────────────▶┘       │
└──────────────────────┘   WebSocket └───────────────────────────┘
```

Two independent links, and they are worth keeping apart in your head:

- **the LLM link** — opencode talks to the gateway's `/v1`, and the spend lands
  on _your_ account and your chosen billing group. Set up by the enrollment,
  which is the gateway repository's half.
- **the control link** — the paseo daemon dials **out** to the relay and stays
  connected. The chat reaches your machine through it. No port is opened on
  your machine, and nothing needs to know your address.

The relay only bridges the two ends of a WebSocket. The traffic between Cerea
and your daemon is encrypted end to end (Curve25519/NaCl), so the relay sees
ciphertext and never a token, a prompt or a line of your code.

## Pairing a machine

In the sidebar, switch to **Agents** and use **Pair a device**. Name the
machine, and the dialog prints the three commands to run on it:

```bash
git clone https://github.com/paoloviviani/Pystino.git
cd Pystino/deploy/opencode
./setup-agent.sh --relay <host:port> --gateway <origin> --issuer <origin>/authelia \
                 --name "<the name you typed>" --yes
```

The dialog fills in the endpoints from this deployment's own configuration, so
copy them from there rather than from here. `--relay` is the deployment's
origin **host and port** — the relay answers at `/ws` on it, and has no port of
its own.

`--issuer` is the deployment's identity provider. The dialog assumes the
bundled Authelia (`<origin>/authelia`); on a deployment with the bundled
Keycloak it is `<origin>/idp/realms/pystino`, and on an external directory it
is whatever that directory's issuer is. If the enrollment step cannot fetch
discovery, that is the value to check first.

The script installs the paseo daemon and opencode (both pinned), wires the
daemon's relay block, signs you in, leaves a local shim running, sets the
permission posture, and finally pairs the machine into the panel — the dialog
notices and closes on its own. **Log into the chat at least once before
pairing**: the pairing identifies you by the same account, and a token for
somebody the chat has never seen is refused with exactly that message.

What the script needs on the machine: `bash`, `node`/`npm`, `python3`, and
Go 1.24+ the first time (it builds a small CLI from the checkout; apt's
`golang` is usually older, so install the official tarball if it complains).

The full flag list and what each step writes is in the gateway repository's
`docs/coding-agents.md`.

### If the machine cannot reach this origin

Pairing by hand still works, and needs no route from your machine to the chat:

```bash
paseo daemon pair
```

Paste the link it prints into the **Pair a device** dialog, against the code
the panel showed you. The pending pairing lasts fifteen minutes.

The link is the credential: it carries the daemon's id and its public key, and
Cerea proves the machine is live by completing the encrypted handshake before
recording anything. A daemon that answers as somebody else is refused.

## The panel

**Chats | Agents** switches the sidebar between the two. The Agents side is a
tree: paired devices, each with its workspaces, each with its sessions.
Everything that _changes_ something lives here — pairing, revoking, adding a
workspace, starting or archiving a session, renaming. The main pane only ever
shows what the address names (`/code?device=&ws=&agent=`).

### Workspaces

A workspace is a directory on the paired machine. Add one by typing its
**absolute** path — a relative path would resolve against whatever working
directory the daemon process was born with, which is unguessable from here, so
the server refuses it. The daemon refuses a path it cannot serve, and either
refusal arrives as a visible failure rather than a row that pretends.

### Sessions

A session ("agent") belongs to one workspace on one device. The provider list
comes from the daemon rather than from anything hardcoded here, so the panel
cannot offer something the machine cannot actually run.

An agent reads exactly like a conversation: the same transcript column, the
same message rendering, the same composer. That is deliberate — the panel is
the chat's own machinery pointed at a different source, which is why updates
arrive live without a refresh.

### The composer's pills

Inside the prompt box, in the chat's own pill idiom:

- **mode** — paseo's permission vocabulary (plan, build, …), listed live from
  the daemon rather than from a hardcoded set that would drift from what the
  daemon enforces.
- **model** — the models the agent's provider offers.
- **auto-accept** — opencode's own feature toggle, shown only when the agent
  reports it, blue when on. It is the agent's live state, not a claim the panel
  makes: on a failed read the toggle renders as neither on nor off.

Mode and model apply **to the agent**, live, not to one send. Switching either
changes the licence the session runs under until it is switched again — paseo's
own semantics.

### Stopping a turn

While a turn is live, the send button's place carries the stop control, exactly
as a chat does. It stays there while a permission card is up, because stopping
a request you do not want to answer is most of the point of it.

### Permissions

When the agent wants to edit a file or run a command, it asks, and the ask
renders as the chat's approval card. That gate only exists because the machine's
opencode config says `edit: ask` and `bash: ask` — the setup script writes that
posture, and `--skip-posture` leaves an existing config alone. The daemon itself
drops per-prompt permission rules, so the posture has to live on the machine;
approving in the panel is what answers it.

### Subagents

When the agent spawns a subagent, the tool call that spawned it is replaced in
the transcript by a card for that subagent — title, status, subtitle, from the
daemon's own roster. Expanding one fetches its timeline and renders it as a
nested read-only conversation. The nested transcript is not polled: it refreshes
on the next expand after the subagent's row reports a change.

### The diff pane

The **diff** control opens the shared side pane — the same frame artifacts open
in — with the agent's file changes, rendered by the same diff machinery the
artifact panel uses. The before/after pairs come from the daemon; nothing is
reconstructed here.

### Archiving and revoking

Archiving a session or a workspace confirms first, then asks the daemon and
redraws that device's subtree from the daemon's answer — never an optimistic
removal, because the daemon owns the listings. If the archived row was the one
open in the address, the panel navigates away from it.

Revoking a device deletes the pairing record, which is all the chat holds.
Sessions on the machine are untouched and simply become unreachable from here;
re-running the setup script pairs the same machine back into the same row.

## What is kept where

|                                                         | Where it lives                                               |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| your code, your working tree, the agent's session state | your machine                                                 |
| the pairing record — name, daemon id, public key, owner | the chat's database                                          |
| prompts, replies, file contents                         | in flight only, encrypted end to end                         |
| your LLM spend                                          | the gateway's ledger, against your account and billing group |

Pairing records are scoped to you: nobody else's panel can see or revoke your
machines.
