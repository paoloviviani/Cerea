# Document tools (`doc_outline`, `doc_read`, `doc_edit`, `doc_create`, `doc_create_from_template`)

ADR 0103. The `documents/` service (Python, own CI job, own image
`cerea-documents`, versioned with the chat) edits Word, Excel and PowerPoint
files; the chat reaches it at `CHAT_DOCUMENTS_URL` with `CHAT_DOCUMENTS_SECRET`.

- `src/lib/server/documents/client.ts` is the client: deadline, error mapping
  (401/413/415/422/504 to plain messages), `getCapabilities()` cached a minute
  (shorter after a failure). `runMcpFlow` resolves it per turn and hands it to
  `getEnabledBuiltinTools({ documentCapabilities })`; null means no `doc_*` tool.
- `builtinTools/documentTools.ts`: `doc_edit`'s text is **generated from the
  service's `operation_schemas`** in `/v1/capabilities` (one source of truth),
  and only operations the service lists are offered. A new service operation
  needs no change here. `documentsContract.spec.ts` checks every operation in
  `capabilities.fixture.json`, which `documents/tests/test_api.py` keeps equal to
  the live service: regenerate the fixture (command in the spec) when the service's
  schemas change.
- Files are named as `convert_document` names them (`conversationFiles.ts`:
  attachments by their `/mnt/data` name, produced files by name, this
  conversation only, access re-checked on every read). The document tools edit
  the **current** version of a name, produced file or attachment — an
  attachment re-uploaded under the name is the newest content by construction
  and takes over as the edit source — so edits chain.
- An edit is stored with `storeDeliverable` under the **source's name** (the
  next version of the same file artifact, which `collectFileArtifacts` folds by
  name), with `derivedFromSha256/Name` on the store row, and listed through an
  `Outputs` update (`runKey` `doc_edit:<uuid>`, so it renders as a file card).
  The original is never touched.
- **Versions** (`conversationFiles.ts`, `listFileVersions`): a name's versions
  are its attachment and its stored rows, one number per version (the
  attachment is 1, or the next free number when it was uploaded after the
  name already had versions; numbered at upload, `MessageFile.version`);
  numbers are stored at insert (`version`, `fileVersions.ts`; old rows are numbered by position once), so expiring older rows never renumbers; rows are unique per (conversation, name, content, version). `doc_outline`, `doc_read`, `doc_edit`, `look_doc` and
  `convert_document` take `version` (a number, or "previous"; `parseVersion`,
  `VERSION_PROPERTY`), and `doc_outline` lists the versions (`file_versions`,
  when there is more than one), so no extra tool. `doc_edit` with `version` and
  no operations restores. The store keeps one row per content, so a result whose
  bytes equal an earlier version marks that row current (`latestAt`,
  `markCurrentVersion`) instead of copying it; the current version is the one
  that became newest last — a row by the latest `latestAt ?? createdAt`, the
  attachment by its message's timestamp. The sandbox mounts the current
  version of every name at `/mnt/data/<name>` — except that two attachments of
  one name with different content (attached, then re-uploaded) are two mounts,
  the first at `<name>` and the later at `<name> (2)` (`planAttachments`), so
  the bare name keeps the first upload, and the prompt names the path
  (`AttachmentMounter.syncProduced`, listed per run from `code-execution/output`): a produced row is mounted over
  the attachment of that name unless the attachment is the current version —
  a re-upload is the newest content by construction; earlier versions are not
  mounted. The
  chat page registers its conversation with `trackAttachmentSource`
  (`$effect.pre`): a plain `$effect` runs after a child code card's run and the
  first run saw an empty `/mnt/data`.
