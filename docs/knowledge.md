# Knowledge and projects

!!! info "For everyone"

    Knowledge bases the assistant can search and projects that group conversations; the last section is for operators.

A **knowledge base** is a set of documents Cerea can search while answering.
You upload files to it, Cerea extracts their text, splits it into passages and
indexes them, and the model is given the passages relevant to each question. A
**project** groups conversations that share standing instructions and
knowledge.

## Knowledge bases

Create and fill a base from the **Workspace** page, under **Knowledge**
(`/workspace?tab=kb`). Upload PDFs, Office documents or text files. Each is
**read once, at upload**, and you can open a document to see the text that
search actually uses.

- A **scanned PDF** (pictures of pages, with no selectable text) comes out empty unless your administrator has chosen an OCR model. Open the document to check: if its text is empty, ask them.
  In a **chat**, a scan is also handled by the model: see [Attachments](chat.md#attachments).
- A file that **cannot be read** says why, in the same words to you and to the assistant: no reader is configured for that format, the reader refused the file (and what it said), the reader could not be reached, or the file holds no text. Only a PDF with no text layer is called a scan.
- Your bases are **yours to own and to share**. Sharing a base lets somebody
  read it; only you can change it.
- **After an administrator changes the embedding model**, your bases keep working on the old one and show that they are on an older model. **Reindex** brings a base up to date; it is billed to whoever presses it.

Indexing is billed to the person indexing, like any other call.

## Projects

A project is a way of organising **conversations**. Everything in it shares:

- **Instructions**, prepended to the system prompt of every conversation in the
  project.
- **Knowledge bases** attached to the project, searched on every turn (up to
  the project's retrieval limit, six passages by default).
- **Defaults for new chats**: web search on or off, and which
  [connectors](connectors.md) start selected; when the project leaves either
  unset, the app defaults apply.

The sidebar shows a project as a folder of its chats, and its `⋯` menu edits or
deletes it. **Deleting a project keeps its chats**: they return to your ordinary
list. The knowledge bases are their own resources with their own owner, so they
are kept too.

### Project memory

A project can keep a **memory base**: with **Search this project's own past conversations** on, finished
exchanges in the project are indexed into a knowledge base, so later chats can
draw on earlier ones. It is **off by default**, because it copies what was said
into a searchable store, and that is a decision worth making rather than
discovering.

- The memory base is an **ordinary knowledge base**, named after its project,
  visible on the Knowledge tab and deletable there. The transcripts are
  somewhere you can look.
- Each conversation is kept once: as it grows, its copy in the memory base is replaced, never duplicated.

This is a different thing from [personal memory](chat.md#memory), a short list
of facts about you that goes into every conversation, and from the project's
notes below.

### Project notes

A project also keeps a short **list of notes** that every member shares — a
convention, a decision and its reason, where something lives — and that goes
into every conversation **in that project** and nowhere else. It is the
[personal memory](chat.md#memory) list, moved from a person to a project, and
it is on whenever the deployment has memory on (`CHAT_MEMORY_ENABLED`); your
own opt-in for personal memory does not apply, because the notes are not about
you.

- **Everyone who can see the project can read, add, edit and delete notes**: the
  owner and everyone it is shared with. That is wider than the project's
  instructions, which only the owner changes. Each note shows who wrote it, its
  date and, if the assistant wrote it, the chat it came from.
- **The assistant can write them too.** In a project chat it is offered
  `remember_for_project` and `forget_for_project` as well as `remember` and
  `forget`, and the change shows in the transcript with an undo.
- **Limits.** A note is at most 2,000 characters and a project keeps 100. The
  prompt block has a budget of 8,000 characters; past it the **oldest** notes
  stop being sent, and the Memory section of the project dialog marks which.
- **Deleting a project deletes its notes.** Erasing a person's account deletes
  the notes in projects they own, with the project; notes they wrote in other
  people's projects stay, and show their author as "deleted user".
- A note is read by everyone in the project and goes into everyone's prompt, so
  never keep a password, key or token in one.

## Sharing

You can share a **base** or a **project** with a person (by email address) or a
group (by name).

- **Cerea can't check the name you type.** It can't look up who exists or who is in a group, so a typo in an address and a colleague who hasn't signed in yet look the same. The share list shows what you typed, not who it reached. Check the spelling.
- **A shared project is a shared workspace.** Everyone who can see it sees every
  conversation in it. The project page says so.
- **Sharing a project shares no documents.** Retrieval runs with the _reader's_
  own identity on every turn, so a reader sees passages only from bases they
  could already read. A project is never a way to publish a document without
  sharing it.

## When a base cannot be searched

**A base that can't be searched never stops an answer.** If the search service is down, you still get an answer, without those passages and without a warning. If an answer ignores a document you expected it to use, ask again later or tell your administrator.

## For operators

|                  |                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch           | `CHAT_KNOWLEDGE_ENABLED`: on unless set to `false`; `false` hides the Knowledge tab and the project and composer affordances                                                                |
| Passage store    | PostgreSQL with pgvector, as `CHAT_PG_URL`. cerea-deploy creates this database on the stack's Postgres. Use **pgvector 0.8.2 or later** (0.8.2 fixed CVE-2026-3172 in parallel HNSW builds) |
| Embeddings       | an embedding model in the gateway's catalogue (`POST /v1/embeddings`), chosen on the Knowledge screen by an administrator                                                                   |
| Document reading | the gateway's extraction endpoint (`POST /v1/ocr`). The stack's own extractor runs locally, so documents do not leave the deployment unless an operator configures an external OCR model    |

**Which reader takes which file.** The document reader you choose on the
Knowledge screen (or fix with `CHAT_OCR_MODEL`) is for **PDFs and images**: an
upstream OCR model such as Mistral's reads page pictures. Every other format
(Word, Excel, PowerPoint, OpenDocument, e-books) always goes to this
deployment's **local reader** (the gateway's model flagged `local`, the
stack's markitdown), whatever OCR model is selected, and is never sent to an
OCR model. With no local reader, an Office file fails with "No reader for Word
documents is configured" rather than being sent somewhere that cannot read it.
A legacy binary Office file saved under a `.docx` name (it sniffs as a
compound file, not a zip) is sent to the local reader as `application/msword`;
the reader looks at the bytes and either reads it or refuses with its own
reason, which is shown. A deployment with `CHAT_OCR_BASE_URL` and no gateway
reads PDFs only.

Changing the reader needs no reason; one sent by an older client is still
recorded in the change history.

Bases, documents and sharing records live in the chat's MongoDB; passages and
vectors live in PostgreSQL. Back up both (see cerea-deploy's README). The
variables are on [Configuration](configuration.md).

Limits: there is no reranking step yet; ranking runs in half precision over
indexed widths from 384 to 3072 dimensions, and a model embedding wider than
the store indexes is truncated to the largest width it covers. Model weights
for document conversion are not bundled: whatever the extraction endpoint runs
is the operator's choice, under its own licence.
