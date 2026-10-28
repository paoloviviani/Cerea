# Administering the chat

!!! info "For administrators"

    The few screens where an administrator decides what the chat does for everybody; running the platform itself is the Pystino console's job.

The chat has a small **Admin** area of its own, and the split is by _whose
decision it is_. The Pystino console owns how the platform is run: providers,
models, prices, quotas, redaction, users and groups. The chat's Admin area owns
what the **product** does for people: which model reads a document, what
fetches a URL, which connectors and skills everybody gets. Several of these
are gateway rows underneath; the decision is still a product one, and this is
where it is made.

## Who sees it

The **Admin** row at the foot of the sidebar (beside Workspace and Settings)
appears only for administrators, and **the gateway decides who that is**: the chat asks the
gateway who the signed-in person is (`GET /v1/me`) and believes nothing else.
The chat's own admin flag, inherited from upstream, comes from a HuggingFace
organisation claim and means nothing in this deployment, so it is not used.

Anyone else who opens `/admin` is told plainly that the area is for
administrators, not shown a page of buttons that all refuse. Anyone whose session the gateway does not accept (one that predates the sign-in token, say) is asked to sign in again through the identity provider, because an administration decision needs recent proof of who is at the keyboard. Every write is checked again on the
server; the page's gate is for navigation, never a permission.

## The sections

