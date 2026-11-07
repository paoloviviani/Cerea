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
the rest of the chat, or deny it; the composer's **Tools ask first**
pill changes that for the current chat. See [Tool approvals](chat.md#tool-approvals).
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
