# Local connectors

!!! info "For people who run MCP servers on their own machine"

    Offering the MCP servers installed on your laptop or server to your chat,
    without opening a port to the internet. For servers reachable on the web, see
    [Connectors](connectors.md); for the coding-agent side of `galopin`, see
    [Agent machines](agent-machines.md).

A **local connector** is an [MCP](https://modelcontextprotocol.io) server that
runs on a machine you control (a filesystem server over your notes, a database
tool, a CRM that listens on `127.0.0.1`). `galopin`, the same binary that links
a machine to the Agents panel, dials out to the chat and passes the server's
traffic through, so the assistant can use its tools while the server, its files
and its secrets stay where they are. Nothing on the link adds a server or starts
a command: the machine's own file lists what it offers, and the chat uses that.

## Enroll a connectors-only machine

A machine that only serves connectors needs no coding agent, no opencode and no
billing group. Install `galopin` as for [an agent machine](agent-machines.md),
then enroll with `--mode connectors` and run it:

```sh
galopin enroll --mode connectors \
  --issuer "$OIDC_ISSUER" \
  --cerea "$CEREA_BASE_URL"
galopin run
```

`enroll` opens your browser to sign in (or prints a link and code for another
device), stores the refresh credential in `<config-dir>/galopin/credentials.json`
and writes nothing else: no opencode config, no gateway, no policy file. It
records that this is a connectors machine, so `run` starts no backend; the same
as `galopin run --backend none`. The machine then appears under
**Local connectors** in the chat's workspace settings, where you approve it
(a connectors machine is never listed in the Agents panel).

A machine that already runs a coding agent needs no second enrollment: it offers
connectors too as soon as it has an `mcp.json`.

## `mcp.json`

Put the file in galopin's config directory, beside `credentials.json`
(`~/.config/galopin/mcp.json` on Linux, `~/Library/Application
Support/galopin/mcp.json` on macOS). It is the format Claude Desktop and Claude
Code use, so an existing file can be copied as is:

```json
{
	"mcpServers": {
		"notes": {
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/notes"],
			"env": { "LOG_LEVEL": "warn" },
			"cwd": "/home/me",
			"description": "My notes folder",
			"allowedTools": ["read_file", "list_directory", "search_files"]
		},
		"crm": {
			"type": "http",
			"url": "http://127.0.0.1:9000/mcp",
			"headers": { "Authorization": "Bearer ${CRM_TOKEN}" }
		},
		"old": {
			"type": "sse",
			"url": "https://tools.example.org/sse",
			"disabled": true
		}
	}
}
```

| Entry                           | Meaning                                                                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`, `args`, `env`, `cwd` | A **stdio** server: galopin starts the process when the chat opens it and talks newline-delimited JSON-RPC over its stdin and stdout.                                                                                                          |
| `"type": "http"` and `url`      | A server speaking MCP **Streamable HTTP** (`"streamable-http"` is accepted too), with the `headers` you list sent on every request.                                                                                                            |
| `"type": "sse"` and `url`       | A server on the older HTTP+SSE transport.                                                                                                                                                                                                      |
| `${VAR}`, `${VAR:-default}`     | Expanded in `command`, `args`, `env`, `url` and `headers` from galopin's own environment, as Claude Code does. A variable that is unset and has no default makes the entry **invalid**; the chat is told the variable's _name_, never a value. |
| `description`                   | Shown in the chat's MCP panel. Ignored by Claude.                                                                                                                                                                                              |
| `disabled: true`                | Listed in the chat but not startable. Ignored by Claude.                                                                                                                                                                                       |
| `allowedTools`                  | The machine's ceiling, below. Ignored by Claude.                                                                                                                                                                                               |

A server name is letters, digits, `-` and `_` (at most 64, starting with a letter
or digit); another name is listed as invalid. Keys galopin does not know are
ignored, so a file written for Claude works unchanged. galopin re-reads the file
when it changes (checked every few seconds): a server whose entry was removed or
changed has its open channels closed, and a changed one starts afresh the next
time the chat opens it. A file that stops parsing leaves the servers as they
were, and says why in galopin's log.

Check what galopin makes of the file without the chat:

```sh
galopin connectors list          # name, transport, state, and whether you are signed in
galopin connectors test notes    # start it, initialize, list its tools, stop it
```

## What the chat may do: `allowedTools`

When `allowedTools` is present, it is a **ceiling the chat cannot change**.
galopin removes every other tool from the server's `tools/list` answer, and
answers a `tools/call` for any tool outside the list itself, with the JSON-RPC
error `-32001` ("this tool is not allowed on this machine"), without ever
forwarding it. An empty list allows no tool; with no `allowedTools` key, every
tool the server offers is available. The chat's own per-conversation tool
choices work inside this list.

Every `tools/call` adds one line to `audit.log` in galopin's config directory:
when, which server, which tool, and the outcome (`ok`, `error`, `refused`).
Never the arguments or the result, which stay between the chat and the server.

## Signing in to an http server

Secrets for a stdio server belong in its `env`, which never leaves the machine,
and an http server can be given a token in `headers`. A server that asks for
**OAuth** (it answers `401` with a `WWW-Authenticate` challenge, per the MCP
authorization specification) is listed in the chat as **needs login**. Sign in
from the chat: its **Sign in** button sends your browser to the provider and back,
and galopin, not the chat, exchanges the code and keeps the tokens in
`<config-dir>/galopin/connectors/NAME.json` (mode 0600), refreshing them
automatically. The chat never sees a token.

A provider that accepts only pre-registered redirect addresses cannot be signed in
that way. Sign in on the machine instead:

```sh
galopin connectors login crm
```

It prints a URL and tries to open a browser; the answer comes back to `127.0.0.1`
at a random port, so on a remote machine open the URL somewhere that can reach
that port (for example through an SSH `-L` forward). Both ways use the standard
authorization-code flow with PKCE, discover the server's authorization server and
register galopin by dynamic client registration when the server offers it (a
server that offers none cannot be signed in to). A sign-in made while galopin runs
takes effect without a restart.

## Lifecycle and limits

- A stdio server starts when the chat opens it, in its own process group, and
  stops when the chat closes it, when the link to the chat drops, or after
  **10 minutes without traffic**. galopin asks the kernel to kill it if galopin
  itself dies. Its standard error goes to galopin's log, never to the chat; the
  last line of it is in the message when the server fails to start or crashes.
- Each open is a new process (or a new HTTP session): at most **4 channels per
  server** at a time.
- A message over **1 MiB** does not cross the link: a request that cannot be
  forwarded is answered with a JSON-RPC error, anything else is dropped and
  logged.
- Nothing else on the machine is offered: the chat sees the servers of
  `mcp.json` and nothing it did not list.

## Running it as a service

A connectors machine runs exactly like any galopin: keep `galopin run` up with
the user service in [Keeping it running](agent-machines-reference.md#keeping-it-running).
The unit's `PATH` must include whatever the servers' `command`s need (`npx`,
`uvx`, your own binaries), and any `${VAR}` an entry uses must be in the unit's
environment (`Environment=CRM_TOKEN=...`, or an `EnvironmentFile=` with mode
0600), because a service does not read your shell profile. Edits to `mcp.json`
take effect without a restart; a change to the environment needs one
(`systemctl --user restart galopin`).

## If something is off

| In the chat                                   | Why                                                                                                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The machine is **offline**                    | `galopin run` is not running, or cannot reach the chat. `galopin auth status` shows the credential; `journalctl --user -u galopin -f` its log.                                     |
| The server is **invalid**                     | The reason is shown: an unset `${VAR}` (its name), an unknown `type`, a missing `command` or `url`, a bad name.                                                                    |
| The server is **needs login**                 | Sign in from the chat, or run `galopin connectors login NAME` on that machine.                                                                                                     |
| **Unavailable** when the chat opens it        | The process could not start or exited at once (the exit status and the last stderr line are in the message), the HTTP server could not be reached, or 4 channels are open already. |
| A tool is missing                             | It is outside the entry's `allowedTools`.                                                                                                                                          |
| A tool call fails with "not allowed" (-32001) | The same ceiling; edit `allowedTools` on the machine.                                                                                                                              |
