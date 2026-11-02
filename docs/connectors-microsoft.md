# Microsoft 365 and Outlook connectors

!!! info "For administrators and users who add connectors"

    Ways to reach Microsoft mail, calendar, files and documentation from Cerea. How connectors work in general: [Connectors](connectors.md); servers on your own machine: [Local connectors](local-connectors.md).

Microsoft has no single hosted MCP server for personal mail and files, and Microsoft Entra ID (the work and school sign-in) offers no dynamic client registration, so Cerea cannot sign users in to a Microsoft server on its own. The options below are community and Microsoft servers; each is credited with its licence.

!!! warning "Not tested end to end from Cerea"

    The commands and settings here come from each project's README and Microsoft's documentation. None of these servers has been run against Cerea for this page. What is unverified is said under each one.

## At a glance

| Server                                                                                      | Covers                                                                                     | Accounts                                        | Registration needed                                           | With Cerea                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Softeria ms-365-mcp-server](#softeria-ms-365-mcp-server)                                   | Mail, calendar, OneDrive, contacts, To Do, OneNote, Excel; Teams and SharePoint (org mode) | Personal; work or school with `--org-mode`      | None for stdio (built-in client); your own Entra app for HTTP | Local connector (one user), or hosted HTTP connector (unverified)   |
| [Microsoft 365 hosted servers](#work-and-school-microsofts-hosted-servers)                  | Mail, calendar, Teams, OneDrive and SharePoint, Word, and more                             | Work or school                                  | An Entra app and a tenant administrator                       | Remote connector by URL                                             |
| [mpalermiti/outlook-mcp](#personal-accounts-mpalermitioutlook-mcp)                          | Outlook mail, calendar, contacts, tasks                                                    | Personal only                                   | Your own free Azure app                                       | Local connector (recommended); single-user HTTP with a static token |
| [MrFixit96/onedrive-mcp-server](#onedrive-with-a-work-account-mrfixit96onedrive-mcp-server) | OneDrive files only                                                                        | Work or school (default tenant `organizations`) | None (borrows an Office client identity)                      | Local connector only                                                |
| [Microsoft Learn](#microsoft-learn-documentation)                                           | Microsoft's documentation                                                                  | None                                            | None                                                          | Remote connector, no sign-in                                        |

## Softeria ms-365-mcp-server

[`Softeria/ms-365-mcp-server`](https://github.com/Softeria/ms-365-mcp-server) (MIT license, Node) is the main recommendation when you want mail and files together, for a personal or a work account: 300+ Microsoft Graph tools covering Outlook mail and calendar, OneDrive, Excel, OneNote, To Do, Planner, contacts and search, and with `--org-mode` Teams, online meetings, SharePoint sites and lists, shared mailboxes and more.

```sh
npx -y @softeria/ms-365-mcp-server
```

- **Account type:** personal accounts by default. For a work or school account add `--org-mode` (or `MS365_MCP_ORG_MODE=true`), and set it from the start.
- **Sign-in:** device code with a built-in client ID (stdio): run `npx @softeria/ms-365-mcp-server --login` once, follow the URL and code, and the token is cached in the OS credential store. Or use your own Entra app: `MS365_MCP_CLIENT_ID`, `MS365_MCP_TENANT_ID` (`consumers` for personal accounts) and optionally `MS365_MCP_CLIENT_SECRET`.
- **Restrict it:** `--read-only`, `--preset mail,calendar,files` (presets include `mail`, `calendar`, `files`, `contacts`, `tasks`, `onenote`, `excel`, `teams`), `--enabled-tools` (a regular expression) and `--allowed-scopes`. The server requests only the permissions its enabled tools need.
- **HTTP mode:** `--http [port]` serves Streamable HTTP at `/mcp`. It acts as an OAuth server for MCP clients (endpoints under `/auth/*`, dynamic client registration on by default, `Authorization: Bearer` required on each request).

### One user, on your own machine: a local connector

Run it through `galopin` over stdio, so the tokens stay on your machine. First sign in once with `--login` as above, then in galopin's `mcp.json` (see [Local connectors](local-connectors.md)):

```json
{
	"mcpServers": {
		"microsoft": {
			"command": "npx",
			"args": ["-y", "@softeria/ms-365-mcp-server", "--preset", "mail,calendar,files"],
			"description": "Outlook mail, calendar and OneDrive"
		}
	}
}
```

For a work or school account add `"--org-mode"` to `args`. To use your own Entra app instead of the built-in client, add `"env": { "MS365_MCP_CLIENT_ID": "${MS365_MCP_CLIENT_ID}", "MS365_MCP_TENANT_ID": "${MS365_MCP_TENANT_ID}" }`.

### Every Cerea user signs in as themselves: host it

Host it in HTTP mode with your own Entra app (client ID, secret and tenant in `MS365_MCP_CLIENT_ID`, `MS365_MCP_CLIENT_SECRET`, `MS365_MCP_TENANT_ID`), behind TLS, and add its URL (`https://<host>/mcp`) in **Workspace → Connectors** or **Admin → Connectors**. Cerea probes it, finds its OAuth server, registers itself dynamically, and each user signs in to Microsoft through it. Register the redirect URIs the README lists for the server in your Entra app; whether Cerea's own callback (`https://<your Cerea origin>/chat/mcp/callback`, see [Connectors](connectors.md)) must be registered too depends on how the server proxies the sign-in, which this page has not checked. Use the connector's **Scopes** field only if you want to narrow what the server requests.

!!! warning "Unverified"

    That Cerea's discovery, dynamic registration and per-user token flow work end to end with this server is **not verified**. Its README describes per-request bearer tokens and `--obo` tenant and user restrictions rather than a general multi-user deployment, so its multi-user behaviour in HTTP mode is not known. Try it with one user first. A container for it beside your Cerea stack is not part of the kit.

## Work and school: Microsoft's hosted servers

Microsoft lists hosted Microsoft 365 servers in [`microsoft/mcp`](https://github.com/microsoft/mcp) (MIT license). They are Agent 365 endpoints of the form `https://agent365.svc.cloud.microsoft/agents/tenants/{tenant-id}/servers/<server>`, with `<server>` one of:

| Server                     | For                          |
| -------------------------- | ---------------------------- |
| `mcp_MailTools`            | Outlook mail                 |
| `mcp_CalendarTools`        | Calendar                     |
| `mcp_TeamsServer`          | Teams                        |
| `mcp_ODSPRemoteServer`     | OneDrive and SharePoint      |
| `mcp_SharepointListsTools` | SharePoint lists             |
| `mcp_WordServer`           | Word                         |
| `mcp_MeServer`             | The signed-in user's profile |
| `mcp_M365Copilot`          | Microsoft 365 Copilot        |

Add one by its URL under **Workspace → Connectors** or **Admin → Connectors**. Entra ID offers no dynamic registration, so:

1. **A tenant administrator** registers an app in Microsoft Entra (**App registrations → New registration**), adds the **Web** redirect URI `https://<your Cerea origin>/chat/mcp/callback`, creates a client secret, and grants the permissions the server needs.
2. In Cerea choose **Sign in with my own app details (advanced)** and enter the application (client) ID and the secret; fill **Scopes** with what Microsoft documents for that server.
3. Each user clicks **Sign in** and signs in to Microsoft as themselves.

!!! warning "Unverified"

    Whether these servers accept a third-party client such as Cerea, which licences they need (Microsoft 365 Copilot or Agent 365), and which permissions and scopes each requires are **not verified** here. Read Microsoft's documentation first: [microsoft/mcp](https://github.com/microsoft/mcp) and [Microsoft Learn](https://learn.microsoft.com/). A tenant administrator is needed in any case.

## Personal accounts: mpalermiti/outlook-mcp

[`mpalermiti/outlook-mcp`](https://github.com/mpalermiti/outlook-mcp) (MIT license, Python) is an MCP server for **personal** Microsoft accounts (Outlook.com, Hotmail, Live). Work and school accounts are not supported. It is a good fit if you want mail, calendar, contacts and tasks and do not need files.

- **Install:** `uv tool install outlook-graph-mcp`.
- **Azure app:** you register your own free app in Azure with **Supported account types: Personal Microsoft accounts only** and **Allow public client flows** set to Yes. No client secret is needed. Put the client ID in `~/.outlook-mcp/config.json` (`"client_id"`, and `"tenant_id": "consumers"`).
- **Sign in:** `outlook-mcp auth` (device code). Delegated scopes: `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Contacts.ReadWrite`, `Tasks.ReadWrite`, `MailboxSettings.Read`, `User.Read` and `offline_access`. Tokens go in the OS keyring.
- **Safety:** `"read_only": true` blocks the write tools, and `read_only_consent: true` asks Microsoft for read permissions only. One mailbox per process.

### In Cerea: a local connector (recommended)

Run it through galopin over stdio, so the tokens stay on your machine (after `outlook-mcp auth`):

```json
{
	"mcpServers": {
		"outlook": {
			"command": "outlook-mcp",
			"description": "My Outlook.com mailbox and calendar"
		}
	}
}
```

### In Cerea: HTTP, for one user

With `OUTLOOK_MCP_TRANSPORT=streamable-http` it serves MCP at `/mcp` and requires a bearer token (`OUTLOOK_MCP_HTTP_TOKEN`, mandatory); it has no TLS of its own, so put it behind a TLS proxy. Add it as a connector with a **static token** (the bearer). Because it serves a single mailbox, a connector published to everyone would give everyone that one mailbox: use it only as your own connector.

## OneDrive with a work account: MrFixit96/onedrive-mcp-server

[`MrFixit96/onedrive-mcp-server`](https://github.com/MrFixit96/onedrive-mcp-server) (MIT license, Python) is a small server for OneDrive files, installed with `pip install git+https://github.com/MrFixit96/onedrive-mcp-server.git`. Its tools are `list_files`, `get_file_metadata`, `search_files`, `upload_file`, `download_file` and `create_sharing_link`, with the delegated scopes `Files.ReadWrite` and `User.Read`.

Use it as a **local connector through galopin (stdio)**, for a work account, when you want no Entra app registration. In stdio mode it signs in with a built-in client ID (the README calls it "Office Desktop ID") by device code, or the Windows broker. Run `onedrive-mcp auth` once, then:

```json
{
	"mcpServers": {
		"onedrive": {
			"command": "onedrive-mcp",
			"description": "My OneDrive"
		}
	}
}
```

The default tenant is `organizations`; personal accounts are not documented. Be aware of these limits:

- It works only if your tenant allows device-code sign-in and Conditional Access permits it.
- It borrows Microsoft Office's first-party application identity. Use it only where your organisation's IT policy allows that: security teams watch device-code sign-ins under that client.
- It covers OneDrive only.
- Its **HTTP mode does not avoid registration for Cerea.** "No app registration" there relies on the MCP client's own pre-approved Microsoft credentials (for example VS Code's), which Cerea does not have, so as a Cerea connector it would still need an Entra app.

For OneDrive and mail together, or where this is not allowed, prefer Softeria's server or an Entra app of your own.

## Microsoft Learn documentation

Microsoft's documentation server, `https://learn.microsoft.com/api/mcp`, works without signing in. Add it under **Workspace → Connectors** (or **Admin → Connectors** for everyone); Cerea finds that it needs no authentication.

## Credits

| Project                                                                           | Licence |
| --------------------------------------------------------------------------------- | ------- |
| [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server)       | MIT     |
| [mpalermiti/outlook-mcp](https://github.com/mpalermiti/outlook-mcp)               | MIT     |
| [MrFixit96/onedrive-mcp-server](https://github.com/MrFixit96/onedrive-mcp-server) | MIT     |
| [microsoft/mcp](https://github.com/microsoft/mcp)                                 | MIT     |
