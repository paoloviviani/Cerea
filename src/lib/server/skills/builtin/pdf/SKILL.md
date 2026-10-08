---
name: pdf
description: Create and check PDF documents with reportlab and pypdf — reports, letters, forms, and structured pages with reliable layout, verified by reading the file back. Use when the task involves generating or reviewing PDF files.
---

# PDF documents

Use this skill when the person wants a PDF created or checked. For editing
and manipulating existing PDFs (merge, split, fill forms, encrypt), use the
`pdf-tools` skill instead.

## Setup

Install before importing (both ship with this runtime's package set):

```python
import micropip
await micropip.install("reportlab")
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, letter
```

## Creating a document

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

## Checking before delivery

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

## Quality expectations

- Maintain consistent typography, spacing, margins, and section hierarchy.
- Avoid defects: clipped text, overlapping elements, broken tables, or
  unreadable glyphs — these are exactly what reading the text back cannot
  catch, so be conservative with absolute positioning and leave margins.
- Use ASCII hyphens only. Avoid U+2011 (non-breaking hyphen) and other
  Unicode dashes.
- Citations and references must be human-readable; never leave tool tokens or
  placeholder strings.

## Rules

- `pdfplumber`, `pdftoppm`/Poppler, LibreOffice, and image-based rendering do
  not exist here and no install makes them appear — use pypdf for reads and
  reportlab for writes.
- Files are written to the working directory by a code block under a clear
  filename; only describe files you actually produced.
- Iterate with the `execute_code` tool when you need to see a result (page
  count, extracted text) — run, read, fix, run again.
