---
name: word
description: Create and edit Word (.docx) documents with the doc_* tools - reports, letters, memos, contracts and any Word file - with real styles, tables, images and charts. Use when the task involves creating, reading or editing a Word document.
---

# Word documents

## One rule

**When `doc_create` is in your tool list, the `doc_*` tools are the ONLY way to create or edit a Word document.**
Do not write Python to make or change one (no python-docx, no bundled helper scripts, no zip editing), and do not
mix the two ways. If the tools are not in your tool list, jump to the last section, "Fallback".

## Creating a document

Call `doc_create` with `format: "docx"` and a `spec`. The tool's description lists every block and property; the
service checks the spec before it builds anything and, if something is wrong, answers with what is allowed.

- **Blocks:** heading (levels 1-6), paragraph (runs: bold, italic, underline, code, colour, link), list (ordered or
  bulleted, nested through `children`), table (header row, widths, per-column alignment, caption), image, chart,
  quote, code, toc, page_break. Prose can also be given as `markdown` (headings, lists, tables, links, code; no
  HTML) instead of `blocks`.
- **Structure first:** a visible title is a heading block (`title` is only the file's property), then headed
  sections and short paragraphs; a table of contents and page breaks for long reports; `header` and `footer` with
  `{page}` and `{pages}` for page numbers; `page` for size, orientation and margins; `language` for the text's
  language.
- **Look:** the built-in style is neutral and complete. Set `theme` only for what the person asked: fonts from the
  tool's list, `colors` and `accent` as hex, heading and body sizes, spacing, `table_style`. Never promise a font or
  a look the theme cannot express.
- **Their template:** when the person uploaded a Word file whose look they want, give it as `theme.template`; the
  styles, headers, footers and page setup come from it. To fill a template that has `{{placeholders}}`, use
  `doc_create_from_template` (it fills the body, tables, headers and footers; a paragraph holding only a placeholder
  can become an image).
- **Images:** name files that are in the conversation (an attachment, or a picture you saved under
  `/mnt/output/` in the sandbox) in the call's `images` list, and use the same names in image blocks.
- **Charts:** a chart block (bar, column, stacked, line, area, pie, doughnut, scatter) with `render: "native"`
  (editable in Word) or `"image"` (a PNG). If a native chart could not be written the result says it fell back to
  an image. For a chart the tool cannot draw, make the picture in the sandbox, save it under `/mnt/output/` and pass
  it as an image reference.
- Use ASCII hyphens only; avoid U+2011 and other Unicode dashes. Citations and references must be readable text,
  never tool tokens or placeholders.

## Reading and editing a document

- `doc_outline` shows the structure with stable ids (paragraphs `p1...`, tables `t1...`, images, headers,
  placeholders); `doc_read` gives exact content with run formatting. Look before you edit.
- `doc_edit` applies typed operations, all or none: replace text (across runs, keeping formatting), fill
  `{{placeholders}}`, set or insert or delete paragraphs, set table cells, add table rows, insert or replace images.
  `track_changes` with an `author` records the edit as revisions the person can accept or reject: use it when they
  say "suggest", "redline" or "track", and for contracts under review.
- An edit is saved as a new version under the same name; the original stays. Edit again by that name to build on it.
- If an operation fails, the message names what exists (ids, styles); fix the call, do not work around it. Anything
  an operation cannot do (comments, footnote text, content controls, fields) is said plainly to the person.
- Never rebuild a whole document to change a part of it unless they asked for a redesign.

## Reporting

The result carries an outline of what was written (or the diff of an edit) and a verification report: the package is
valid and reopens. There is no renderer, so say in one line what you checked and that the person should open the
file to judge the exact layout. Describe only files the tools actually saved.

## Fallback: only when the doc_* tools are not available

**Read this section only if `doc_create` is NOT in your tool list.** If it is, stop reading here: everything below
is the older in-sandbox method for deployments without the document service, and it must not be mixed with the
tools. These instructions write Python inside the browser sandbox; the helper scripts are bundled with this skill.

### Setup

Install before importing — the package name differs from the import name:

```python
import micropip
await micropip.install("python-docx")
import docx  # python-docx
```

### Reading a document

- A document the person attached is at `/mnt/data/<its filename>` in the
  sandbox; one produced earlier in the conversation is in the working
  directory.

- Load it with `docx.Document(path)` and inspect before changing: read the
  paragraph styles, the tables' shape, and the section setup (page size,
  margins, orientation). Report briefly what you found so the person can
  confirm you are working on the right file.
- Extract text as the ground truth for every edit: iterate paragraphs and
  tables explicitly, never assume a document's structure from its length.
- Preserve what you did not touch: edit runs and cells rather than deleting
  and recreating content (the helpers below do this for you).

### Creating a document

- Build structure with real styles, not manual formatting: headings via
  `add_heading`, body text with the Normal style, emphasis with bold/italic
  runs. Lists are paragraphs with `List Bullet` / `List Number` styles.
- Tables: `add_table` with a style (e.g. `Light Grid Accent 1`), then set the
  header row bold. Fill cell-by-cell; merged cells only when the layout
  demands it.
