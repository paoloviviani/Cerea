# Knowledge bases

A knowledge base is a set of documents Cerea can search while answering. You
upload files to it, Cerea extracts their text, splits it into passages and
indexes them, and the model is given the passages relevant to each question.

## Using them

- **Create and fill a base** from the workspace page, under **Knowledge**
  (`/workspace?tab=kb`). Upload PDFs, Office documents or text files. Each is
  read once, at upload.
- **Attach bases to a project.** Every conversation in the project searches
  them. A project can also keep a **memory base**: past conversations in the
  project are indexed into it, so later chats can draw on earlier ones. The
  memory base is an ordinary knowledge base, visible and deletable like any
  other.
- **Share a base or a project** with people (by email) or groups. Sharing is
  checked against the reader's own identity. Sharing a project does not share
  its documents: every reader sees only passages from bases they can read
  themselves.

When a base cannot be searched (the embedding service is down, say), the
answer still comes, without those passages. The failure is logged; it never
fails the turn.

## What the deployment needs

|                  |                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch           | `CHAT_KNOWLEDGE_ENABLED=true` (on in every cerea-deploy preset)                                                                                                                             |
| Passage store    | PostgreSQL with pgvector, as `CHAT_PG_URL`. cerea-deploy creates this database on the stack's Postgres. Use **pgvector 0.8.2 or later** (0.8.2 fixed CVE-2026-3172 in parallel HNSW builds) |
| Embeddings       | an embedding model in the gateway's catalogue (`POST /v1/embeddings`), chosen on the Knowledge screen. Indexing is billed to the person indexing, like any other call                       |
| Document reading | the gateway's extraction endpoint (`POST /v1/ocr`). The stack's own extractor runs locally, so documents do not leave the deployment unless an operator configures an external OCR model    |

Bases, documents and sharing records live in the chat's MongoDB; passages and
vectors live in PostgreSQL. Back up both (see cerea-deploy's README).

## Limits

- There is no reranking step yet.
- Changing the embedding model means reindexing the base, which the Knowledge
  screen offers.
- Model weights for document conversion are not bundled. Whatever the
  extraction endpoint runs is the operator's choice, under its own licence.

The code is in `src/lib/server/knowledge/` and `src/lib/server/projects.ts`;
read the header of `src/lib/types/Project.ts` before changing it.
