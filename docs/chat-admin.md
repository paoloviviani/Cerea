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

| Section        | What you decide                                                                                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Knowledge**  | Which embedding model the deployment uses and which model reads documents, on one screen with the consequences: see below. Hidden when the deployment turns the knowledge pipeline off (`CHAT_KNOWLEDGE_ENABLED=false`) |
| **Web search** | Which search backend the composer's Web search pill uses, picked from the search backends the gateway offers (not hidden when knowledge is off)                                                                         |
| **Fetching**   | Which backend fetches a URL: a plain HTTPS request, or the [headless browser](browser.md), with a live check of whether the renderer answers                                                                            |
| **Connectors** | MCP servers offered to everybody: see [Connectors](connectors.md#connectors-for-everybody)                                                                                                                              |
| **Skills**     | Deployment-wide skills that every account sees; the bundled ones can be switched off by name (`CHAT_SKILLS_DISABLED`)                                                                                                   |
| **Storage**    | How long files produced by code are kept: see below                                                                                                                                                                     |

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
