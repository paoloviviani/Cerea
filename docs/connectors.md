# Connectors

!!! info "For everyone"

    Adding remote MCP servers the assistant can use, signing in to them, and what asks your approval.

A **connector** is a remote [MCP](https://modelcontextprotocol.io) server you
add to Cerea so the assistant can use its tools: your notes, a tracker, a
search service. You manage them under **Workspace → MCP Servers**. Only
_remote_ servers are supported; Cerea does not run MCP servers itself.

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

Switch a connector on for a conversation from the composer: the **+** menu, then **MCP Servers**. Its tools are then available to the assistant. A project can start new chats with particular connectors selected ([Knowledge and projects](knowledge.md#projects)).

**Every call to an MCP tool asks first, by default.** The approval card shows
the tool and its arguments, and you can allow that one call, allow the tool for
the rest of the conversation, or deny it; the composer's **Tools ask first**
pill changes that for the current chat. See [Tool approvals](chat.md#tool-approvals).
A server may also ask _you_ for something mid-turn (a choice, a confirmation),
which appears as a form in the conversation.

## Connectors for everybody

An administrator can publish a connector to the whole deployment (see
[Administering the chat](chat-admin.md)). The **definition** is shared and the
**credential is not**: each person signs in to a shared OAuth connector
themselves. The exception is a static token, which belongs to the connector
rather than to a person, so publishing one **shares the key** with everyone who
uses it. The admin screen says so, because it is a decision and not an
accident.

## For operators

A deployment can also configure base servers with the upstream `MCP_SERVERS`
variable (see [Configuration](configuration.md)); they appear beside the
connectors as **Base Servers**, each with a health check. Connector credentials need `CHAT_SECRET_KEY`:
without it, connectors cannot store a token and say so.