| Section                    | What you decide                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Knowledge**              | Which embedding model the deployment uses and which model reads documents, on one screen with the consequences: see below. Hidden when the deployment turns the knowledge pipeline off (`CHAT_KNOWLEDGE_ENABLED=false`) |
| **Web search**             | Which search backend the composer's Web search pill uses, picked from the search backends the gateway offers (not hidden when knowledge is off)                                                                         |
| **Fetching**               | Which backend fetches a URL: a plain HTTPS request, or the [headless browser](browser.md), with a live check of whether the renderer answers                                                                            |
| **Connectors**             | MCP servers offered to everybody, and how each is offered: see [Connectors for everybody](#connectors-for-everybody) below                                                                                              |
| **Skills**                 | Deployment-wide skills that every account sees; the bundled ones can be switched off by name (`CHAT_SKILLS_DISABLED`)                                                                                                   |
| **Voice**                  | Whether the composer offers browser dictation: yes, no, or only when no voice model is available (the default): see below                                                                                               |
| **Assistant instructions** | One text added to every chat's instructions, before each user's own, and whether users can read it in Settings: see below                                                                                               |
| **Sub-agents**             | Whether the assistant may hand work to sub-agents (`delegate`, `research`): on by default; see below                                                                                                                    |
| **Storage**                | How long files produced by code are kept: see below                                                                                                                                                                     |

**Knowledge** puts the configuration and its consequences together on purpose.
Changing the embedding model touches **no existing base**: each pins the model
it was indexed with. So the screen shows which bases are now on an older model
and would be re-embedded, and **Reindex** sits beside that tag rather than on a
page of its own. See [Knowledge and projects](knowledge.md).

**Web search** lists the backends the gateway offers you (`kind: search`,
bounded by your own grants) and stores the choice in the chat's own database,
like the document reader. With none offered it says so: add one in the gateway
console (Providers), then choose it here. With none chosen, the caller's
billing-group search policy in the gateway decides. `WEB_SEARCH_MODEL` in the
environment overrides the screen and shows as "set in the environment". The
choice only applies to people granted that backend; everyone else falls back to
their group's policy. Anyone with no usable backend sees the composer's Web
search pill disabled rather than a switch that does nothing.

**Fetching** distinguishes fetching from searching: given a plain URL you do
not search for it, you fetch it, and the only question is what does the
reading. Selecting the headless browser before its service is up is a legitimate
order of operations, so the health check warns and never locks the setting. The
status meanings are on the [browser page](browser.md#turning-it-on).

## Connectors for everybody

The **Connectors** section lists the connectors the deployment provides: the
servers in `MCP_SERVERS` (their address and key stay in `.env`) and the ones you
add here. For each one you choose how it is offered:

- **Off:** offered to nobody.
- **On** (the default): on for everyone from the start, and a person can switch
  it off in Workspace.
- **On, locked:** on for everyone, and nobody can switch it off.

**Edit** (on a connector you added) changes its name, address, a one-sentence
**description**, and its shared access key or header, or removes the key. The
description is what the assistant reads in its list of connectors, so say what
the connector is for. This is the only place a provided connector is changed:
Workspace shows it read-only to everyone, administrators included, and the
server refuses a change that does not come from this page. **Check** lists its
tools again with the connector's own access key. Adding a connector, and
changing its address or key, lists its tools automatically; if that fails, the
reason shows on its card instead of a tool count. (A connector each person signs
in to cannot be listed until somebody has: use **Check** after signing in.)

For a connector each person signs in to, **Re-check** asks the server again how
people sign in, and **Add app details** takes the client ID and secret from a
provider that does not register apps itself. Changing such a connector's
address signs everybody out of it (their saved sign-ins are removed, so they
are never sent to the new address) and asks the new server how to sign in. An
address with a key in it (`?apiKey=`) is warned about: put the key in the key
field instead.

A fourth setting, **Always loaded**, is a switch of its own. The assistant
normally sees a connector as one line and loads its tools when a request needs
them. An always loaded connector skips that: its tools are in every request from
the start. A change applies from the next message, with no restart.

The reason to be selective is cost. A connector's tool descriptions go into the
request every time they are loaded, and they can be long. Leave big or rarely
used connectors as plain **On** and the assistant pays for their tools only in
the conversations that use them; make a connector always loaded only when
nearly every conversation needs it (a web search, say). A connector with no
saved tool names is listed to the assistant with its address and a note that its
tools have not been checked.

Every connector added here is **On** until you change it, and that includes the
servers in `MCP_SERVERS`. **After an upgrade, review this page:** set what you
do not want everybody to have to **Off**, and what people should be able to turn
off to plain **On**. Tell people what changes for them too: their own
connectors also come back **On** after the upgrade, and the choices older
versions kept in their browser (which connectors were on in a chat, and the
defaults for new chats) are not carried over; they switch connectors off again
in Workspace → Connectors. From then on each person's switches are kept on the
server, so they follow them between browsers. Tool approvals are unchanged: a call to a
connector's tool asks first, whatever its mode.

## Voice

**Enable browser dictation** decides whether the composer shows a microphone
button that types what a person says, using the speech recognition built into
their browser (see [Dictation](chat.md#dictation)). Three values:

- **Yes**: always offered, in browsers that support it.
- **No**: never offered.
- **Only when no voice model is available** (the default): offered only when
  the deployment has no server-side transcription model (`TRANSCRIPTION_MODEL`),
  so the recorder button and the dictation button are never shown together.

It is a deployment decision, and not each person's, because Chrome, Edge and
Safari may send the audio to their vendor's cloud for recognition; this
deployment never receives it. Firefox has no recognition and shows no button
whatever the setting. The value is stored in the chat's configuration (changing
it is logged with who made the change) and overrides `CHAT_DICTATION`; with
`ENABLE_CONFIG_MANAGER` off it can only be set in the environment. People see
a change the next time the page loads.

## Sub-agents

**Allow sub-agents** decides whether tool-capable models are offered the
`delegate` tool, and the `research` preset where web search is available (see
[Plans and sub-agents](chat.md#plans-and-sub-agents)). It is on by default. A
sub-agent makes its own model calls, billed to the person like any message, and
uses the chat's connector tools without the person watching each step (only
those the conversation already allows: it never raises an approval card), so a
deployment that wants neither can switch it off here. The value is stored in
the chat's configuration (changing it is logged with who made the change) and
overrides `CHAT_DELEGATION`; with `ENABLE_CONFIG_MANAGER` off it can only be
set in the environment. It applies to the next message anyone sends.

## Assistant instructions

One text for the whole deployment, added to **every chat's instructions, before
each user's own**. Use it for what every answer should follow: a house style,
a language, what the assistant must not do. It is up to 4,000 characters, with
a live count; **Save** stores it and **Revert** drops unsaved edits. Empty
means none.

It applies to chats only. The [Agents panel](code-panel.md) and the coding
agents on users' machines never get it, and neither does the title Cerea
generates for a chat. Sub-agents the assistant starts (`delegate`, `research`)
do get it too, at the top of their own instructions, so a style rule such as
"keep answers short" also shortens their reports back to the assistant. Write
rules that make sense for both. The text is sent as a block that opens with
"Instructions from this deployment's administrator:" and ends with a closing
line, so what a user writes after it is never read as part of it.

**Show these instructions to users** (on by default) decides whether users can
read the text, read-only and labelled "From your administrator", in
**Settings**, next to their own instructions. Turn it off and users see
nothing about it, not even that it exists; it still applies. Administrators
always see and edit it here.

The text and the switch are stored in the chat's configuration (changing them
is logged with who made the change, never the text) and override
`ADMIN_INSTRUCTIONS` and `ADMIN_INSTRUCTIONS_VISIBLE`; with
`ENABLE_CONFIG_MANAGER` off they can only be set in the environment. It is
deployment configuration, not personal data, so it is not part of an account's
export or erasure; a database backup includes it with the rest of the
configuration. It applies to the next message anyone sends.

## Storage

How many days the files the assistant's code produces (documents,
spreadsheets, PDFs, charts from the [Python sandbox](pyodide.md)) are kept:
30 unless changed, or **Never expire**, which keeps them until their
conversation is deleted. Text artifacts and uploaded attachments are not
affected: they live with their conversation and never expire.

The screen shows how many produced files are stored and their size. Before a
shorter period is saved it says how many files it would delete, because those
go at the next sweep (within the hour) and cannot be recovered. A longer
period, or none, keeps everything that still exists. The value is stored in the
chat's configuration and overrides `CHAT_FILE_RETENTION_DAYS`; with
`ENABLE_CONFIG_MANAGER` off it can only be set in the environment.

## Everything else is the console

Users, groups, providers, models, prices, quotas and redaction are not here. If
the deployment serves the Pystino console at `/console`, set
`CHAT_CONSOLE_ENABLED=true` and the chat's admin panel links to it. The
console's own documentation is linked from the [reference](reference.md).
