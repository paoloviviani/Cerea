# Office previews and `convert_document`

Optional, per deployment: the kit's `office` profile runs Gotenberg (LibreOffice
and Chromium) on an `internal: true` network reachable by the chat only, and
`CHAT_GOTENBERG_URL` tells the chat where it is. Unset means off everywhere.

- `src/lib/server/office/gotenberg.ts` is the client (deadline, size caps, PDF
  check, at most 3 conversions in flight). `CONVERTER_VERSION` is part of every
  preview's cache key: **bump it when the Gotenberg image or the conversion
  options change**, and previews are made again on their next view.
- `previewStore.ts` keeps previews in the chat's blob store (`files` bucket) as
  `preview-<version>-<sha256 of the source bytes>`, deliberately without a
  `metadata.conversation` tag. `metadata.owners` lists the source files using
  one (`att:<conversation or share id>-<stored sha>`, `out:<conversation>-<sha256>`,
  i.e. the source's own stored file name). Everything that deletes files calls
  `releasePreviewOwners` / `releasePreviewOwnerStrings` (conversation delete,
  deliverable delete and retention, share delete, account erasure), and the
  entry goes with its last owner. `sweepOrphanPreviews`, run by the daily orphan
  sweep, drops owners whose source no longer exists and old-version entries.
  A new path that deletes attachments or deliverables must release owners too.
- Lazy by default (`.../output/<sha>/preview` routes); model-produced Office
  files are converted when `storeDeliverable` stores them.
- `convert_document` (builtinTools) is registered only when Gotenberg is
  configured; the PDF is stored with `storeDeliverable` and listed through a
  `CodeExecution/Outputs` update.
- Without Gotenberg a `.pptx` is drawn in the browser by pptx-glimpse
  (`utils/pptxPreview.ts`): slides become `data:image/svg+xml` `<img>`s, never
  live SVG; fonts (OFL Carlito and Liberation, `static/fonts/office/`) are
  fetched only for the families a deck uses. `docs/office.md` is the user page.
