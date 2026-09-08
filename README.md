# Pystino Chat

A chat application over [Pystino](https://github.com/paoloviviani/Pystino),
the gateway. **Nothing is built here yet** — this repository starts empty on
purpose.

## The one architectural rule

This is a **`/v1` client**. It imports nothing from the gateway: no shared
database, no shared models, no Python package in common. It authenticates the
way any other client does — an API key, or an OIDC access token when the
deployment accepts them (ADR 0040, ADR 0046).

That is not fastidiousness, it is the lesson of the monorepo it replaces. The
chat lived on a branch of the gateway's repository, and on the day of the split
that branch was **56 commits behind**: three schema migrations and a changed
redaction seam. Every gateway improvement made the eventual merge worse, and
nobody was paying it down. A client that talks over a public interface has no
such debt — that interface is versioned, documented, and tested by the
gateway's own suite.

The corollary: if this application ever needs something the gateway does not
expose, the fix is a gateway feature with an ADR, not an import.

## What was not carried over

The previous version — `apps/chat-api` (30 files) and `apps/web` (37) — is
**not** in this repository. A deliberate restart rather than a migration. Its
history is preserved on the `archive/monorepo-chat` branch of the gateway's
repository if any of it is ever wanted.

What *was* carried over is the thinking: the component plans in [docs/](docs/),
and the decisions, which live with all the others in
[ai-stack](https://example.invalid/viviani/ai-stack).

## Decisions

The decision record is **not here**. It is one numbered series for the whole
endeavour, in
[ai-stack/docs/adr](https://example.invalid/viviani/ai-stack/-/blob/main/docs/adr/README.md),
covering the gateway, this application, the RAG pipeline and the design
language. Cite them by number — `(ADR 0040)` — which resolves wherever the file
lives.

Already recorded, and relevant here:

| | |
|---|---|
| [0015](https://example.invalid/viviani/ai-stack/-/blob/main/docs/adr/0015-frontend-stack.md) | The frontend stack |
| [0016](https://example.invalid/viviani/ai-stack/-/blob/main/docs/adr/0016-pwa.md) | A PWA |
| [0017](https://example.invalid/viviani/ai-stack/-/blob/main/docs/adr/0017-desktop-shell.md) | Desktop shell: Tauri v2 |
| [0018](https://example.invalid/viviani/ai-stack/-/blob/main/docs/adr/0018-vector-store.md) | Vector store: pgvector first, Qdrant behind an interface |
| [0020](https://example.invalid/viviani/ai-stack/-/blob/main/docs/adr/0020-embeddings-and-reranking.md) | Embeddings and reranking via configurable endpoints |
| [0021](https://example.invalid/viviani/ai-stack/-/blob/main/docs/adr/0021-code-sandbox.md) | Code execution sandbox: gVisor first |
| [0041](https://example.invalid/viviani/ai-stack/-/blob/main/docs/adr/0041-chat-frontend-stack.md) | The chat frontend stack |
| [0040](https://example.invalid/viviani/ai-stack/-/blob/main/docs/adr/0040-bearer-tokens-on-v1.md), [0046](https://example.invalid/viviani/ai-stack/-/blob/main/docs/adr/0046-local-api-credentials.md) | How this authenticates against the gateway |

Three of those — 0015, 0016 and 0041 — existed **only** on the monorepo's chat
branch and were rescued during the split. They would have gone with it.

## Planned components

Each gets a document rather than an empty directory, because a directory whose
only file is a README is a document pretending to be code:

- **[docs/rag.md](docs/rag.md)** — ingestion and retrieval: chunking,
  embedding, indexing, and a retrieval API the frontend can configure.
- **[docs/desktop.md](docs/desktop.md)** — a Tauri v2 shell around the web app,
  plus computer use. A shell, not a second client.
- **[docs/shared.md](docs/shared.md)** — TypeScript types shared between the
  web app and the shell, **generated** from the gateway's `/openapi.json`
  rather than written by hand.

## Licensing

EUPL-1.2 for first-party code, and it is a hard requirement rather than a
preference — see
[ADR 0001](https://example.invalid/viviani/ai-stack/-/blob/main/docs/adr/0001-licensing.md).
Anything with a non-OSI licence, a CLA or an open-core model needs a decision
before it is adopted. That rule is restated here rather than only linked,
because a licence policy living in another repository is a policy nobody reads.

## The name

Likely to change.
