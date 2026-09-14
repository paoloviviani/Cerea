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

## Done
- (nothing committed yet)

## Next
1. npm i pyodide (pinned) + scripts/sync_pyodide.mjs → static/pyodide/, predev/prebuild hooks, .gitignore.
2. src/lib/utils/execution/: protocol.ts, pyodide.worker.ts, runtime.ts + tests.
3. docs/pyodide.md (licence MPL-2.0, posture, limitations).
4. Chat auto-run: prop chain ChatMessage→MarkdownRenderer→MarkdownBlock→CodeBlock (assistant-only).
5. Artifact code cells: version.type "code" + language python → run in panel; outputs keyed (identifier, version), persisted via content hash.
6. KB text endpoint + mount UI in artifact panel code view.
7. PREVIEW_CSP: default-src 'none', connect-src 'none', form-action 'none', img-src data:/blob:, script-src inline + existing CDNs (tailwind/unpkg/jsdelivr for the react+mermaid wrappers). Both preview iframes.
8. Verify: npm run check; npm run lint; npm run test; client suite in
   mcr.microsoft.com/playwright:v1.61.1-noble (see CLAUDE.md for exact command).
Commit style: reasoning statements ("X is nobody's to Y"), one-shot git identity:
`git -c user.name="Paolo Viviani" -c user.email="paolo.viviani@linksfoundation.com" commit ...`

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
