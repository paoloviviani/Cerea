---
name: pdf
description: Create PDF documents with the doc_create tool (format pdf) - reports, letters, structured pages, tables, images and charts with reliable layout. Use when the task is to produce a new PDF; for filling a form, merging, splitting or reading an existing PDF use pdf-tools.
---

# PDF documents

Use this skill when the user wants a **new** PDF. For an existing PDF (fill a form, merge, split, rotate, encrypt,
extract text), use the `pdf-tools` skill. Among the document tools only `doc_outline` and `doc_edit fill_form` work
on an existing PDF (its form); they do not edit a PDF in any other way.

## One rule

**When `doc_create` is in your tool list, `doc_create` with `format: "pdf"` is the ONLY way to create a PDF.** Do not
write Python to make one (no reportlab, no hand-written PDF syntax), and do not make a Word file only to convert
it. If the tool is not in your tool list, jump to the last section, "Fallback".

## Creating a PDF

Call `doc_create` with `format: "pdf"`. The spec is the same as for a Word document (see the tool's description):
`blocks` or `markdown`, `title`, `page`, `header`, `footer`, `theme`. The service checks it first and answers with
what is allowed if something is off.

- **Blocks:** heading, paragraph (runs: bold, italic, underline, code, colour, link), list (nested), table (header
  row repeated across pages, widths, alignment), image, chart, quote, code, toc (with page numbers), page_break.
- **Pages:** `page` sets size (A4, Letter, ...), orientation and margins; `header` and `footer` take `{page}` and
  `{pages}` for page numbers.
- **Look:** a neutral built-in style; `theme` only for what the person asked: body and heading fonts are mapped to the
  nearest of three embedded families (sans, serif, monospace), plus sizes, colours, spacing and table style.
  `theme.template` is not available for PDF. Latin, Greek and Cyrillic text render; scripts such as Chinese,
  Japanese, Korean or Arabic do not, so say so rather than deliver boxes.
- **Charts:** always images (render `native` and `image` give the same PDF). Images: files in the conversation (an
  attachment, or a picture saved under `/mnt/output/` in the sandbox), listed in `images` and named the same way
  in image blocks. For a chart the tool cannot draw, make the picture in the sandbox and pass it as an image
  reference.
- Use ASCII hyphens only. Citations and references must be readable text, never tool tokens or placeholders.

## Reporting

The result gives the page count, an outline of the headings and a verification report: the PDF reopens and has
pages. **When `look_doc` is in your tool list, look at the pages once after creating a PDF, and fix what is broken
(cut-off text, a table off the page) with a corrected spec.** It is also how you read a scanned or image-only PDF
that has no text: look at its pages. It is for you; the user already has a preview. Without it there is no
renderer, so say in one line what you checked and that the user should open the file to judge spacing and
alignment. A request to change the PDF afterwards is a new `doc_create` with the corrected spec.
Describe only files the tools actually saved.

## Fallback: only when the doc_* tools are not available

**Read this section only if `doc_create` is NOT in your tool list.** If it is, stop reading here: everything below
is the older in-sandbox method for deployments without the document service, and it must not be mixed with the
tools. These instructions write Python inside the browser sandbox; the helper scripts are bundled with this skill.

### Setup

Install before importing (both ship with this runtime's package set):

```python
import micropip
await micropip.install("reportlab")
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, letter
```

### Creating a document

- **Simple pages and precise placement**: `reportlab.pdfgen.canvas` — draw
  text, lines, tables (manual or `platypus.Table`), and images at exact
  coordinates. You control the page; set margins explicitly and keep content
  inside them.
- **Flowing documents**: `reportlab.platypus` (`SimpleDocTemplate` with
  `Paragraph`, `Spacer`, `Table`, `PageBreak`) when the content is a report
  that should wrap and flow — styles via `styles.getSampleStyleSheet()` or
  your own `ParagraphStyle`.
- Prefer the package over hand-built PDF syntax in every case — writing PDF
  objects by hand produces invalid files on the first non-trivial document.
- Fonts: the base-14 fonts (Helvetica, Times-Roman, Courier, and their bold
  and italic variants) always work. Unicode text needs a TTF font registered
  with `pdfmetrics.registerFont(TTFont(...))` — the sandbox ships no font
  files, so without one, keep to ASCII or transliterate, and say so.
- Tables: set column widths and repeat the header row across pages
  (`repeatRows=1`) on long tables. Long text cells wrap only inside a
  `Paragraph`.

### Checking before delivery

There is no renderer in this environment, so a PDF is verified by reading it
back with pypdf, not by looking at a picture:

```python
import micropip
await micropip.install("pypdf")
from pypdf import PdfReader
reader = PdfReader("report.pdf")
print(len(reader.pages), "pages")
print(reader.pages[0].extract_text()[:500])
```

1. Page count matches what you intended; every page has content.
2. Extracted text contains the headings, key values, and totals you meant to
   put there — with no placeholder text left and no duplicated sections.
3. Say in one line what you checked and what you could not (exact visual
   layout — the person should open the file to judge spacing and alignment).

### Quality expectations

- Maintain consistent typography, spacing, margins, and section hierarchy.
- Avoid defects: clipped text, overlapping elements, broken tables, or
  unreadable glyphs — these are exactly what reading the text back cannot
  catch, so be conservative with absolute positioning and leave margins.
- Use ASCII hyphens only. Avoid U+2011 (non-breaking hyphen) and other
  Unicode dashes.
- Citations and references must be human-readable; never leave tool tokens or
  placeholder strings.

### Rules

- The PDF is the deliverable: the file must exist when you finish — run
  the code yourself or write one complete runnable block; a script the
  person still has to run is not the file.
- `pdfplumber`, `pdftoppm`/Poppler, LibreOffice, and image-based rendering do
  not exist here and no install makes them appear — use pypdf for reads and
  reportlab for writes.
- Deliverables are saved by a code block to `/mnt/output/<clear filename>`;
  only files under `/mnt/output/` are offered to the person as downloads.
  Scratch files elsewhere (the working directory, `/tmp`) are never shown.
  Only describe files you actually produced.
- Iterate with the `execute_code` tool when you need to see a result (page
  count, extracted text) — run, read, fix, run again.
