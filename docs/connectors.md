# Connectors

!!! info "For everyone"

    Adding remote MCP servers the assistant can use, signing in to them, and what asks your approval. Servers on your own computer: see [Local connectors](local-connectors.md).

A **connector** is a remote [MCP](https://modelcontextprotocol.io) server you
add to Cerea so the assistant can use its tools: your notes, a tracker, a
search service. You manage them under **Workspace → Connectors**. Servers
added here are _remote_; Cerea does not run MCP servers itself. A server that
runs on your own laptop or server is a [local connector](local-connectors.md):
you enroll that computer under **Workspace → Connectors → On your computers**, and its servers
then appear in the same MCP panel, labelled "name · on computer".

## Adding one

Enter the server's address. Cerea **probes it**: a remote MCP server says how
it authenticates, so you never declare that yourself. There are three outcomes:

- **OAuth.** The connector gets a **Sign in** button. Signing in leaves the page,
  because it is a consent screen on the provider's own site, and returns to the
  chat with the result. Where the service doesn't let apps register themselves, sign-in needs a client id and secret from that service. Enter them when adding the connector, or ask whoever runs the service for them. The optional **Scopes** field (space or one per line) narrows what Cerea asks for at sign-in; left empty, it asks for everything the server advertises, which for some providers is far more than you need. Changing a connector's scopes signs everybody out of it, so they approve the new ones. For Google, Cerea also asks for a refresh token by itself. Step-by-step: [Google Workspace](connectors-google-workspace.md) and [Microsoft 365 and Outlook](connectors-microsoft.md).
- **A static token.** You paste an API token, and, if the server expects it under
  a particular header name, that header (for `Authorization` the value is sent
  as a bearer token).
- **None**, for a server on a private network or a public one.

**Your credential never comes back to the browser.** OAuth tokens and static tokens are kept on the server, encrypted, and never sent back to your browser; the connector row only knows _whether you are connected_. An OAuth sign-in is yours alone: when an administrator publishes a connector to everybody, each user signs in to it as themselves and sees their own data.

Only connect to servers you trust.

### Names are unique

Every connector a user can see has its own name. Two names are the same when
they match after trimming, collapsing spaces and ignoring capital letters
("Notion", " notion" and "NOTION" clash). Adding or renaming a connector to a
name that is already taken is refused with "A connector named "X" already exists.
Choose another name." A user's own connector may not share a name with another
of theirs or with one the deployment provides; an administrator's connector may
not share one with another of the deployment's. In `MCP_SERVERS`, if two servers
share a name the first is kept, the later ones are dropped, and the server log
names them.

A clash can still arise: an administrator can add a connector named like a
user's own, and older data may already hold two. The assistant never sees two
connectors with one name, so one is left out: the deployment's connector wins
over a user's, a user's over one on their computer, and of two of a kind the
older one stays. The one left out is marked "Same name as another connector:
rename it" in the connectors list, and it works again once it is renamed.

## Coding agents

Your connectors can also reach a coding agent on one of your computers, off by
default: switch them on for one session or as a project's default. The agent
then has `connector_list` and `connector_call`, Cerea runs each call with your
own sign-in or key, and the credential never reaches the computer. See
[Connectors for an agent](code-panel.md#connectors-for-an-agent).

## Using them

Switch connectors on and off in one place: **Workspace → Connectors**. Each
connector there has a switch, and a connector that is on is available to the
assistant in every chat. There is nothing to choose in the composer or per
chat.

You do not need to say which connector to use. The assistant sees a short list
of the connectors that are on (a name, a sentence, the tools each offers) and
**loads a connector's tools when a request needs them**. You see a quiet line
such as "Loaded Maps" in the chat. Once loaded, a connector stays
loaded for the rest of that chat. Turning a connector off in Workspace
means the assistant no longer sees it, from your next message.

A connector you added that needs a sign-in is not offered to the assistant
until you have signed in.

**Every call to an MCP tool asks first, by default.** The approval card shows
the tool and its arguments, and you can allow that one call, allow the tool for
the rest of the chat, or deny it; the composer's **shield**
changes that for the current chat. See [Tool approvals](chat.md#tool-approvals).
A server may also ask _you_ for something mid-turn (a choice, a confirmation),
which appears as a form in the chat.

## Connectors for coding agents

A coding session ([/code](code-panel.md#connectors-for-an-agent)) can use your connectors too, but only the ones you switch on for that session (or as a project default); none by default. Cerea runs the call with **your** credentials, which never leave the server, and applies the same rules as the chat: a connector your administrator set to **Off**, or that you switched off in Workspace, or that needs a sign-in or your key, is not offered to the agent, and stops working at once if it changes after you switched it on. Other users' connectors are never offered. Each call is recorded (connector, tool and outcome, never the arguments) and follows the session's permission step.

## Files a connector returns

When a connector's tool returns a file, Cerea keeps it as a file of the
chat instead of showing its contents to the model. It appears in the
**Files** panel with a download card, the code sandbox has it at
`/mnt/data/<name>` from the next run, and `doc_read`, `doc_edit`, `look_doc` and
`convert_document` open it by name. The model reads a short note in place of the
file, such as `[file saved to this conversation: report.xlsx (11.5 KB, Excel); ...]`.

Cerea recognises a file in three forms:

- an MCP **resource** with binary data (named from its address or title);
- **image** and **audio** results (the model does not see an image a connector
  returns; it is kept as a file);
- **base64 text inside the result** (for example the `download-bytes` tool of the
  Microsoft 365 server), when the value is at least 1 KB and decodes to a known
  file type such as PDF, PNG, JPEG, Word, Excel or PowerPoint. The name comes
  from a `name`, `fileName` or `title` next to it, or from the call's
  `fileName` argument. Text that merely looks like base64 is left alone.

A file over 50 MB is not kept, and the result says so. If a file cannot be
saved, the result says that instead; the call itself still succeeds. A file
with the same name and different content becomes a new version, as for any
other file in the chat.

## Sending a file to a connector

The code sandbox has no network, so a connector (a GitHub commit, an upload) is the
only way a file leaves the chat, and the model would otherwise have to paste the whole
file into the call, which a large or binary file cannot survive (the reply is cut off
at the output limit). Instead the model passes a **file reference** where a string
argument goes:

- `{"$file": "/mnt/data/report.svg"}` is exactly what the code sandbox has at that path now:
  the latest version of the file, whatever made it (an attachment, a document tool's edit,
  or a file code wrote over the name). Cerea selects it with the same rule the sandbox
  staging uses (`attachmentIsMounted`), so the two cannot disagree (UTF-8 text);
- `{"$file": "/mnt/data/report.svg", "original": true}` is the user's upload as it was,
  before any edit or same-name file (how to send "the files I attached");
- `{"$file": "/mnt/output/diagram.svg"}` is the newest file produced in the chat under
  that name;
- `{"$file": "/mnt/output/logo.png", "encoding": "base64"}` is the file's bytes as base64;
- a bare name (`{"$file": "diagram.svg"}`) means `/mnt/data/diagram.svg`.

Other paths (outside those two roots, or with `..`) are refused, and a file a privacy rule
withheld never resolves in any form. A string
argument whose whole value is a `{"$file": ...}` object written as JSON text is also
refused, with a message to pass an object instead, because it would otherwise be sent
as literal text. After the call, the tool result carries one line per reference, such as
`[file reference] content ← /mnt/data/cerea-architecture.svg (original attachment, 96,733 bytes, sha256 1a2b3c4d…)` or `(current version: produced by code, 103,138 bytes, sha256 …)`,
so the model can check which file was sent; the line is not sent to the connector.

Cerea swaps in the content on the server, after any approval and just before the
call. Only an object with a `$file` key is ever rewritten, so an ordinary string (even
one that looks like a file name) is sent as written. The name is an attachment or a
file produced in this chat (a sandbox run's output, a document tool's file, a file
another connector returned); other chats' files are never reachable, and a file a
privacy rule withheld answers with the rule's refusal instead of its content. A file
over 8 MB (or references adding up to over 16 MB) is refused with a clear error and
nothing is sent. The approval card, the stored message and the logs show the reference,
never the content. **Deliberate decision (ADR 0113): file references are not redacted; withhold rules apply.** The file's raw bytes go to the connector you chose, as the file is yours; there is no redaction step, and a file a privacy rule withheld never resolves. If a call is still cut off by the output limit, the model is told the
arguments were too large and to use a reference. Code: `textGeneration/mcp/fileReferences.ts`.

## Apps from connectors

Some connectors ship an interactive page with a tool: a map, a diagram editor, a PDF viewer (these are
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps)). When the assistant uses such a tool, the page appears
inside the tool's card in the conversation, already showing what the tool returned. A connector that has no page, or
a page Cerea cannot show, behaves as before: you see the tool's text result.

What a page can and cannot do:

- **It runs in a locked box.** The page cannot see your Cerea session, cookies or other chats, and it can load
  only from the web addresses its connector declared (the card lists them).
- **Its own tools run quietly.** Some tools exist only for the page (saving its work, refreshing a view); the
  assistant never sees them. The page may call those without asking, as long as they belong to its own connector.
- **Its other tool calls ask you first.** When the page wants to call a tool the assistant can also use, the card says "The view
  from _connector_ wants to call _tool_" with the arguments, and you choose **Allow once**, **Allow this tool for
  the rest of the conversation** or **Deny**, exactly as for the assistant's own calls. If you have set the
  conversation to allow tools without asking, the call runs. Only that connector's tools can be called.
- **Its messages are drafts.** If the page proposes a message to the assistant, it lands in your message box
  for you to read and send. It is never sent for you.
- **Links ask first.** A link the page opens shows its full address and waits for your yes.
- **Full screen** is available from the card's header and covers the whole window, above the sidebar (Esc or the close button leaves it). The page follows: its own Edit and Done buttons change with it.
- **It shows by itself.** The page is under the tool's row whether the row is open or not; opening the row only shows the call's details.
- **When it does not show properly,** the card has a **Show details** link listing what went wrong (copy it for your administrator, who finds the same lines in the chat logs), and **Reload view** starts the page again.
- **A reload keeps it.** The page is kept with the conversation (for as long as the conversation's files are
  kept), so it shows again without the connector being reachable. After that, the card shows the text result.

Not supported yet: pages writing into the assistant's context, file downloads from a page, picture-in-picture,
camera, microphone and location, pages that need browser storage, and pages in shared links (which show the text
result).

## Connectors for everybody

An administrator can provide connectors to the whole deployment (see
[Administering the chat](chat-admin.md)). They are **provided automatically**:
you do not add them, they are on for you from the start, and they appear in
Workspace under **Built-in connectors**. Each is either on with a switch you can
turn off, or, when your administrator offers it as **On, locked**, marked
**Always on** with a lock and no switch: it stays on for everyone. A connector the administrator has switched off is not shown.

The **definition** is shared and the **credential is not**: each user signs in
to a shared OAuth connector themselves. An administrator publishes a connector
in one of three ways, and they differ in who holds the credential:

| Mode                                 | The administrator sets                                     | Who holds the credential                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Each user signs in** (OAuth)       | the address                                                | each user's own sign-in, kept encrypted on the server                                                                            |
| **Each user provides their own key** | the address, which header carries the key, and a help line | each user's own key, kept encrypted on the server                                                                                |
| **Shared access key**                | the address and one key                                    | the connector: **everyone uses the administrator's key**. The admin screen says so, because it is a decision and not an accident |

**Each user provides their own key** is for a service that uses personal
access tokens (GitHub's MCP server with a personal access token, for example)
where OAuth is not available. The administrator enters the name and address,
the header that carries the key (by default `Authorization: Bearer <key>`; any
other header name sends the raw key, as `X-API-Key` expects) and an optional
help text with a link ("Create a token at ... with the repo scope"). No key is
stored on the connector, and the admin screen shows only how many users have
added one, never the keys or who. Under Workspace → **Built-in connectors** the
card shows **Add your key**: a small form with the administrator's help, a
password field and **Save**. Then it reads **Connected**, with **Replace key**,
**Check key** and **Remove key**. Until a key is added the connector is not on
for that user: it is not used in their chats and its tools are not offered, the
same as a connector that needs a sign-in. The key is encrypted with
`CHAT_SECRET_KEY` like an OAuth token, is never sent back to the browser, and
is used only for that user's own calls. If the service answers 401 or 403 the
card says **Your key was refused** and the connector stays off for that user
until they replace the key. Non-administrators never see the service's own
error text. Removing a user's account removes their keys; removing the
connector, or changing its address, removes every user's key (a key must not
follow a connector to another server).

How an administrator checks such a connector: **Check** takes an optional
**test key**, used once for that check and never stored (an administrator who
added their own key can check without one). The first successful check, by an
administrator or by any user saving a key, fills the connector's tool list; a
later user's check does not replace it.

This mode is available for connectors added in Admin → Connectors, not in the
`MCP_SERVERS` variable: those entries are not connector rows, so they have no
place for a per-user credential. Add the connector in Admin instead.

**Who changes what, and where.** A connector the deployment provides, whether
the administrator added it or it comes from `.env`, is configured only in
**Admin → Connectors** (the `.env` ones in `.env`). In Workspace everybody sees
it read-only, administrators included: its status, how many tools it has and
the list of them, and your own **Use in my chats** switch where the
administrator allows one. Your own connectors are edited in Workspace as
before. Every card says what is known about its tools: "N tools", "Tools not
checked yet", or why listing them failed. Users who are not administrators
see the address without its query string, and a generic "Could not list its
tools" instead of the server's own error: those are for the administrator.

For a connector each user signs in to (OAuth), the tool list comes from the
checking administrator's own sign-in, so it reflects what that administrator's
account can use.

## Apps from a connector

Some servers offer an **app** with a tool: an interactive page (a map, a chart,
a form) the chat shows inside the tool's result, in a sandbox, instead of only
its text. A connector is allowed to show apps by default.

- **Administrators** turn it off per connector in **Admin → Connectors**, with
  **Allow apps from this connector**: for a connector they added and for a
  `.env` one. With the switch off the chat shows only the tool's text result,
  as before. A change applies from the next result; one already shown stays in
  its conversation.
- **Everywhere at once:** Admin → Connectors, **Apps from connectors**, is `Off`
  (no apps anywhere), `Only connectors provided here` (the administrator's and
  `.env` connectors, not users' own or those on their computers) or
  `All connectors` (the default; each connector's own switch still applies).
  `MCP_APPS` (`off`, `deployment`, `all`) sets the default and a saved choice
  overrides it; a value that is set but unknown reads as off.
- **Users** have the same switch, **Allow apps from this connector**, in the
  edit form of a connector they added themselves.
- A connector on your own computer
  ([Local connectors](local-connectors.md#apps-from-local-connectors)) may
  always show apps: its server runs as you.

## For operators

A deployment can also configure servers with the `MCP_SERVERS` variable (see
[Configuration](configuration.md)); they appear beside the administrator's
connectors under **Built-in connectors**, each with a health check, and an
administrator sets how each is offered on the same admin screen. Connector credentials need `CHAT_SECRET_KEY`:
without it, connectors cannot store a token and say so.

On a kit install, stdio MCP servers can run as containers beside the stack and
be offered as built-in connectors, with no host port: see "Server-side MCP servers" in
the kit README. They are shared by everyone who signs in, so use them for servers
without a personal credential; personal accounts belong in
[local connectors](local-connectors.md).
