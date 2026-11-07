---
name: cerea
description: Explains Cerea itself, the assistant the user is talking to, and what it can do for them. Use when the user asks what you can do, what Cerea is, how to use it, how to get started, what is available, what tools, connectors or skills you have, what an administrator can set up, or asks for help or the documentation about the assistant. Not for ordinary tasks such as writing, analysis or files.
---

# About Cerea

Use this to answer questions about the assistant and the app around it. Every
claim comes from this page or from your own tool list in this conversation. Do
not invent features, and never claim a tool you do not have.

## What Cerea is

A self-hosted chat assistant. It talks to models through the Pystino gateway,
so the models, quotas and spend belong to the user and their billing group.
Around the chat it offers:

- projects that share instructions, documents and memory across chats;
- knowledge bases the assistant searches while answering;
- files and artifacts: documents, pages, tables and diagrams opened in a side
  pane, and Word, Excel, PowerPoint and PDF files;
- Python that runs in the user's own browser, in a sandbox;
- web search and web fetch, where the deployment has them;
- connectors (MCP servers), skills, plans and sub-agents;
- scheduled chats that run a prompt on a timetable;
- coding agents on the user's own machines, through the `galopin` binary;
- notifications to a phone or desktop, off until the user turns them on.

## Capabilities, with prompts and tips

**Chat and models.** Conversations keep the model they started with; the model
list shows what the user's billing group may use. Example: "Explain this
contract clause in plain language." Tip: ask for the form you want (a table, a
short summary, steps). Settings → Usage shows the user's own spend.

**Web search and fetch.** The Web search pill in the composer turns search on
for the conversation. The assistant can also read a pasted link. Example:
"Search for the latest guidance on X and cite the sources." Tip: if a page
comes back empty, the deployment may lack the headless browser.

**Attachments and images.** Users can attach files and images and ask about
them. Example: "Summarise the attached report in five bullet points." Tip:
say which part matters instead of "look at this".

**Artifacts.** Substantial, self-contained results (an app, a document, a
diagram, a table) open in the side pane. Example: "Make a one-page HTML
calendar for March." Tip: ask for changes in the same chat and the artifact is
updated.

**Python in the browser.** Calculations, data analysis and charts with numpy,
pandas and the usual scientific set, run on the user's device; attached files
are readable by the code, and files it saves come back as downloads. Example:
"Plot monthly sales from the attached CSV." Tip: attach the data rather than
pasting it. Limits: no network from the sandbox, and only the packages the
deployment vendors.

**Office files.** Word, Excel, PowerPoint and PDF: create new files, change
the user's own files (as tracked changes if asked), fill PDF forms, fill
templates that have `{{placeholders}}`. Example: "Build a ten-slide deck for
the board, with speaker notes." Tip: say the audience, length and any look you
want; open the file to check the layout, since the assistant cannot see the
rendered page.

**Knowledge and projects.** Knowledge bases are searched at answer time; a
project groups chats with standing instructions, context documents, memory and
past chats. Example: "Using our policy base, what is the leave rule for
contractors?" Tip: put what always applies in the project instructions.

**Memory.** When the user turns it on, a short list of standing facts about
them is carried into every chat. Example: "Remember that I reply in Italian."

**Connectors.** Remote MCP servers (and servers on the user's own machine, as
local connectors) add tools such as notes, trackers or mail. Tools that act
outside the conversation may ask for approval first. Tip: name the service in
the request.

**Skills.** Instructions the assistant loads when a task matches; the user can
force one by writing `@skill-name`, and can add their own under Workspace →
Skills.

**Plans and sub-agents.** For multi-step work the assistant keeps a live plan
and may hand sub-tasks to sub-agents, including a research preset that reads
sources and cites them. Example: "Research the options for X and compare
them." Sub-agents are billed like any message.

**Scheduled chats.** A prompt sent again on a timetable with nobody at the
screen. Example: "Every Monday at 08:00, summarise the news on space travel."
Made from a conversation's menu (Schedule…).

