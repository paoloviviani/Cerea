# Projects and knowledge bases

The knowledge pipeline is **ours**: bases, documents, chunks,
vectors, sharing and reindexing live in this application — Mongo for the
things a person names, and a chat-owned Postgres (`CHAT_PG_URL`, pgvector) for
the passages and vectors. The gateway kept only the two inference services the
pipeline consumes: `POST /v1/embeddings` (catalogue-managed, metered to the
acting user's token) and `POST /v1/ocr` for reading documents. The browser's
paths did not move — `/api/v2/gateway/vector_stores/…` and `/files` are
served in-process by `src/lib/server/knowledge/`, behind the same forwarder
and its allowlist; only the handling is local now. Projects are **ours**
because a project groups _conversations_, and those live in Mongo.

Document reader choice (C97): the admin sets only the default
(`knowledgeConfig.extractorModel`); a base carries `VectorStore.readerModel`
and a user `Settings.documentReader` (own route `api/v2/user/document-reader`).
The list is `readerModelsFor` (`knowledge/readers.ts`: `/v1/models?include=ocr`
as given); a choice is validated at save (400) and re-checked at use in
`extractDocument`'s `chosenReader` (fallback to the default with a
`document_reader_fallback` log). `rereadDocument` re-extracts a file document
from its GridFS original through the background queue (`IngestOptions.reread`).

`src/lib/server/projects.ts` and `src/lib/server/knowledge/` are the whole of
it. Read the header of `src/lib/types/Project.ts` first; the parts that will
bite:

- **Postgres refuses a 24-hex ObjectId as `uuid`, and a pgvector type
  modifier cannot be a bind parameter.** `toUuid`/`fromUuid` (`db.ts`) are
  the boundary — pad to 32 hex, format; read back by taking the first 24. The
  search SQL formats the width into the cast (`::halfvec(N)`) because
  `::halfvec($1)` is a prepare-time _syntax_ error — an int from a checked
  range, never caller input. Ranking runs in half precision through partial
  expression indexes on `dimensions` (384…3072); storage stays full precision
  in an untyped `vector` column, because a fixed width would make changing
  the embedding model a schema change instead of a reindex.
- **Sharing is decided against the viewer's own identity** — their email and
  the groups `GET /v1/me` reports for _their_ token. Nothing asks the gateway
  who is in a group, because a bearer token cannot ask and a route that could
  would let a chat client enumerate the directory. The cost is that a share
  names a principal that may not exist: a typo and a colleague who has not
  signed in yet are indistinguishable.