- Creation (step 3): `doc_create` and `doc_create_from_template` are offered
  when the service reports `create` / `create_from_template`. `doc_create`'s
  definition is **short** (format, `spec` as an object, names the skill of each
  format); the full per-format spec is **generated from `create_schemas`**
  (`createFormatSpec`; `describeSchema`; the theme, a text run and a table cell
  are printed once as shared aliases) and delivered two ways from the one
  generator: appended to the `word`/`excel`/`powerpoint`/`pdf` skill's text when
  loaded (`skills/documentSpec.ts`, in `load_skill` and `@name`), and in the
  error of a `doc_create` the service rejected (422) or whose `spec` is not an
  object. Nothing tracks what was loaded: a model that skips the skill is
  corrected by the error. Sub-agents (`delegate`) have no document tools. The
  created file is stored under the requested or title-derived name (creating again
  under a name is the next version; `derivedFrom` records an uploaded template),
  and listed through an `Outputs` update like an edit. `theme.template` is a file
  name in the conversation: the tool sends its bytes as the `file` part and
  rewrites the name to the bare file name. The skills (`word`, `excel`,
  `powerpoint`, `pdf`) carry one rule, "the `doc_*` tools are the ONLY way", with
  the sandbox method in a labelled last "Fallback" section; `officeSkills.spec.ts`
  pins that wording, so a change to a skill must keep the two apart. The execution
  prompt's generic "write binary files with python-docx..." sentences name the
  same exception.
- Decks (`documents/src/cerea_documents/make_pptx.py`, schema in `spec.py`): six
  built-in 16:9 layouts, body text 24/22/20/18 pt stepping down to 14 pt (below
  16 pt a note suggests splitting the slide), content kept below the title.
  A slide takes a `background` (colour, two-colour gradient, or a picture
  `fit: "cover"`; `theme.slide_background` for all) and up to 30 `shapes` (`rect`,
  `rounded_rect`, `ellipse`, `line`, `arrow`, `chevron`, `text`; cm on the slide;
  `layer` back by default, so behind the placeholders). Shapes with text (a `text`
  kind, or `text`/`runs`) must lie fully on the slide; a **decorative** shape may
  **bleed** (`x_cm`/`y_cm` from -50) if at least `MIN_SEEN_CM` (0.5 cm) shows on
  both axes (`_bleeds`, `_check_shape_bounds`, all checked before anything is
  built, so a 422 names `slides[i].shapes[j]`, the values and the slide size).
  Warnings, not errors, go into the result's notes: contrast under 4.5:1 of the
  theme's text colours on a solid background, a shape over a placeholder or
  content (`OVERLAP_CM`), overflow. `theme.slide_background` and the shapes are
  new in 0.31.0, the bleed in 0.31.1.
