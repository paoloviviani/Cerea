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
standing context and knowledge; each project has a page of its own, opened from
its row's `⋯` menu (**Project settings**). See [Knowledge and projects](knowledge.md).

Everything a conversation does that has a cost is metered against your token:
the reply, the title Cerea generates from the first turn, reading a document,
embedding a passage, searching.

**When you reach a limit.** The reply that crosses your quota still completes; the next one fails with a message that your quota is used up. Where the deployment shows it, **Settings → Usage & billing** says where you stand. If your deployment redacts personal data, names or numbers in an answer can come back as placeholders such as `<PERSON_…>`, and a message containing something your administrator blocks (an API key, say) is refused without being sent.

**What the model knows about time.** Every reply is generated knowing the
current date and time **in your timezone** (the one your browser reports), as
one line at the end of its instructions. When you write after more than an
hour's silence, that message reaches the model with a short prefix such as
`(sent Sat 4 Oct 14:32, 3 hours after the previous message)`, so a chat picked
up a week later does not read as one sitting. The prefix is added for the model
only: it is never saved and never shown in the transcript.

**Deleting.** Deleting a conversation removes everything it stored: attachments
and the text read from them, code-run files, its indexed transcript, and any
**share link** made from it (the link stops working). **Delete all
conversations** includes chats inside projects. Deleting a **project** keeps its
chats and returns them to your ordinary list. A daily sweep removes files and
share links left behind by anything that failed or by older versions, after a
24-hour grace period.

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

Attach a file with the composer's **+** (on a phone, it opens the file and photo picker), by dragging it onto the window, or by pasting: a long paste becomes a chip rather than flooding the box. Files are
limited to **10 MB** each.

- **Images** go to a model that can see them.
- **PDFs and Office documents** are bytes no model reads, so the gateway's
  document reader turns each into text. This happens **once, when you attach
  the file**, and the text is stored beside it. That is a billing decision:
  the reader is priced per page, so reading again on every turn would charge
  for the same twelve-page PDF on every question about it.
- **A scanned PDF** (pictures of pages, no text layer) is read **by the model**
  when the deployment's own reader is the one reading PDFs and the
  conversation's model can see images: the reader renders the pages (at most
  the first 20, so a longer scan says "only the first 20 of N pages"), they are
  stored as attachments of the conversation, and they are sent to the model
  exactly like images you attached, beside a note ("Scanned PDF name.pdf: pages
  1–N attached as images"). They are deleted with the conversation. A model that
  cannot see images is told the PDF is a scan and that it needs an OCR reader or
  a model that reads images; if you switch to such a model later, the stored pages
  are not sent (the note says so) and are sent again if you switch back. When a
  remote OCR model is the PDF reader, it reads the scan itself and no pages are
  rendered. Whether a model sees images is its **vision** switch under
  Workspace → Models.
- **A document with no readable text** (a scan the reader could not make sense of) is not skipped silently. The assistant is told the file had no readable text, so it says so rather than answering as if nothing were attached.

Which model reads documents is decided by the **Knowledge** settings (an
administrator's choice, see [Administering the chat](chat-admin.md)); a
deployment can also point extraction at a reader directly
([Configuration](configuration.md)).

## Web search and web fetch

The **Web search** pill in the composer switches search on **for this
conversation**. It is your consent to spend: the search runs through the
deployment's search backends and is metered to you.

If you have no search backend (none in the gateway, or none granted to you),
the pill, the "on by default" switch in your settings and the project default
are shown disabled with "Web search isn't set up on this deployment"; an
administrator also sees where to fix it. Nothing is offered that could not
work.

This is the deployment's own search, not the model's. **Administration → Web
search** lists the search backends the gateway offers and lets an administrator
choose which one runs (`WEB_SEARCH_MODEL` in the environment overrides it).
With none chosen, or when you are not granted the chosen one, the gateway uses
your billing group's search policy, so the same question searches the same
sources whoever asks it.

Whether a new conversation starts with search on follows a chain: the
conversation's own state, then the project's default (inside a project), then
your app setting, then off. Nothing done inside a chat writes back to the
settings.

When you paste a link, or search finds one, the assistant can also **fetch the
page** and read it. Some sites stay empty until JavaScript has run. If the assistant reports a page as empty, your deployment may not have the headless browser that reads pages the way a browser does; that is an operator's choice.

## Tool approvals

Some tools act outside the conversation, so by default (**Tools ask first**) they wait for you. When the assistant wants to open a page that neither you nor a search result supplied, or to use a tool from a [connector](connectors.md), the answer pauses on an approval card showing what it wants to do and with what. You choose: allow this once, allow this tool for the rest of the conversation, or deny. If it wants several, you approve each one. A card you leave unanswered is **denied** when its time runs out.

The composer's **Tools ask first / Tools auto-approved** pill overrides the
policy for **this chat only**; the app-wide default lives in your settings.
Python the assistant runs in the [in-browser sandbox](pyodide.md) never asks first: it runs in your own browser, with no network access, so it cannot act outside the conversation.

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
- With memory on, you can just say it: "remember that I reply in Italian", "forget where I work". The assistant saves and removes facts itself, and you can add, edit and delete them on the tab, which shows who wrote each fact and in which conversation.
- Turning memory off stops it being used and written, but does not delete the
  facts. Deleting happens on the tab.
- If your deployment has switched memory off, the tab is not there.

For memory that scales beyond a list, use a knowledge base
([Knowledge and projects](knowledge.md)); a project can also keep its own
memory, and its own shared [notes](knowledge.md#project-notes).

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
