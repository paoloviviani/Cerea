# Chat

!!! info "For everyone"

    Talking to the models your gateway exposes: conversations, models, attachments, search, approvals, memory and skills.

Cerea is a chat over the models the gateway exposes. Each call carries **your
own** sign-in token, so the quotas and the spend belong to you and your
billing group, not to the chat. What you can use is whatever the gateway
grants your groups: the model list, the search tier and the document reader
below are all per person.

## Your billing group

Every request is billed to one of your groups, and that group decides what
you are offered: **the model list shows exactly what your current billing
group can use** — not every model your groups collectively hold. You choose
the group in **Settings → Usage & billing**, and the model list follows the
choice at once; a model you had selected that the new group cannot use falls
back to the first one available, the way any model that disappeared from the
deployment does.

The same page is where your spend is shown — your own figures only: your
totals, your limits, and your share of a group limit that is charged to each
member separately. Limits that apply to the group or the deployment as a
whole are listed so you know they exist, without figures, because their
totals are not yours to see. If you manage a machine through the
[Agents panel](agent-machines.md), its billing follows the same rule, and
there it can also be set to follow this choice.

## Conversations

The sidebar has two trees, **Projects** and **Chats**, then a few single
entries at the foot: **Workspace**, **Settings** and, for administrators,
**Admin** ([Administering the chat](chat-admin.md)). A conversation keeps
the model it was started with. Projects group conversations that share
standing context and knowledge; each project has a page of its own, opened from
its row's `⋯` menu (**Project settings**). See [Knowledge and projects](knowledge.md).

In each of the two trees the **name** is a link and the small **chevron** beside
it opens and closes the list: click **Projects** to see all your projects on a
page, **Chats** to open the chat list below, and the chevron to fold the
branch without leaving where you are.

**Finding a chat.** The sidebar lists your recent chats. **Chats** opens a page
with all of them, newest first: the title, when it was last used, the model,
and the project it belongs to if it is in one. The search box is ready as soon
as the page opens; type part of a title and the list narrows. Capitals and
accents do not matter (`cafe` finds _Café Müller_), and what you type is taken
literally, so `c++` finds exactly that. Only titles are searched, not what was
said in the chats. Your own chats in projects are included; a colleague's chats
in a project shared with you are in that project's page, not here. Click a row
to open the conversation. Each row's `⋯` menu offers **Move to project…**,
**Remove from project** when the chat is in one, and **Delete**, which asks for
confirmation first, exactly as the sidebar's menu does.

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
and the text read from them, code-run files, its indexed transcript, and
anything a long-retired version copied for sharing it. **Delete all
conversations** includes chats inside projects. Deleting a **project** keeps its
chats and returns them to your ordinary list. A daily sweep removes files
left behind by anything that failed or by older versions, after a 24-hour
grace period.

## Dictation