- Keep hierarchy visible: a title, headed sections, short paragraphs. Page
  breaks (`add_page_break`) before major sections of a long report.
- Prefer the package over hand-built OOXML in every case — constructing
  document XML by string surgery breaks on the first non-trivial document.

### Checking before delivery

There is no renderer in this environment, so a document is verified by
reading it back, not by looking at a picture:

1. Re-open the saved file with `python-docx` and print an outline: heading
   texts and levels, table count and dimensions, paragraph count.
2. Check the content: no placeholder text left, no duplicated sections, table
   cells all filled where they should be, and no empty paragraphs where
   spacing was intended.
3. Say in one line what you checked and what you could not check (exact
   visual layout — the person should open the file to judge spacing).

### Quality expectations

- Deliver a client-ready document: consistent typography, spacing, margins,
  and clear hierarchy.
- Avoid formatting defects: broken tables, unreadable characters, or
  default-template styling where the document calls for real structure.
- Use ASCII hyphens only. Avoid U+2011 (non-breaking hyphen) and other
  Unicode dashes.
- Citations and references must be human-readable; never leave tool tokens or
  placeholder strings.

### Editing an existing document

**Decision rule.** A new document: python-docx. A document the person
supplied that you must change: use the bundled helpers. **Never**
`docx.Document(path)` + `save()` on a supplied file for edits: python-docx
re-serialises every part it parsed, and its run API loses character
formatting whenever text spans several runs (a word half bold, half not).

1. Load `scripts/docx_edit.py`, `scripts/docx_tables.py` and
   `scripts/docx_verify.py` with `load_skill_file`, write them into the
   working directory, and import them (same flow as `pdf-tools`).
2. `outline` first and report briefly what you found: ids `p1..` for
   paragraphs and `t1..` for tables (0-based rows and columns), styles,
   headers and footers, `{{placeholders}}`, comments, tracked changes.
3. Chain edits through scratch files in the working directory and save the
   final result under `/mnt/output/` (the only folder offered as downloads);
   never overwrite the original.
4. `verify` against the ORIGINAL, then tell the person what changed using
   its `text_diff`.

```python
import docx_edit as de, docx_tables as dt, docx_verify as dv   # written out first

src = "/mnt/data/contract.docx"
print(dv.outline_text(de.outline(src)))
de.replace_text(src, "step1.docx", "Acme Ltd", "Beta plc")           # keeps run formatting
de.fill_placeholders("step1.docx", "step2.docx", {"client": "Beta plc", "date": "26 Oct 2026"})
dt.set_table_cell("step2.docx", "step3.docx", "t1", 2, 1, "42")        # table t1, row 2, col 1
dt.add_table_row("step3.docx", "step4.docx", "t1", ["Total", "99"])    # copies the last row's formatting
de.insert_paragraph_after("step4.docx", "/mnt/output/contract-updated.docx", "p4", "New clause", "Heading 2")
rep = dv.verify(src, "/mnt/output/contract-updated.docx")
print(rep["changed"], "\n".join(rep["text_diff"]))
```

- `replace_text(find, replace, scope="all")` covers body, tables, headers and
  footers (scope `"body"`, `"headers"`, `"footers"` or a block id such as
  `"p3"`). A match may span runs; the replacement takes the first matched
  run's formatting. It cannot cross a tab, line break, field or image.
- `fill_placeholders` fills `{{name}}` (also split across runs, also in
  headers and footers); `rep["unfilled"]` lists placeholders with no value and
  `rep["missing"]` keys that matched nothing. Mention both.
- `track_changes=True, author="..."` on any edit writes real `w:ins` /
  `w:del` revisions the reviewer accepts or rejects in Word. Use it when the
  person says "suggest", "redline" or "track" and for contracts under review.
- Comments, styles, numbering, settings and every part you did not edit stay
  byte-identical; comment text is not searched.

Errors are all `PatchError` with a message saying what to do: text not found,
unknown block id or style (the message lists the real ones), a row or column
out of range, a placeholder set that matched nothing. A refused edit writes
no file. If `verify` raises, do not deliver that file; never fall back to
python-docx `save()` on the supplied file or hand-edit the zip.

Not covered: editing comments or footnote text, content controls, fields,
section or style changes. Say so rather than improvising. After delivery
tell the person what changed (the diff), and that the check was structural,
not a rendered view.

### Rules

- The document is the deliverable: the file must exist when you finish —
  run the code yourself or write one complete runnable block; a script the
  person still has to run is not the file.
- Edit the file the person attached with the helpers above (read it, modify,
  save under a new name unless asked to overwrite) — never rebuild an edited document from
  scratch unless they asked for a redesign.
- Deliverables are saved by a code block to `/mnt/output/<clear filename>`;
  the app lists only files under `/mnt/output/` as downloads. Scratch files
  elsewhere (the working directory, `/tmp`) are never shown, so keep
  round-trip or test copies there. Only describe files you actually produced.
- Iterate with the `execute_code` tool when you need to see a result
  (structure, extracted text, a table's contents) — run, read, fix, run again.
