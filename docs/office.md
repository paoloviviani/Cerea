# Office previews and document conversion

!!! info "For operators"

    Turning this on is a deployment change: it adds one service.

Cerea previews Word, Excel, PowerPoint and OpenDocument files in the chat's side
pane, and, when asked for a PDF, models can make one.

## With Gotenberg (the `office` profile)

Run `./configure --office-preview && docker compose up -d` in the kit (off by
default; `--no-office-preview` removes it). The chat reaches Gotenberg at
`CHAT_GOTENBERG_URL`. Then:

- **Previews.** docx, pptx, xlsx, odt and the other formats LibreOffice reads
  open as a PDF, drawn in the page (the same on a desktop and a phone; see
  below). If the converter cannot make a deck's or a Word file's PDF, the
  browser preview described under "Without it" is used instead. The PDF is made the first time a
  file is opened, except for files a model produced, which are converted as soon
  as they are stored. It is kept in the chat's file store, keyed by the SHA-256
  of the file's bytes and a converter version: identical files share one
  preview, an edited file gets its own, and a Gotenberg upgrade (a new converter
  version in the release) makes fresh ones. A preview is deleted when the last
  file that uses it is deleted: with the conversation, when a produced file
  expires, and when an account is erased.
- **`convert_document` tool.** Offered to models only while Gotenberg is
  configured. It converts a file already in the conversation (an attachment or a
  produced file) to PDF with LibreOffice, or renders Markdown or HTML the model
  writes to PDF with Chromium (no JavaScript, no network). The PDF is saved in
  the conversation and listed like any produced file. Nothing is metered: it
  runs on your server.

Gotenberg parses untrusted files, so the kit runs it on an internal-only
network with no internet access, no published port and no shared volumes, with
CPU and memory limits and timeouts; see the [kit README](deploy-kit.md).

## Creating and editing Word, Excel, PowerPoint and PDF files

!!! info "For operators"

    The `documents` service runs with the chat profile in the kit; no switch to turn on.

With the document service (`cerea-documents`, ADR 0103) the model works on
Office and PDF files through typed tools instead of writing code in the browser:

- **`doc_create`** makes a new Word, Excel, PowerPoint or PDF file from a
  **document spec** (below). **`doc_create_from_template`** fills a template the
  person uploaded in the chat.
- **`doc_outline`** gives a file's structure with stable ids; **`doc_read`**
  gives the exact content of ids or ranges.
- **`doc_edit`** applies typed operations (replace text, fill placeholders, set
  cells and formulas, edit tables, replace or insert images, reorder slides,
  tracked changes in Word). All operations apply or none do, and only the parts
  they name are touched: every other part of the file stays byte for byte.

A file is named the way the model already sees it: an attachment, or a file a
tool or a run produced. A created file, or an edit, is saved as a file the person
sees as an ordinary file card (preview, download, the version list). An edit is a
**new version** of its file under the same name and the original attachment is
never changed; a created file starts a new file, and creating again under the
same name saves the next version. The result tells the model what was written (an
outline for a created file, the diff for an edit) and a verification report
(that the package is valid and reopens). Tracked changes carry the person's
display name unless the model gives another author.

The tools are offered only while `CHAT_DOCUMENTS_URL` and `CHAT_DOCUMENTS_SECRET`
are set and the service answers. `doc_create` and `doc_create_from_template` are
offered when the service reports `create` and `create_from_template` at
`/v1/capabilities`, and `doc_edit` offers exactly the operations the service
reports (the tool text is built from the service's own schemas, so a new block or
operation reaches the model without a chat release). Without the service the
Excel, Word, PowerPoint and PDF skills use their in-sandbox helpers; with it,
those skills say the tools are the **only** way and keep the helpers in a labelled
fallback section.

### The document spec

One JSON schema family for all formats (the full property lists are in the
service's `documents/README.md`, and the model reads them from the service itself):

| Format     | The spec holds                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Word, PDF  | `title`, `language`, `page` (size, orientation, margins), `header` and `footer` (with `{page}` and `{pages}`), `theme`, and `blocks` or Markdown          |
| Excel      | `sheets` with `rows` or `cells` (values, formulas, number formats, bold, fill), column widths, freeze panes, autofilter, tables, charts, images at a cell |
| PowerPoint | `slides` with a layout, title, body blocks, speaker notes, images (a box or fitted to the body) and charts                                                |

Blocks: heading, paragraph (bold, italic, underline, link, code, colour), nested
lists, tables (header row, widths, alignment), images with captions, charts, quotes,
code, a table of contents and page breaks. Markdown with a small front-matter is
accepted for prose and converted to the same blocks; raw HTML is refused.

**Styling.** There is one neutral built-in style set, and the spec's `theme`
carries what the person asked for in the prompt: body and heading fonts from a
list of fonts commonly installed with Office, colours, heading sizes, spacing,
table style and an accent colour. There is no administrator template. When a
person uploads a Word, PowerPoint or Excel file in the chat and asks for that
look, `theme.template` takes the styles (Word styles, headers and page setup;
PowerPoint master and layouts, named in each slide's `layout`; Excel named
styles) from it, and `doc_create_from_template` fills its `{{placeholders}}`
(Word body, tables, headers and footers; PowerPoint text boxes, placeholders and
notes; Excel cells and named ranges). A paragraph, shape or cell that holds only
a placeholder can become a picture. Macro-enabled templates are refused, and a
created file never carries active content.

**Charts.** A chart block (bar, column, stacked, line, area, pie, doughnut,
scatter) says `render`: `native` or `image`.

| `render` | Word                                    | Excel                                           | PowerPoint     | PDF   |
| -------- | --------------------------------------- | ----------------------------------------------- | -------------- | ----- |
| `native` | a native chart, editable in Word        | a native chart, drawn from the cells            | a native chart | image |
| `image`  | a PNG (matplotlib, a fixed clean style) | a PNG anchored at a cell (needs literal values) | a PNG          | image |

If a native chart cannot be written the file still contains the chart as an image
and the result says so. The chart's data stays in the file, so the person can edit
a native chart in Office. A picture the model made in the browser sandbox is
passed to the tool by name, like any image.

**Images** are files the conversation already has (an attachment, a generated
chart, a sandbox output); the service never fetches anything itself. PNG, JPEG and
GIF only, checked against their content.

**PDF** is built directly from the spec (reportlab, with embedded DejaVu fonts, so
Latin, Greek and Cyrillic render), deterministically, with no converter. Output is
reproducible: the same spec gives the same bytes. Editing an existing PDF stays in
the `pdf-tools` skill.

The service parses untrusted files and specs, so the kit runs it on an internal-only
network with no internet access, a read-only filesystem, no capabilities and
resource limits, and every request in a fresh subprocess with its own limits; see
the [kit README](deploy-kit.md).

## Without it

A `.pptx` deck is drawn in the browser by pptx-glimpse, as one image per slide
(text as outlines, never live markup), with Carlito and Liberation fonts loaded
only when a deck is previewed. When the library reports features it cannot draw
(charts, SmartArt, some effects) the pane says it is an approximate rendering.
Word files keep the previous browser preview; Excel and the rest have none, and
the download is always there.

## How a PDF is shown

Every PDF, including the one the converter makes of an Office file, is drawn in
the page with [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0), one
canvas per page, on every device. The library and its worker are part of the
chat's own build and are served from the same origin: nothing is fetched from a
CDN, and nothing is loaded until a PDF is opened. The first 60 pages are drawn;
"New tab" and "Download" stay in the header as secondary actions.
