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

- A **scan with no text layer** needs an OCR model; the deployment's own reader
  reads text layers only.
- Your bases are **yours to own and to share**. Sharing a base lets somebody
  read it; only you can change it.
- **Reindex** after an administrator changes the embedding model. A base
  remembers the width its vectors were built at, so the reindex is what
  brings it in step.

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
- Indexing is idempotent per chat: a conversation's transcript is stored under
  one handle and _replaces_ itself, so a ten-turn thread does not leave ten
  overlapping copies for every search to return.

This is a different thing from [personal memory](chat.md#memory), a short list
of facts about you that goes into every conversation.

## Sharing

You can share a **base** or a **project** with a person (by email address) or a
group (by name).

- **Access is decided against the viewer's own identity**: their email, and the
  groups the gateway reports for _their_ token. Nothing asks the gateway who
  is in a group, because a bearer token cannot ask, and a route that could
  would let a chat client list the directory. The cost is that a share names a
  principal that may not exist: **a typo and a colleague who has not signed in
  yet look the same**, and you see the shares you wrote, not the people they
  resolved to.
- **A shared project is a shared workspace.** Everyone who can see it sees every
  conversation in it. The project page says so.
- **Sharing a project shares no documents.** Retrieval runs with the _reader's_
  own identity on every turn, so a reader sees passages only from bases they
  could already read. A project is never a way to publish a document without
  sharing it.

## When a base cannot be searched

**Retrieval never fails a turn.** If a base is unavailable (the embedding
service is down, say), the answer still comes, without those passages. The
failure is logged, never shown as an error: a base being unavailable is a
reason for a worse answer, not for none.

## For operators

|                  |                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch           | `CHAT_KNOWLEDGE_ENABLED`: on unless set to `false`; `false` hides the Knowledge tab and the project and composer affordances                                                                |
| Passage store    | PostgreSQL with pgvector, as `CHAT_PG_URL`. cerea-deploy creates this database on the stack's Postgres. Use **pgvector 0.8.2 or later** (0.8.2 fixed CVE-2026-3172 in parallel HNSW builds) |
| Embeddings       | an embedding model in the gateway's catalogue (`POST /v1/embeddings`), chosen on the Knowledge screen by an administrator                                                                   |
| Document reading | the gateway's extraction endpoint (`POST /v1/ocr`). The stack's own extractor runs locally, so documents do not leave the deployment unless an operator configures an external OCR model    |

Bases, documents and sharing records live in the chat's MongoDB; passages and
vectors live in PostgreSQL. Back up both (see cerea-deploy's README). The
variables are on [Configuration](configuration.md).

Limits: there is no reranking step yet; ranking runs in half precision over
indexed widths from 384 to 3072 dimensions, and a model embedding wider than
the store indexes is truncated to the largest width it covers. Model weights
for document conversion are not bundled: whatever the extraction endpoint runs
is the operator's choice, under its own licence.
