# Google Workspace MCP

!!! info "Adapted from LibreChat's documentation"

    This page is adapted from LibreChat's
    [Google Workspace MCP](https://www.librechat.ai/docs/mcp_servers/google_workspace)
    page, MIT License, Copyright (c) 2026 LibreChat. The Google Cloud steps,
    scope lists, prompts and troubleshooting are theirs; the parts that differ
    for Cerea are rewritten. See `NOTICE`.

Google provides remote Model Context Protocol (MCP) servers for Google Workspace products. In Cerea, each Google Workspace product is added as its own OAuth-enabled remote [connector](connectors.md).

!!! warning "Developer Preview"

    Google marks the Workspace MCP servers as part of the Google Workspace Developer Preview Program.
    Review Google's current documentation before deploying this broadly, because available products,
    scopes, and verification requirements may change.

## What You Will Configure

Google Workspace MCP is not one combined server. Configure only the products you want to expose to users:

| Product         | MCP server URL                              |
| --------------- | ------------------------------------------- |
| Gmail           | `https://gmailmcp.googleapis.com/mcp/v1`    |
| Google Drive    | `https://drivemcp.googleapis.com/mcp/v1`    |
| Google Calendar | `https://calendarmcp.googleapis.com/mcp/v1` |
| People API      | `https://people.googleapis.com/mcp/v1`      |
| Google Chat     | `https://chatmcp.googleapis.com/mcp/v1`     |

Each user connects each server from Cerea. Cerea stores OAuth tokens per user, so Gmail, Drive, Calendar, People, and Chat access follows the Google account that authorized the connection.

For a single server that covers all of Google Workspace, see [One server for all of Google Workspace](#one-server-for-all-of-google-workspace-taylorwilsdongoogle_workspace_mcp) below.

## Prerequisites

- A Google Cloud project.
- Permission to enable APIs and create OAuth clients in that project.
- `gcloud` installed and authenticated, or access to the Google Cloud console.
- A running Cerea instance, with `PUBLIC_ORIGIN` set (the kit sets it for you).
- The public base URL users use to open Cerea, for example `https://chat.example.com`. Google requires `https` for a redirect URI, except for `localhost`.

!!! info "OAuth callback path"

    Cerea has **one** OAuth callback for all connectors: `https://<your Cerea origin>/chat/mcp/callback`.
    It is built from `PUBLIC_ORIGIN` plus the base path (`/chat` unless you changed `APP_BASE`), not from the
    address in the browser. The same address is shown, ready to copy, in the connector's form. Register this
    single address once on the Google OAuth client, whichever servers you add.

## Setup

### Enable the Google Workspace APIs

Replace `PROJECT_ID` with your Google Cloud project ID:

```bash
gcloud services enable gmail.googleapis.com \
  drive.googleapis.com \
  calendar-json.googleapis.com \
  chat.googleapis.com \
  people.googleapis.com \
  --project=PROJECT_ID
```

### Enable the Google Workspace MCP services

Enable the MCP services for the products you plan to configure:

```bash
gcloud services enable gmailmcp.googleapis.com \
  drivemcp.googleapis.com \
  calendarmcp.googleapis.com \
  chatmcp.googleapis.com \
  people.googleapis.com \
  --project=PROJECT_ID
```

### Configure Google Chat, if needed

The Google Chat MCP server requires a Chat app in the same Google Cloud project.

In the Google Cloud console, open **Google Chat API** > **Manage** > **Configuration** and create a Chat app:

- **App name**: `Chat MCP`
- **Avatar URL**: `https://developers.google.com/chat/images/quickstart-app-avatar.png`
- **Description**: `Chat MCP server`
- **Functionality**: turn off **Enable interactive features**
- **Logs**: select **Log errors to Logging**

Click **Save**.

!!! warning "Workspace account required for Chat"

    Google Chat app configuration may be unavailable for consumer Google accounts. If the console says
    that the Google Chat API is only available to Google Workspace users, omit the `chat` MCP server
    or use a Workspace-backed project/account.

### Configure the Google Auth Platform

In the Google Cloud console, go to **Google Auth Platform**.

If the Google Auth Platform is not configured yet, click **Get Started** and provide:

- **App name**: use a clear name, such as `Cerea Google Workspace MCP`.
- **User support email**: your support email or Google group.
- **Audience**: choose **Internal** for a Google Workspace organization, or **External** if users are outside your organization or you are using a personal Google account.
- **Developer contact information**: an email where Google can notify you about the project.

If you choose **External** and keep the app in testing mode, add yourself and any other allowed users under **Audience** > **Test users**.

### Add Data Access scopes

Open **Data Access** > **Add or Remove Scopes**. Under **Manually add scopes**, paste the scopes for the servers you want to use.

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.compose
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events.freebusy
https://www.googleapis.com/auth/calendar.events.readonly
https://www.googleapis.com/auth/directory.readonly
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/contacts.readonly
https://www.googleapis.com/auth/chat.spaces.readonly
https://www.googleapis.com/auth/chat.memberships.readonly
https://www.googleapis.com/auth/chat.messages.readonly
https://www.googleapis.com/auth/chat.messages.create
https://www.googleapis.com/auth/chat.users.readstate.readonly
```

Click **Add to Table**, **Update**, then **Save**.

!!! warning "Sensitive and restricted scopes"

    Gmail, Drive, Chat, Contacts, and Directory scopes can trigger Google's sensitive or restricted
    scope review. For personal or limited development use, users may see an unverified app warning and
    a 100-user cap. For public or organization-wide use, complete Google's OAuth verification process
    and any required restricted-scope review.

!!! note "Why Cerea needs the Scopes field"

    Google's servers advertise a long list of scopes (Gmail's includes `https://mail.google.com/`, full
    access to the mailbox). Left alone, Cerea asks for everything a server advertises. For Google, always
    fill in the **Scopes** field of the connector with only the scopes of the lists above and below.

### Create a Web application OAuth client

In **Google Auth Platform** > **Clients**, create an OAuth client:

- **Application type**: `Web application`
- **Name**: use a descriptive name, such as `Cerea Google Workspace MCP`

Add one authorized redirect URI, the same for every server you configure:

```text
https://chat.example.com/chat/mcp/callback
```

Replace `https://chat.example.com` with your Cerea origin (`PUBLIC_ORIGIN`). For local development, `http://localhost:3000/chat/mcp/callback` is accepted by Google.

Click **Create**, then copy the **Client ID** and **Client secret**.

### Add the MCP servers in Cerea

There is no configuration file to edit and nothing to restart. Add each server by its URL:

- **For yourself:** **Workspace → Connectors → Add connector**.
- **For everyone:** an administrator adds it under **Admin → Connectors**, which publishes it to every user. The definition is shared; each user still signs in as themselves, and the tokens stay theirs.

For each Google Workspace server:

1. Enter a name and the server's URL from the table above (for Gmail, `https://gmailmcp.googleapis.com/mcp/v1`).
2. Cerea asks the server how it signs users in and finds Google. Google does not offer dynamic registration, so choose **Sign in with my own app details (advanced)** and enter the **Client ID** and **Client secret** you copied. On an administrator's connector, the same fields are under **Add app details** once it is added.
3. In **Scopes**, enter only the scopes for that product (space or one per line), for example for Gmail:

   ```text
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.compose
   ```

   The other products use the lists below:

   | Server   | Scopes                                                                                                                                                                                                                                                                                     |
   | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | Drive    | `https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file`                                                                                                                                                                                                |
   | Calendar | `https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.readonly`                                                                                                         |
   | People   | `https://www.googleapis.com/auth/directory.readonly https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/contacts.readonly`                                                                                                                                    |
   | Chat     | `https://www.googleapis.com/auth/chat.spaces.readonly https://www.googleapis.com/auth/chat.memberships.readonly https://www.googleapis.com/auth/chat.messages.readonly https://www.googleapis.com/auth/chat.messages.create https://www.googleapis.com/auth/chat.users.readstate.readonly` |

4. Save, then click **Sign in**, and complete the Google OAuth flow in the browser:
   1. Review the requested scopes.
   2. Click **Allow**.

Changing a connector's scopes later signs every user out of it, so they approve the new scopes at their next sign-in.

Cerea adds `access_type=offline` and `prompt=consent` to Google's authorization request by itself, which is what makes Google issue a refresh token. Without them a Google connection would stop working after about an hour. Cerea also leaves out the `resource` parameter (RFC 8707) when it talks to Google, which does not use it. You do not set anything for either.

!!! info "`MCP_SERVERS` cannot carry this"

    Servers configured with `MCP_SERVERS` in `.env` take a fixed address and optional headers, not a sign-in
    per user, so a Google Workspace server is not one of them. Add it as a connector as above (the administrator's
    page publishes it to everyone).

After OAuth succeeds, the server's tools become available in chat. A connector's tools are used as described under "Using them" in [Connectors](connectors.md#using-them): the assistant sees the connectors that are on for the user, loads the one it needs, and calls its tools, which the user can turn off per conversation.

## Testing

Try prompts that target one server at a time:

| Server   | Prompt                                                                     |
| -------- | -------------------------------------------------------------------------- |
| People   | "According to my Google profile, what's my name?"                          |
| Drive    | "Find a file named Marketing Plan and summarize it."                       |
| Gmail    | "Find my latest email about the marketing plan."                           |
| Gmail    | "Draft an email to ariel@example.com saying I approve the marketing plan." |
| Calendar | "When is my next meeting with Ariel?"                                      |
| Chat     | "Search recent Google Chat messages about the marketing plan."             |

## Troubleshooting

| Symptom                                          | What to check                                                                                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google says `redirect_uri_mismatch`              | The Google OAuth client redirect URI must exactly match `https://<your Cerea origin>/chat/mcp/callback`, including protocol, hostname, port and path. Cerea builds it from `PUBLIC_ORIGIN`; the form shows the exact address. |
| Cerea shows the server but no tools              | Sign in to the connector first. OAuth-enabled remote servers expose tools after the user has authenticated.                                                                                                                   |
| **Sign in** is disabled                          | Google offers no dynamic registration, so the connector needs the client ID and secret (**Sign in with my own app details**, or **Add app details** on the row).                                                              |
| Google shows an unverified app warning           | This is expected for unverified apps requesting sensitive or restricted scopes. For personal or limited development use, users can continue through the warning until the project reaches Google's unverified user cap.       |
| OAuth works in testing but later expires         | External apps in testing mode can receive refresh tokens that expire after 7 days. Publish the app to production for longer-lived refresh tokens, or re-authenticate during development.                                      |
| The connection stops working after about an hour | Google issued no refresh token. Cerea asks for one on its own; check that the connector was signed in after the update that added this, and that the sign-in showed Google's consent screen.                                  |
| Google Chat configuration is disabled            | Use a Google Workspace-backed project/account for Chat, or omit the `chat` server.                                                                                                                                            |

## Security Notes

- Connect Google Workspace MCP servers only to Cerea instances you trust.
- Request only the products and scopes users actually need.
- Review assistant-suggested actions before sending email, posting Chat messages, uploading files, or changing calendar events.
- Treat email messages, documents, and chat messages as untrusted input. They can contain indirect prompt injection attempts that try to influence the assistant.
- For public or organization-wide deployments, complete Google OAuth verification and follow your organization's third-party app access controls.

## One server for all of Google Workspace: taylorwilsdon/google_workspace_mcp

[`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) (MIT license, Python) is a single MCP server for Gmail, Drive, Calendar, Docs, Sheets, Slides, Forms, Tasks, Contacts, Chat and Apps Script, with 120+ tools. It is a community project, not Google's.

- **Run it:** `uvx workspace-mcp`, with `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` from a Google Cloud OAuth client and the same prerequisites as above (APIs enabled, Auth Platform configured). Its own callback is `/oauth2callback` (`GOOGLE_OAUTH_REDIRECT_URI`, for example `http://localhost:8000/oauth2callback`), which you add to the OAuth client's redirect URIs.
- **Limit what it exposes:** `--tool-tier core|extended|complete`, `--tools gmail drive calendar` to choose services, `--read-only`.
- **Transports:** stdio (the default) and streamable HTTP (`--transport streamable-http`). Its OAuth 2.1 multi-user mode (`MCP_ENABLE_OAUTH21=true`) needs the HTTP transport.

With Cerea there are two ways:

1. **A local connector, for one user on their own machine.** Run it through `galopin` over stdio, so the Google credentials and tokens stay on that machine ([Local connectors](local-connectors.md)). In galopin's `mcp.json`:

   ```json
   {
   	"mcpServers": {
   		"google": {
   			"command": "uvx",
   			"args": ["workspace-mcp", "--tool-tier", "core"],
   			"env": {
   				"GOOGLE_OAUTH_CLIENT_ID": "${GOOGLE_OAUTH_CLIENT_ID}",
   				"GOOGLE_OAUTH_CLIENT_SECRET": "${GOOGLE_OAUTH_CLIENT_SECRET}"
   			},
   			"description": "Google Workspace"
   		}
   	}
   }
   ```

   On its first use the server opens a Google sign-in on that machine, through its own callback (it needs to be reachable from the browser on the same machine).

2. **An HTTP server you host, behind TLS,** with `--transport streamable-http`, added in Cerea as a connector by its URL. Cerea's own OAuth discovery against its OAuth 2.1 mode (`MCP_ENABLE_OAUTH21=true`) is **unverified**: this page has not been tested against it, and it is not known whether each Cerea user then signs in to Google as themselves. Try it with one user before relying on it, and prefer the first way, or the per-product servers above, in the meantime.

!!! warning "Not tested here"

    The commands above come from the project's README. Neither route has been run end to end from Cerea.