- **A shared project shares instructions, knowledge and memory, not chats.**
  The conversations list returns only the caller's own, plus `othersCount`
  (never other members' titles or ids); conversations open for their author
  only. With past-chat indexing on, the assistant can recall chats from all
  members. The project page says so.
- **Sharing a project shares no documents.** Retrieval runs with the reader's
  own identity, so they see passages only from bases they could already read.
- **Retrieval never fails a turn.** Every error is logged
  (`project_retrieval_degraded`, `project_memory_index_failed`) and swallowed:
  a base being unavailable is a reason for a worse answer, not for none.
- **Indexing past chats is idempotent by handle.** The transcript is stored
  under `source_ref = chat:conversation:<id>`, which _replaces_ rather than
  appends — otherwise a ten-turn thread leaves ten overlapping copies and
  every search returns all of them.
- The memory base is an **ordinary knowledge base**, visible on the Knowledge
  screen and deletable there, named after its project. That is deliberate: the
  transcripts are somewhere a person can look.

## The project page, and what a project puts in a prompt

`components/projects/ProjectPage.svelte` is two tabs of one page, addressed like
the workspace panel: **Conversations** (the default — the strip with the count
and New chat, then the list of the project's chats) and **Settings**
(`?tab=settings` — everything that configures the project). A query change never
remounts the page, so the loaded project and unsaved edits survive a switch;
`/projects/new` has no tab bar, since everything it makes is settings.

The Settings tab's sections are the **five context levels** in the order
`projectContext` (`server/projects.ts`) builds the prompt — the one function
that assembles project context, and the order is part of its contract
(`projectContext.spec.ts` asserts it):

1. standing instructions (in full);
2. context documents (in full);
3. project memory (in full);
4. knowledge bases (searched);
5. past chats (searched).

The page's explainer lists the same five. Levels 2 and 3 re-check that the
person running the turn can still see the project (`projectForMember`): they are
what members write into each other's prompts. 4 and 5 share one retrieval
budget and are rendered as two blocks. Saving: the text fields and options share
one Save; actions (attach a base, a document, remove a chat) happen at once,
because unsaved attach state is how a base looks attached when it is not.

**Context documents** (`server/projectDocuments.ts`, `ProjectDocumentsSection`):
files whose extracted text goes into every prompt of that project. They go
through the chat's own writer (`writeAttachment`: same sniffing, extractor,
failure reasons, legacy `.doc`), once, at upload, owner-keyed `project:<id>` in
GridFS with the row's id as `messageId`; plain text gets an extracted entry of
its own so every document is read from one place. The budget
(`PROJECT_DOCUMENTS_MAX_CHARS` 100,000, warning at 50,000, beside the memory
limits in `types/Memory.ts`) is enforced where the cost is known: a project
already full refuses _before_ extracting (the extractor bills per page), a file
that tips it over is extracted, refused and removed, and a re-check after the
insert closes the race between two uploads. A failed extraction is a `failed`
row with its reason and contributes nothing. Files only: no `webkitdirectory`,
and `readDrop` refuses a dropped directory. Everyone who can see the project can
add and remove (like notes); the row keeps the uploader for display. Project
delete (`deleteProjectDocuments`), erasure (the `projectDocuments` roster entry,
which runs before `projects`) and the orphan sweep (`project:<id>` keys with no
project) all clean up the bucket entries — a `project:` tag the sweep did not
know would have been left alone for ever.

**Removing a chat from a project** (`DELETE /api/v2/projects/<id>/conversations/<cid>`)
is exactly what project delete does to each chat: clear `projectId`, then
`deleteDerived` its transcript from the project's memory base. The chat's author
or the project's owner may.

**Moving a chat in, between and out** is one operation, `PATCH
/api/v2/conversations/<id>` with `{ projectId: string | null }`
(`server/conversationProject.ts`; the DELETE above delegates to the same
detach). Into a project or between projects: the chat's author only, who must
also have access to the target (404 otherwise, like every project route). Out:
the author or the owner of the project the chat is in. Leaving a project calls
`deleteDerived`; entering one calls `indexConversation` with the whole existing
thread (it is whole-thread and idempotent by handle, so there is no per-message
backfill), not awaited. Instructions, documents and memory are read from
`projectId` every turn, so they apply from the next message. The UI shares
`useMoveConversation` (sidebar store, Projects tree, toast) between the row
menu, the picker (`MoveToProjectModal`), the sidebar drag (`chatDrag`) and the
project page's `MoveMenu`.

## Attaching a document to a message

A PDF or an Office file is bytes no model reads. `POST /v1/ocr` in the gateway
turns one into markdown, and `src/lib/server/files/extractDocument.ts` calls
it. The two things to know:

- **Extraction happens once, at upload**, and the text is stored beside the
  file as its own GridFS entry, named by `MessageFile.extracted`. That is a
  **billing** decision, not a caching one: `/v1/ocr` is priced per page, so
  re-extracting per turn charges for the same twelve-page PDF on every question
  about it. `scripts/test_attachments_live.py` asserts the count from the
  gateway's ledger, which is the only place that can tell the two apart.
- **A document with no readable text is not dropped.** `preprocessMessages`
  puts a sentence saying so in its place, because an attachment silently
  omitted makes the assistant answer as though nothing was attached while the
  person watching sees their file in the transcript.

Which model extracts is the Knowledge screen's choice, else `CHAT_OCR_MODEL`,
else the first `kind: ocr` model the caller may use. **A deployment with no
gateway at all skips that chain**: `CHAT_OCR_BASE_URL` (with
`CHAT_OCR_API_KEY` and a required `CHAT_OCR_MODEL`) makes extraction post to
`{base}/ocr` directly, which works because Pystino, Mistral and Cortecs serve
one shape. Set, it overrides the gateway path rather than falling
back to it, reads PDFs only, and caps a document at 10 MB — the base64 body of
a 20 MB PDF is ~27 MB and no vendor's limit for it is known. Unset, nothing
about the above changes. The deployment's own
extractor is not a special case — it is an ordinary model row on the gateway
whose provider is the local extractor service, and it shows up in the
catalogue like any other reader. There is no value that means "extract
nothing": one existed, and a deployment that held it read no documents while
being told it would. A model embedding wider than the store indexes (halfvec
stops at 4000) is MRL-truncated to the largest width the schema covers, and
the base's recorded width is what every later embed — search included — asks
for.

Two things found only by running `scripts/test_projects_live.py`, both worth
knowing before touching the model picker or writing another live check:

- **The model catalogue is global.** `src/lib/server/models.ts` builds it once
  at startup with the deployment's own key, so every account sees the same
  list. What it means is that this list cannot hide a model the way the
  gateway's per-caller `/v1/models` does. Per-user filtering would mean the
  catalogue stops being module state.
- **A turn is a multipart post**, with the JSON in a `data` field, needing an
  `Origin` header past the CSRF guard, and a first user message still needs
  its parent id — the create puts a system message at the conversation's root
  and `addChildren` refuses to guess. A JSON body there is a 500 from undici
  before any of this app's code runs.