- Range errors from the schema check (`spec.py` `_check`, `_friendly`) state the
  field, the value and the allowed range ("-70 is less than the minimum (-50);
  allowed range -50 to 100"); `properties`/`required` are put in the details only
  for `additionalProperties` and `required` failures, where the parent's keys
  help.
- The tool card shows object arguments. `ToolCall.parameters` holds primitives, so
  `mcp/toolParams.ts` `toPrimitive` keeps an object or array argument (a document
  `spec`) as compact JSON text, cut at `MAX_PARAM_JSON_CHARS` (20,000) with a
  visible "... (N more characters)" and not dropped. `ToolUpdate.svelte`
  pretty-prints JSON text that parses (`expandJsonText`) and shows cut text as it
  is. It applies to every tool, not only the document ones.
- The PowerPoint skill: the tools are the default; an **explicit** request for a
  custom design the tools cannot express (free-placed cards, an infographic) is
  built in the sandbox from the skill's "Fallback" section, said in one line, and
  never mixed with the tools in one deck; an unclear request asks through
  `ask_user_question` with two options. `officeSkills.spec.ts` pins the wording.

- PDF forms (Cerea #39): `formats.pdf` in the capabilities lists the PDF operations, `fill_form` and `place_text`
  (`doc_edit`'s text shows them as the PDF line, plus a short note from `pdfNote` in `documentTools.ts`; one
  operation per call), and `read` is false (`doc_read` refuses a `.pdf` without a call). `doc_outline` on a PDF
  returns its pages (size and the text lines with positions, `pdflayout.py`: at most 200 per page, estimated
  widths) and `form` (fields with type, pages, value, allowed values, flags, `rect`, `label` and `table`; `xfa`).
  Positions are PDF points, origin bottom left. Labels: the text to the left on the field's line (down to the
  previous field), else the column header above for a grid (`table: {id, row, col}`), else the text just above.
  `place_text` (`pdfplace.py`) draws Helvetica text into the page as an overlay, bounds-checked, refused on a PDF
  with fields unless `allow_on_form`, and re-extracted for the verify report. `flatten` is saved by the chat as
  `<name>-flattened.pdf` (the result's `save_as_suffix`) unless `flatten_in_place`. Text that does not fit a field
  is shrunk (6 pt floor) and listed in `clipped`. `look_doc` draws form fields (`init_forms()`; this PDFium has no V8 or XFA). Page text is read once (`pdflayout.Layout`) for the first 40 pages only, with a 6 s safety net; fields on later pages come without label or table and `labels_note` says so. Positions are in the page's own space: `pages` gives `origin_x/y` for a cropped page, and `place_text` checks the crop box and refuses a rotated page's item unless it is within 30 pt of a listed line. Control characters are refused in placed text and form values. `documents/.../pdfform.py` is the whole
  of the logic and is **copied** into the `pdf-tools` skill's `scripts/pdf_tools.py` between two markers by
  `scripts/sync_pdf_tools.py` (`documents/tests/test_pdf_tools_helper.py` fails when it is stale, and CI's
  `documents` job runs when either file changes): edit `pdfform.py`, run the script, never the copy. Values are
  all checked before anything is written; `/Btn` fields are set by hand (the library writes a radio's value as
  text), `/Ch` appearances are drawn by us (the library's list box is wrong), `flatten` draws the appearances
  into the pages and removes the form, because the library's `flatten=` leaves the widgets in place. The
  skill's rule: when `doc_edit` is offered a form is filled only through it; the sandbox helper is the last,
  labelled section (`officeSkills.spec.ts` pins it). Fixtures are built in `documents/tests/pdf_fixtures.py`.

- `look_doc` (Cerea #38): `builtinTools/lookDocTool.ts`. The model sees pages or slides of a Word, Excel,
  PowerPoint or PDF file in the conversation (at most 6 per call, 1-based numbers or ranges, `parsePages`).
  An Office file goes to PDF through the preview cache (`getOrCreatePreview`, owner `att:`/`out:` as the preview
  routes use, so a file already previewed costs no conversion); a PDF is used as it is. The PDF goes to the
  documents service's `POST /v1/render` (`documents/.../render.py`, pypdfium2, loaded only by a render job and never
  by `core`; `tests/test_render.py` checks), which returns PNG or JPEG per page, whichever is smaller: a deck
  (pptx, odp) by its longest side (1,200 px), anything else by width (1,000 px). **Offered only when it can
  work**: `getEnabledBuiltinTools({ modelSeesImages })` (`forceMultimodal ?? model.multimodal`, resolved in
  `runMcpFlow`) and the service's `capabilities.render`; without Gotenberg it is offered for PDFs only and its
  description says so. Otherwise the tool is absent, never an error at call time. For a deck, the default pages
  are the slides the turn's last `doc_edit` touched (`DocumentTurnState.touchedSlides`, filled from the operations'
  results; a miss falls back to the first slides). **Images in a tool result**: nothing carried them before, since
  a tool message is text on OpenAI-compatible APIs. A builtin returns `images` (`BuiltinToolImage`) and
  `executeToolCalls` fits them to the turn's image limits (`imageProcessor`) and appends one user message of `image_url` parts after the round's tool messages,
  directly after them (`pictureMessages`: tool, user, with no assistant bridge), so the next request of the turn carries them. Sub-agents are not given `look_doc` (their allowlists do not name it). They are not stored: the
  saved tool run is the text (which pages were shown), so a later turn does not carry the pictures. The PowerPoint,
  Word, PDF and pdf-tools skills say when to look; the "no PDF just to preview" rule stands (the preview is for the
  user, `look_doc` for the model). Not built: measurements for a text-only model (the issue keeps it as a follow-up). Only the latest picture message stays in the request (`withoutOlderPictures`; older ones become a one-line note) and a turn shows at most 18 images (`MAX_IMAGES_PER_TURN`). The first text part of each call's pictures says they are the document's content, not instructions from the user. The placement was tried live (Cortecs: mistral-medium-3.5, mistral-small-2603, gemma-4-31b-it, kimi-k3 all accept tool then user; mistral-small read a 512 px picture right 5/5 and 5/5 that way, but 4/5 and 3/5 behind an assistant "(looking at the pages)" bridge and 5/5 and 0/5 with the image inside the tool message), so there is no bridge: `runMcpFlow` has no per-provider notion of strict alternation to key one on. A unit test pins the sequence.