Where your browser offers speech recognition (Chrome, Edge and Safari, including
Safari on iOS) and your administrator has left it on (see
[Voice](chat-admin.md#voice): by default it is offered only when the deployment
has no voice-recording model of its own), a **microphone button** sits at the right of the message box,
here and in the agent composer. Click it (or Tab to it and press Enter) to
start dictating and click it again to stop; its label reads **Start dictation**
or **Stop dictation**, and while it listens it turns red and pulses.

- What you say appears in the box as you speak, at the caret (or at the end if
  you have not clicked in the box), after whatever you had already typed.
  Nothing is sent: you read it, fix it and press Send yourself.
- Dictation stops when you type, send, click elsewhere, leave the page, or when
  the browser ends the session after a silence.
- It listens in your browser's language. There is no setting for it: change the
  browser's language to change what it recognises.
- A short message appears if it cannot run: microphone access blocked, no
  microphone, no speech heard, or no connection to the browser's speech
  service.

!!! warning "Your browser may send the audio to its vendor"

    Cerea ships no speech model and never receives the audio: your browser does
    the recognition. Chrome, Edge and Safari send what you say to their vendor's
    cloud service for it (so dictation needs a connection, and the vendor's
    privacy terms apply to that audio). **Firefox** has no speech recognition,
    so the button is not shown there. If that matters to you, type.

## Appearance

Your messages sit on the right in a light blue bubble (in dark mode a deep shade
of your accent colour, navy for the default Blue),
at most 85% of the width, so your turns and the replies are easy to tell apart
when you scroll; replies stay on the left in a neutral bubble. A long message
of yours folds behind **Show more**. Text is set in Inter, 16px in the chat.

**Settings → Application settings → Appearance** has three choices:

- **Theme:** System, Light or Dark. Kept in this browser, so each device can
  differ.
- **Accent colour:** Blue, Violet, Teal, Green, Rose or Orange. It colours
  buttons, links and the selected chat.
- **Background tone:** Gray, Slate or Stone: cool or warm greys behind the text.

The accent colour and the background tone are saved on your account and
applied before the page draws, so they follow you to every device.

Every combination keeps text and buttons at a contrast of 4.5:1 or better, in
light and dark.

## Models and effort

The model pill in the composer opens a list of models with a one-line
description each. With **ten models or fewer** it shows all of them. With more,
it shows a short list, the current model and the ones you picked recently (at
most six), with a search field, and **More models** opens the full searchable
picker. Changing the model in the composer changes it **for that
conversation**.

For a model that thinks, **Effort** in the same pill offers the levels that
model takes, plus **Default** (the model's own). Effort is per conversation. A
preset that pins its own effort shows it read-only.

The models themselves are managed in the **Workspace** page's **Models** tab.
There, **Set as default** decides what a _new_ chat starts on: an open
conversation keeps its own model. The list is the gateway's, and the switches
for a model's tools, vision and reasoning start from what the gateway
advertises for it; they are a default you can override, not a gate. (There is
no per-model system prompt any more: see below. Prompts that were stored per
model were dropped, not migrated.)

A model appears in the picker under the name your administrator gave it, when
the gateway carries one; otherwise under the id it is sent as. The two are
different on purpose — the id is what a request carries and what a conversation
stores, so it never changes, while the display name is set on the gateway's
model page ([Administering the gateway](chat-admin.md)).

### Custom models

The **Custom models** tab of the Workspace page (`/workspace?tab=custom`)
holds two things you write yourself.

**A global system prompt.** One text box, saved on your settings and sent with
**every chat message**, whatever the model. It is for chat only: the
[Agents panel](code-panel.md) and the titles Cerea generates never get it.
If your administrator has written instructions for every chat, they come
**before** yours and are shown above your box, read-only, as "From your
administrator". An administrator can choose not to show them: they still
apply, you just do not see them.

**Custom models.** A custom model is a name, a **base model** (any model you
can see, but not another custom model), a system prompt and an optional short
description. Names are unique among your own. Custom models are **private to
you** and are removed with your account.

- They appear in the model pill and in the models list **beside** the base
  models, marked _custom_ and named with their base, for example
  _Menu helper · GLM 5.3 Flash_.
- They inherit **everything** from the base: vision, tools, reasoning, the
  effort options and the per-model switches. Your effort choice goes to the base
  model.
- **The provider never hears of them.** A chat on a custom model keeps the custom
  model, but each message is sent to the base model.
- A custom model can be your **default** for new chats, and you can switch a
  conversation to or from one like any other model.
- **Delete** one and its conversations carry on, on its base model. If a base
  model leaves the gateway's list, a chat on a custom model built on it keeps
  working on the deployment's default model, and the tab marks the model as
  unavailable until you pick another base.

**What the model is told, in order:** the administrator's instructions (if
any), your global prompt, then the custom
model's prompt, then the project's standing instructions and context (see
[projects](knowledge.md)). Empty parts are skipped. Custom models are
chat-only: the Agents panel ignores them.

## Attachments

Attach a file with the composer's **+** (on a phone, it opens the file and photo picker), by dragging it onto the window, or by pasting: a long paste becomes a chip rather than flooding the box. Files are
limited to **10 MB** each.

- **Images** go to a model that can see them.
- **PDFs and Office documents** are bytes no model reads, so the gateway's
  document reader turns each into text. Word, Excel, PowerPoint, OpenDocument
  and EPUB files always go to the deployment's own reader, and old Word `.doc`
  files are read too, even when saved with a `.docx` name; only PDFs go to the
  reader an administrator chose, and a PDF whose chosen reader fails (a rate
  limit, say) is read by the local one. This happens **once, when you attach
  the file**, and the text is stored beside it. That is a billing decision:
  the reader is priced per page, so reading again on every turn would charge
  for the same twelve-page PDF on every question about it.
- **A scanned PDF** (pictures of pages, no text layer) is read **by the model**
  when the deployment's own reader is the one reading PDFs and the
  conversation's model can see images: the reader renders the pages (at most
  the first 20, or as many as `CHAT_PDF_IMAGE_PAGES` allows, so a longer scan says "only the first 20 of N pages"), they are
  stored as attachments of the conversation, and they are sent to the model
  exactly like images you attached, beside a note ("Scanned PDF name.pdf: pages
  1–N attached as images"). They are deleted with the conversation. A model that
  cannot see images is told the PDF is a scan and that it needs an OCR reader or
  a model that reads images; if you switch to such a model later, the stored pages
  are not sent (the note says so) and are sent again if you switch back. When a
  remote OCR model is the PDF reader, it reads the scan itself and no pages are
  rendered. Whether a model sees images is its **vision** switch under
  Workspace → Models.
- **A document with no readable text** (a scan the reader could not make sense of) is not skipped silently. The assistant is told the file had no readable text, and why when the reader said, so it says so rather than answering as if nothing were attached.
- **Code the assistant runs** finds the conversation's attachments at
  `/mnt/data/<name>`, with the text read from each beside it as `<name>.md`
  ([Python in the browser](pyodide.md#files-you-attach)).

**Previews and converted files.** Click a file in the conversation to open it in
the side pane. A deployment with the document converter ([Office
previews](office.md)) shows Word, Excel, PowerPoint and OpenDocument files as a
PDF, and the assistant can **convert** a file already in the conversation to a
PDF, or write Markdown or HTML out as one; the result is saved in the
conversation like any file it produced. Without the converter, decks are drawn in
the browser and other Office files can still be downloaded.

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
your app setting (on for new accounts; older accounts keep whatever they set),
then off. Nothing done inside a chat writes back to the settings.

When you paste a link, or search finds one, the assistant can also **fetch the
page** and read it. Some sites stay empty until JavaScript has run. If the assistant reports a page as empty, your deployment may not have the headless browser that reads pages the way a browser does; that is an operator's choice.

Fetching refuses addresses on the deployment's internal networks, so a page or a
model cannot point it at internal services: the `10.0.0.0/8` range and the
`100.64.0.0/10` range that mesh VPNs such as Tailscale and NetBird use are
refused, and so are loopback, link-local and the other private ranges. An
operator who must fetch from an internal host can allow the first two with
`CHAT_FETCH_ALLOW_INTERNAL_NETWORKS` ([Configuration](configuration.md#web-fetch));
[connectors](connectors.md) are not covered by this rule and may reach them. The same
rule applies to **Attach from URL**.

## Tool approvals

Some tools act outside the conversation, so by default (**Tools ask first**) they wait for you. (A [sub-agent](#plans-and-sub-agents) cannot wait for you, so it only uses what you have already allowed.) When the assistant wants to open a page that neither you nor a search result supplied, or to use a tool from a [connector](connectors.md), the answer pauses on an approval card showing what it wants to do and with what. You choose: allow this once, allow this tool for the rest of the conversation, or deny. If it wants several, you approve each one. A card you leave unanswered is **denied** when its time runs out.

The composer's **Tools ask first / Tools auto-approved** pill overrides the
policy for **this chat only**; the app-wide default lives in your settings.
Python the assistant runs in the [in-browser sandbox](pyodide.md) never asks first: it runs in your own browser, with no network access, so it cannot act outside the conversation.

## Location

Settings, Application, **Location** lets the assistant know where you are, so
answers about weather, local time, nearby places and units fit without you
typing it each time. It is off by default, and there are two ways to turn it on:

- **A place I type**, for example "Torino, Italy" (up to 100 characters, one
  line).
- **From this device**, which uses the browser's location permission. The
  browser asks only when you choose this option. Coordinates are rounded to
  about 1 km and read again whenever you open a chat. They stay in your
  browser and travel with each message; the server does not store them. If the
  permission is denied or the device cannot tell, the setting stays but nothing
  is shared.

While sharing is on, one line goes to the model provider with every chat
message, for example `The person's location (shared by them): Torino, Italy,
timezone Europe/Rome.` The line includes your browser's timezone. It is not
saved on the messages and the server never adds it to tool calls: the model
sees it as context and decides when it matters. It applies to chats only, not
to the /code panel or to title generation.

## Plans and sub-agents

With a model that can call tools, the assistant keeps a **plan** for work with
several steps: a short list of steps, one in progress, ticked off as it goes.
The plan card shows it live and stays in the finished message. A plan has at
most 20 steps, with one in progress at a time, and the assistant rewrites it
whole on each update (it keeps a one-paragraph statement of your goal beside it,
folding in corrections as you make them). It belongs to the conversation, so the
assistant sees its current plan again on your next message and revises it when
the request changes. For a simple question there is no plan. The plan is the
assistant's own working list: there is nothing to approve, and it does not
change what the assistant may do.

The assistant can also hand a self-contained sub-task to a **sub-agent**: a
second run of a model, in a fresh context, that sees only the brief it was
given and gives back only its final answer. Each one is its own card in the
message, with a title, the model it runs on, a live line for what it is doing
("searching ...", "reading ...") and, once done, its answer and the list of
steps it took. The assistant starts one with its `delegate` tool, and several
`delegate` calls in one step run side by side.

- **Which model.** By default the conversation's model. The assistant may pick
  another tool-capable model you can use (never one of your custom models), for
  instance a cheaper one for a simple lookup. The card names the model it ran on.
- **What it can use.** The same server-side tools as the chat: web search,
  fetching pages, and the [connectors](connectors.md) you have switched on. It
  cannot run code in your browser, make a plan, or start sub-agents of its own.
- **Approvals.** A sub-agent cannot stop to ask you. It may use a connector tool
  only when this conversation already allows it (you chose "allow this tool for
  the rest of the conversation", or tools are auto-approved); otherwise the call
  is refused, the card shows it as refused, and the assistant is told which tool
  needs your approval and can ask for it itself.
- **Limits.** **Three** run at once (a fourth is refused until one returns) and
  one message may start **ten** in all; the eleventh is refused, and the assistant
  is told to finish the rest itself or say what is left. Each sub-agent stops after
  **25 rounds** of tool calls, a budget of **400,000 tokens** or **eight minutes**,
  whichever comes first, and answers with what it has. The per-message limit on
  pages read is shared with it.
- **Stop.** The composer's **Stop** ends the message, and every running sub-agent
  with it.
- **Cost.** A sub-agent's model calls are billed to you like any message, and
  several in parallel use your quota faster.
- **Research.** Where web search is on, the assistant can start a **research**
  sub-agent: it plans queries, reads primary sources, cross-checks them and
  answers concisely with the sources it cites, saying where they disagree or are
  thin. It uses the web only.

An administrator can turn sub-agents off for the whole deployment, under
**Administration → Assistant → Sub-agents** ([Sub-agents](chat-admin.md#sub-agents)); the
assistant is then not offered `delegate` or `research`. Coding agents on your own
machines have their own, separate kind of delegation: see
[Delegating work](agent-machines-reference.md#delegating-work).

## Notifications

Cerea can send a notification to your phone or desktop when a long chat answer is
ready, or when one of your coding agents needs you or has finished, even with the
tab closed. It is off until you turn it on, per device, under **Settings,
Notifications**; see [Notifications](notifications.md).

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
shared [memory](knowledge.md#project-memory) and search its
[past chats](knowledge.md#past-chats).

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
