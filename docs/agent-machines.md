# Agent machines: getting started

!!! info "For people using the Agents panel"

    Pairing your own machine and driving it from the chat. The depth is in the
    [reference](agent-machines-reference.md); **see also**
    [The `/code` panel](code-panel.md), the operator's side of the same feature.

The Agents panel in the sidebar drives coding agents that run **on your own
machine**, not here. Your code stays on it: the agent sends what it needs to the
model through your gateway, and the chat shows you files and changes as you look
at them but keeps no copy. `galopin` is the one binary that makes that possible:
it lives in this repository as `agent/`, and you install it with one line.

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
   [The pairing dialog](agent-machines-reference.md#the-pairing-dialog)), then copy it.
3. **Paste it in a terminal on the machine.** Your browser opens to sign in; on
   a machine with no screen it prints a link and a code you can open on your
   phone. The machine then appears in the Agents panel as **Pending**: click the
   green check next to it (its tooltip reads **Confirm this machine**). Only you
   can confirm your machines, and nothing is forwarded to a machine until you
   do. The red cross (**Reject this machine**) refuses one you did not expect to
   see.

A fresh machine also needs opencode, the coding engine galopin runs: tick
**Install opencode** in the dialog and the line installs it first.

That is all. The rest of this page is the panel in brief, what the permission
settings mean and how to update galopin; the dialog's options and everything else
are in the [reference](agent-machines-reference.md).

## The panel

**Chats | Agents** switches the sidebar between the two. The Agents side is a
tree: paired machines, each with its workspaces, each with its sessions.

- **A workspace** is a folder on the machine. Add one by typing its absolute
  path. A machine can be set to refuse folders outside the ones its owner listed.
- **A session** (an "agent") belongs to one workspace. It reads like a chat
  conversation, and the composer has the same pills: **mode** (plan, build, and
  whatever the agent offers), **model**, and the **Plan · Ask · Allow**
  permission selector.
- **The Needs-you inbox** lists, across all your machines, the approvals and
  questions waiting for you, each answerable in place.
- **Changes** opens a pane with the files the session has changed, from git.
- **Slash commands**: type `/` in the composer for the commands the session can
  run, including `/compact`, `/undo`, `/model` and `/new`.
- **Stop** ends a running turn. **Fork from here** on an answer starts a new
  session from that point.
- **The ··· menu** on a machine opens its settings, today the
  [delegate profiles](agent-machines-reference.md#delegate-profiles): which
  model a session's helpers run on.
- **Schedules** (under the machines) send a prompt to one of your sessions on a
  timetable; see [Scheduled actions](agent-machines-reference.md#scheduled-actions).

You need to have signed in to the chat within the last 7 days to use the panel;
your machines keep working meanwhile, the panel just asks you to sign in again
([why](agent-machines-reference.md#the-7-day-sign-in)). To be told when an agent needs you or has finished, turn on
[notifications](notifications.md).

## Permissions

Every session has one **permission setting**, the selector in its composer.
**New sessions start on Ask.**

| Setting   | What it does with a tool call the session has no rule for                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| **Plan**  | the agent plans and reads; anything that would change something is refused, with no card                            |
| **Ask**   | asks you, with an approval card (reading inside the project does not ask)                                           |
| **Allow** | lets it through without asking, **up to the machine's limits** (the ceiling its owner set when pairing it)          |

When a card appears you can **Allow once**, **Always allow (this session)** for
that command, or **Deny**. Allow never passes the machine's ceiling: where it
says `bash` asks, `bash` asks on Allow too, and the selector says so. Writing
outside the project folder still asks on Allow. The ceiling and the machine's
other limits are fixed when the machine is paired and the chat cannot loosen
them. The full rules, the **Permissions** dialog and the exceptions are in the
[reference](agent-machines-reference.md#permissions).

## Delegating work

A session's model can hand work to other sessions on the same machine, and to
subagents inside its own turn. A machine can have **profiles**, a name and a model
each, so a helper can run on a different model; the model can also run a
**committee** of two or three helpers on one question, or ask a read-only second
opinion. All of it is under the same permissions and limits.
See [Delegating work](agent-machines-reference.md#delegating-work).

## Updating galopin

galopin is a plain binary, so updating it is the install again. On the machine,
re-run the install line from the **Pair a machine** dialog, then restart it:

```sh
curl -fsSL "$CEREA_BASE_URL/galopin/install.sh" | sh
systemctl --user restart galopin     # or stop and start `galopin run`
```

You do **not** enroll again: the machine keeps its pairing, credential and
policy. New panel features that need a newer galopin say so ("update galopin on
that machine"). Details, including macOS, are in
[Updating galopin](agent-machines-reference.md#updating-galopin).

To keep galopin running when the terminal closes, see
[Keeping it running](agent-machines-reference.md#keeping-it-running).

## Where to go next

| You want…                                                           | Read                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| every pairing option and what a machine will refuse                 | [The pairing dialog](agent-machines-reference.md#the-pairing-dialog) and [the machine policy](agent-machines-reference.md#the-machine-policy) |
| terminals, the file explorer, a repo's own config                   | [The terminal](agent-machines-reference.md#the-terminal), [the file explorer](agent-machines-reference.md#what-the-file-explorer-may-see) |
| to run it as a service, remove a machine, install by hand           | [Installing and running galopin](agent-machines-reference.md#installing-and-running-galopin)      |
| how it works                                                        | [How it works](agent-machines-reference.md#how-it-works)                                          |
