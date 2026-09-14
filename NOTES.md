# NOTES — feat/pyodide-execution

Task: client-side Python execution (Pyodide in a Web Worker), auto-run for
model-written code, wired into artifacts. Work ONLY in this worktree.
Resume = read this file, then `git log --oneline -12` to see where we stopped.

## Decisions taken (do not re-litigate)

- Pyodide (user-named), self-hosted dist under `static/pyodide/`, lazy-loaded.
- Auto-run for model-written python code blocks; HTML artifacts stay gated
  (PREVIEW_SANDBOX floor is kept; CSP added on top, see below).
- 50 MB cap enforced pre-download (Content-Length / stream abort).
- KB loading surface = the document's **indexed text** (`knowledgeDocuments.text`,
  already stored by ingest), NOT original GridFS bytes. The gateway forwarder
  comment says serving uploaded bytes back through this origin "is a decision
  with its own reasons" and was deliberately not taken; indexed text is what
  retrieval already serves. Endpoint added:
  `GET /api/v2/gateway/vector_stores/:sid/files/:docId/content` (viewer access).
- micropip: worker fetch is allowlisted to same-origin `/pyodide/*` only, so the
  default CDN index is unreachable; `micropip.set_index_urls("/pyodide/wheels/")`
  is the extension point. No wheels shipped by default — known limitation,
  recorded in docs/pyodide.md.

## Done (chronological, newest last)

- e7dab67f vendor pyodide 314.0.7 + sync script + predev/prebuild hooks (static/pyodide, gitignored)
- worker core: protocol.ts, gate.ts, pyodide.worker.ts, runtime.ts + 15 tests
- docs/pyodide.md (licence MPL-2.0, posture, micropip limitation, residual risks)
- chat auto-run surface: ChatMessage→MarkdownRenderer→MarkdownBlock→CodeBlock (assistant-only,
  streamed-this-session only), inline output, runs.svelte.ts; effect-loop bug fixed
  (untracked read + dedupe-on-any-existing) — 7 component tests
- artifact cells: artifactRuns.svelte.ts (localStorage, keyed identifier+version+content hash),
  RunOutput shared component, panel Run button + auto-run-when-streamed-live; 4 store tests
- KB loading: GET /api/v2/gateway/vector_stores/:sid/files/:docId/content (indexed text, viewer
  check, 50MB cap, allowlist+comment updated); files.ts fetchWithinCap (pre-body abort) +
  listKnowledgeFiles + mountKnowledgeFile/mountConversationFile; mounts.svelte.ts +
  ExecutionFiles picker + MountedChips in panel; files.spec.ts green (4)
- preview CSP: PREVIEW_CSP meta injected in all three srcdoc builders (previews only, deployed
  untouched), locked by new tests
- worker refactor: bootstrapWorker(scope) + REAL-dist integration test (boot/run/mount/
  gate-blocks-await/remove-guard) green; sync script ships pyodide.mjs.map
- typecheck/format fixes folded in as small commits

## Environment constraint found
mongodb-memory-server CANNOT run on this host: mongod 5+ needs AVX, the CPU answers SIGILL.
Affects ALL mongo-backed server specs repo-wide (pre-existing; verified with mcp/elicitation.spec.ts).
Non-mongo server tests (execution/*, files.spec) pass locally. Client suite runs in the
playwright container. Report mongo-spec status as "cannot execute on this host" (content.spec.ts
is written and waits for an AVX host / CI).

## Remaining
- full `npm run test` (server+ssr) + full client suite in playwright container; fix any fallout
- final report

## Facts learned (source-verified)

- ArtifactKind "code" already exists with `language`; `<artifact type="code" language="python">`
  parses, is NOT previewable, shows in the panel code view. No parser change needed.
- Code tokens carry `rawCode`, `lang`, `isClosed` (marked.ts processTokens);
  chain is ChatMessage → MarkdownRenderer → MarkdownBlock → CodeBlock.
  MarkdownRenderer knows nothing about message.from — pass autorun down explicitly.
- `getArtifactsContext()` (artifactsContext.ts) already reaches CodeBlock (requestFix).
- Preview sandbox: PREVIEW_SANDBOX in src/lib/utils/previewSrcdoc.ts, applied in
  HtmlPreviewModal.svelte + ArtifactPanel.svelte; no CSP attr today → opaque origin
  can still fetch() remote URLs; react/mermaid srcdocs load CDN scripts
  (cdn.tailwindcss.com, unpkg react@18, cdn.jsdelivr mermaid@11) — CSP must allow those
  script-src hosts or those previews break.
- Chat message files are served at `GET /conversation/:id/output/:sha256`
  (authCondition / shared conversation; Content-Length present; CSP sandbox header).
- Knowledge service: `listDocuments(storeId, caller)`, `reachableStore` role checks;
  documents carry `text` + `filename` on the row (Mongo knowledgeDocuments).
  Knowledge router lives inline in `src/routes/api/v2/gateway/[...path]/+server.ts`.
- vitest client project needs the playwright container (CLAUDE.md has the command).
- ADRs live in an external gitlab; licence precedent is prose in docs/*.md +
  README "Licensing" (LICENSE Apache-2.0 upstream / LICENCE EUPL-1.2 first-party).
