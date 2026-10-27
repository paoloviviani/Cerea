# Connectors

!!! info "For everyone"

    Adding remote MCP servers the assistant can use, signing in to them, and what asks your approval. Servers on your own machine: see [Local connectors](local-connectors.md).

A **connector** is a remote [MCP](https://modelcontextprotocol.io) server you
add to Cerea so the assistant can use its tools: your notes, a tracker, a
search service. You manage them under **Workspace → Connectors**. Servers
added here are _remote_; Cerea does not run MCP servers itself. A server that
runs on your own laptop or server is a [local connector](local-connectors.md):
you enroll that machine under **Workspace → Local connectors**, and its servers
then appear in the same MCP panel, labelled "name · on machine".

## Adding one

Enter the server's address. Cerea **probes it**: a remote MCP server says how
it authenticates, so you never declare that yourself. There are three outcomes:

- **OAuth.** The connector gets a **Sign in** button. Signing in leaves the page,
  because it is a consent screen on the provider's own site, and returns to the
  chat with the result. Where the service doesn't let apps register themselves, sign-in needs a client id and secret from that service. Enter them when adding the connector, or ask whoever runs the service for them.
- **A static token.** You paste an API token, and, if the server expects it under
  a particular header name, that header (for `Authorization` the value is sent
  as a bearer token).
- **None**, for a server on a private network or a public one.

**Your credential never comes back to the browser.** OAuth tokens and static tokens are kept on the server, encrypted, and never sent back to your browser; the connector row only knows _whether you are connected_. An OAuth sign-in is yours alone: when an administrator publishes a connector to everybody, each person signs in to it as themselves and sees their own data.

Only connect to servers you trust.

## Using them

Switch connectors on and off in one place: **Workspace → Connectors**. Each
connector there has a switch, and a connector that is on is available to the
assistant in every chat. There is nothing to choose in the composer or per
conversation.

You do not need to say which connector to use. The assistant sees a short list
of the connectors that are on (a name, a sentence, the tools each offers) and
**loads a connector's tools when a request needs them**. You see a quiet line
such as "Loaded Maps" in the conversation. Once loaded, a connector stays
loaded for the rest of that conversation. Turning a connector off in Workspace
means the assistant no longer sees it, from your next message.

A connector you added that needs a sign-in is not offered to the assistant
until you have signed in.

**Every call to an MCP tool asks first, by default.** The approval card shows
the tool and its arguments, and you can allow that one call, allow the tool for
the rest of the conversation, or deny it; the composer's **Tools ask first**
pill changes that for the current chat. See [Tool approvals](chat.md#tool-approvals).
A server may also ask _you_ for something mid-turn (a choice, a confirmation),
which appears as a form in the conversation.

## Connectors for everybody

An administrator can provide connectors to the whole deployment (see
[Administering the chat](chat-admin.md)). They are **provided automatically**:
you do not add them, they are on for you from the start, and they appear in
Workspace under **Built-in connectors**. Each is either on with a switch you can
turn off, or, when your administrator offers it as **On, locked**, marked
**Always on** with a lock and no switch: it stays on for everyone. A connector the administrator has switched off is not shown.

The **definition** is shared and the **credential is not**: each person signs in
to a shared OAuth connector themselves. The exception is a static token, which
belongs to the connector rather than to a person, so publishing one **shares
the key** with everyone who uses it. The admin screen says so, because it is a
decision and not an accident.

**Who changes what, and where.** A connector the deployment provides, whether
the administrator added it or it comes from `.env`, is configured only in
**Admin → Connectors** (the `.env` ones in `.env`). In Workspace everybody sees
it read-only, administrators included: its status, how many tools it has and
the list of them, and your own **Use in my chats** switch where the
administrator allows one. Your own connectors are edited in Workspace as
before. Every card says what is known about its tools: "N tools", "Tools not
checked yet", or why listing them failed.

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
