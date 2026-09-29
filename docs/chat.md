# Chat

!!! info "For everyone"

    Talking to the models your gateway exposes: conversations, models, attachments, search, approvals, memory and skills.

Cerea is a chat over the models the gateway exposes. Each call carries **your
own** sign-in token, so the quotas and the spend belong to you and your
billing group, not to the chat. What you can use is whatever the gateway
grants your groups: the model list, the search tier and the document reader
below are all per person.

## Conversations

The sidebar has two trees, **Projects** and **Chats**, then a few single
entries at the foot: **Workspace**, **Settings** and, for administrators,
**Admin** ([Administering the chat](chat-admin.md)). A conversation keeps
the model it was started with. Projects group conversations that share
standing context and knowledge; see [Knowledge and projects](knowledge.md).

Everything a conversation does that has a cost is metered against your token:
the reply, the title Cerea generates from the first turn, reading a document,
embedding a passage, searching.

## Models and effort

The model pill in the composer opens a short list: the current model and the
ones you picked recently (at most six), each with a one-line description, and a
search field. **More models** opens the full searchable picker. Changing the
model in the composer changes it **for that conversation**.

For a model that thinks, **Effort** in the same pill offers the levels that
model takes, plus **Default** (the model's own). Effort is per conversation. A
preset that pins its own effort shows it read-only.

The models themselves are managed in the **Workspace** page's **Models** tab.
There, **Set as default** decides what a _new_ chat starts on: an open
conversation keeps its own model. The list is the gateway's, and the switches
for a model's tools, vision and reasoning start from what the gateway
advertises for it; they are a default you can override, not a gate.

## Attachments

Attach a file with the composer's **+**, by dragging it onto the window, or by
pasting: a long paste becomes a chip rather than flooding the box. Files are
limited to **10 MB** each.

- **Images** go to a model that can see them.
- **PDFs and Office documents** are bytes no model reads, so the gateway's
  document reader turns each into text. This happens **once, when you attach
  the file**, and the text is stored beside it. That is a billing decision:
  the reader is priced per page, so reading again on every turn would charge
  for the same twelve-page PDF on every question about it.
- **A document with no readable text** (a scan the reader could not make
  sense of) is not silently dropped. Cerea puts a sentence saying so in its
  place, so the assistant does not answer as though nothing was attached
  while your file sits in the transcript.

Which model reads documents is decided by the **Knowledge** settings (an
administrator's choice, see [Administering the chat](chat-admin.md)); a
deployment can also point extraction at a reader directly
([Configuration](configuration.md)).

## Web search and web fetch

The **Web search** pill in the composer switches search on **for this
conversation**. It is your consent to spend: the search runs through the
deployment's search backends, chosen by the gateway from your billing group's
policy, and is metered to you. The tool only exists when the gateway has
granted you a search tier, so the pill costs and changes nothing without one.

This is the deployment's own search, not the model's: the gateway runs it on
a backend your group's policy names, so the same question searches the same
sources whoever asks it. (The gateway can also meter search that a model
provider executes itself, when a model offers one — a separate path this
chat does not send today.)

Whether a new conversation starts with search on follows a chain: the
conversation's own state, then the project's default (inside a project), then
your app setting, then off. Nothing done inside a chat writes back to the
settings.

When you paste a link, or search finds one, the assistant can also **fetch the
page** and read it. By default the chat fetches directly over HTTPS; with the
[headless browser](browser.md) on, it renders the page first, which works for
pages that are empty until JavaScript has run.

## Tool approvals

Some tools act beyond the conversation, so they ask first. **By default
(`manual`), a call to `web_fetch` on a page neither you nor the search
supplied, and every call to an MCP tool from a [connector](connectors.md),
stops on an approval card** showing the tool and its arguments, with three
choices: allow this one call, allow this tool for the rest of the
conversation, or deny. Several calls in one round are approved one at a time.
An approval left unanswered **fails closed**: it is denied when its time
runs out.

The composer's **Tools ask first / Tools auto-approved** pill overrides the
policy for **this chat only**; the app-wide default lives in your settings.
Code you run in the [in-browser sandbox](pyodide.md) is not gated this way, since
it runs in your own browser.

## Memory

Memory keeps a few short **standing facts about you** and carries them into
every conversation, so you need not repeat "reply in Italian". It is **off
until you turn it on** in your settings, because it writes things you said
into a store that outlives the conversation.

- It is a **list, injected whole** on every turn, not a search: what the
  **Memory** tab of the Workspace page shows is exactly what the model sees.
- A fact is at most 400 characters and you can keep 200. The prompt block has
  a character budget (1,500), and past it the **oldest** facts stop being
  sent, which the tab says.
- The model can write and remove facts itself (`remember`, `forget`) when
  memory is on; you can add, edit and delete them on the tab. Each fact shows
  whether the model wrote it or you did, and which conversation it came from.
- Turning memory off stops it being used and written, but does not delete the
  facts. Deleting happens on the tab.
- A deployment can remove the feature entirely (`CHAT_MEMORY_ENABLED=false`);
  then the tab is hidden too.

For memory that scales beyond a list, use a knowledge base
([Knowledge and projects](knowledge.md)); a project can also keep its own
memory.

## Skills

A **skill** is a set of instructions for a kind of task, written as a
`SKILL.md` file (a name, a description, and a markdown body), optionally with
files bundled beside it. The **Skills** tab of the Workspace page adds them,
including from a zip of a skill folder, so a skill written elsewhere ports in
unchanged.

Every enabled skill's name and description ride each turn; the model loads a
skill's full text when the task matches, or you force it by writing
`@skill-name` in your message. Skills are personal (no sharing, no versions),
though an administrator can provide deployment-wide ones that everybody sees.

A skill is **instructions, never code that runs on the server**. If it needs
Python, the model runs it in the [browser sandbox](pyodide.md). A skill whose
workflow needs a shell is out of scope by design.
