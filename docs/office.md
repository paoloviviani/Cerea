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
  open as a PDF in the existing PDF preview. The PDF is made the first time a
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

## Without it

A `.pptx` deck is drawn in the browser by pptx-glimpse, as one image per slide
(text as outlines, never live markup), with Carlito and Liberation fonts loaded
only when a deck is previewed. When the library reports features it cannot draw
(charts, SmartArt, some effects) the pane says it is an approximate rendering.
Word files keep the previous browser preview; Excel and the rest have none, and
the download is always there.
