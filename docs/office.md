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

## Editing Word, Excel and PowerPoint files

!!! info "For operators"

    The `documents` service runs with the chat profile in the kit; no switch to turn on.

With the document service (`cerea-documents`, ADR 0103) the model works on
Office files through three tools instead of writing code in the browser:

- **`doc_outline`** gives a file's structure with stable ids; **`doc_read`**
  gives the exact content of ids or ranges.
- **`doc_edit`** applies typed operations (replace text, fill placeholders, set
  cells and formulas, edit tables, replace or insert images, reorder slides,
  tracked changes in Word). All operations apply or none do, and only the parts
  they name are touched: every other part of the file stays byte for byte.

A file is named the way the model already sees it: an attachment, or a file a
tool or a run produced. The edit is saved as a **new version** of the file under
the same name: the person sees an ordinary file card (preview, download, the
version list), the original attachment is never changed, and the result tells
the model the diff and a verification report (which parts changed, that the rest
is identical, that the file reopens). Tracked changes carry the person's display
name unless the model gives another author.

The tools are offered only while `CHAT_DOCUMENTS_URL` and `CHAT_DOCUMENTS_SECRET`
are set and the service answers, and `doc_edit` offers exactly the operations the
service reports at `/v1/capabilities` (the tool text is built from the service's
own schemas). Without them the Excel, Word and PowerPoint skills use their
in-sandbox helpers.

The service parses untrusted files, so the kit runs it on an internal-only network
with no internet access, a read-only filesystem, no capabilities and resource
limits, and every request in a fresh subprocess with its own limits; see the
[kit README](deploy-kit.md).

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