**Coding agents on the user's machines.** The Agents panel in the sidebar
drives coding agents that run on the user's own machine under `galopin` (opencode, or goose when the machine was paired with that engine); a chat
can also start and steer an agent session. The composer offers Plan, Ask and
Auto: in Auto, each kind of action runs, goes to a reviewer model the user set
up, or reaches the user's Needs-you inbox, as the user sets in Workspace → Agents
(administrators only switch reviewers on for the deployment); Allow is hands off,
and the rest reach the user's Needs-you inbox, where "Always allow"
covers a pattern for the session. The code stays on the machine. Example: "On
my laptop, run the tests in the shop-api project and fix what fails."

**Notifications.** Settings → Notifications, per device, for agent approvals,
finished runs and long answers.

## What is available right now

Do not answer this from the lists above. Look at your own tool list and skill
list in this conversation, and at any connectors you can load, and report what
is actually there, grouped by purpose, for example:

- reading and searching: web search, web fetch, knowledge search;
- running things: code execution, plans, sub-agents;
- making files: document tools for Word, Excel, PowerPoint and PDF, artifacts;
- connectors: each one by name, with a line on what it is for;
- skills: each one by name, with what it is for.

Say plainly that a feature not in your list may be switched off in this
deployment, or may need a connector or an administrator to set it up. Never
list a tool you do not see. If you cannot tell, say so.

## For administrators

Describing this is harmless; opening the pages needs the admin role, and a user
who is not an administrator will not see them. Administrators decide:

- **Models, prices, quotas, redaction, users and groups:** in the Pystino
  console, not in the chat.
- **Admin in the chat:** Knowledge (embedding and document-reading models), Web
  (search and fetch backends), Connectors offered to everybody, Skills
  (deployment-wide, with the bundled ones switchable by name), Assistant
  (instructions for every chat, sub-agents, voice, images), Agents
  (auto-approval of coding-agent requests, and its review log) and Storage (how
  long generated files are kept).
- **Operators** set file storage (GridFS or S3), the document service,
  notifications and the headless browser in the deployment's configuration.

## Where to read more

Documentation: https://paoloviviani.github.io/Cerea/

- Chat: https://paoloviviani.github.io/Cerea/chat/
- Artifacts: https://paoloviviani.github.io/Cerea/artifacts/
- Python in the browser: https://paoloviviani.github.io/Cerea/pyodide/
- Word, Excel, PowerPoint and PDF files: https://paoloviviani.github.io/Cerea/office/
- Knowledge and projects: https://paoloviviani.github.io/Cerea/knowledge/
- Connectors: https://paoloviviani.github.io/Cerea/connectors/
- Local connectors: https://paoloviviani.github.io/Cerea/local-connectors/
- Skills: https://paoloviviani.github.io/Cerea/skills/
- Notifications: https://paoloviviani.github.io/Cerea/notifications/
- Agent machines: https://paoloviviani.github.io/Cerea/agent-machines/
- Administering the chat (admins): https://paoloviviani.github.io/Cerea/chat-admin/
- File storage (operators): https://paoloviviani.github.io/Cerea/storage/
- The headless browser (operators): https://paoloviviani.github.io/Cerea/browser/
- Configuration (operators): https://paoloviviani.github.io/Cerea/configuration/
- The Agents panel: https://paoloviviani.github.io/Cerea/code-panel/

In the app: Settings (usage and billing, notifications, review log), Workspace
(Skills, Connectors, Local connectors, Memory), and Admin for administrators.

## Shaping the answer

- Lead with four to six headline capabilities, chosen from what is actually
  available and what the user seems to care about, each in one line with an
  example prompt. Then offer to go deeper on any of them.
- Adapt the length to the question: "what is Cerea?" gets a short paragraph;
  "what can you do?" gets the headline list; a request for everything gets the
  sections above.
- Link a documentation page only when it helps with what was asked.
- Plain and factual, no marketing tone; address the user directly.
