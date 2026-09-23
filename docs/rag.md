# Knowledge bases (RAG)

**This is built, and it is ours** (ADR 0070). Bases, documents, chunks, vectors,
sharing and reindexing all live in this application; the gateway kept only the
two inference services the pipeline consumes — `POST /v1/embeddings`
(catalogue-managed, metered to the acting user's token) and `POST /v1/ocr` for
reading documents.

Where to look:

|                                               |                                                                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the code                                      | `src/lib/server/knowledge/` and `src/lib/server/projects.ts`                                                                                                                 |
| the types, and the header worth reading first | `src/lib/types/Project.ts`                                                                                                                                                   |
| the browser's paths                           | `/api/v2/gateway/vector_stores/…` and `/files`, served in-process behind the forwarder's allowlist                                                                           |
| the switch                                    | `CHAT_KNOWLEDGE_ENABLED` (`--components knowledge=on\|off`); the admin console's own `enabled`, which also needs an embedding model named, stays a separate product decision |
| the store                                     | Mongo for the things a person names, a chat-owned Postgres (`CHAT_PG_URL`, pgvector) for passages and vectors                                                                |

CLAUDE.md's _Projects and knowledge bases_ section carries the parts that
bite — the ObjectId/uuid boundary, why the `halfvec` width is formatted into
the SQL rather than bound, how sharing is decided against the viewer's own
identity, and why retrieval never fails a turn. Read it before changing any of
this.

## Decisions already taken

Cited by number; the decision record is private and deliberately not linked.

| Choice                    | Decision                                                                                                                                                                     | ADR        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Where the pipeline lives  | In this application, not the gateway. A knowledge base is something a person names, and the gateway had no reason to own it                                                  | 0070       |
| Vector store              | pgvector, in the chat's own database on the gateway's Postgres instance — a second database, not a second container. Retrieval is behind an interface so Qdrant stays a swap | 0018       |
| Document conversion / OCR | A configurable HTTP endpoint, not a hardcoded dependency. The gateway's `/v1/ocr` is what this calls; its local backend never sends the document anywhere                    | 0019, 0055 |
| Embeddings and reranking  | Configurable OpenAI-compatible endpoints, no bundled model. Embeddings route through the gateway, so indexing spend is visible                                               | 0020       |

Pin **pgvector >= 0.8.2**: 0.8.2 fixed CVE-2026-3172, a buffer overflow in
parallel HNSW index builds.

## Things to get right, learned the hard way

- **Embeddings are billable.** They go through the gateway's accounting rather
  than to an embedding endpoint directly, or indexing spend becomes invisible —
  and a large ingestion run can cost more than the chat traffic it serves.
- **Model-weight licences stay outside this tree.** Docling core is MIT (LF AI &
  Data), but individual models carry their own licences, and the faster
  alternatives are worse: Marker is GPL-3.0 code plus RAIL-M weights with a
  revenue restriction, MinerU has income-threshold conditions. Neither is OSI.
  The HTTP-endpoint design is what keeps that decision the operator's rather
  than ours.
- **Chunk metadata belongs in PostgreSQL alongside the vectors** while we are on
  pgvector; that transactional consistency is most of the reason for choosing
  it.

## Still open

Reranking. The embedding half of ADR 0020 is served; there is no `/v1/rerank`
on the gateway and no OpenAI-compatible shape to copy.
