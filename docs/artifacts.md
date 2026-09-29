# Artifacts

!!! info "For everyone"

    What the assistant can hand you besides text: previews, documents and files, and where to find them again.

An **artifact** is a substantial, self-contained thing the assistant makes for
you, an app, a document, a diagram, a table, a report or an image, shown in
a side panel beside the conversation rather than buried in the transcript.
There are two kinds: **text artifacts**, which the model writes, and **file
artifacts**, which a Python run produces.

## Text artifacts

The model writes an artifact when the content is worth keeping apart from the
answer. The kinds are:

| Kind            | Shown as                               |
| --------------- | -------------------------------------- |
| **HTML**        | a live page, in a sandboxed frame      |
| **React**       | a live component, in a sandboxed frame |
| **Mermaid**     | a rendered diagram                     |
| **SVG**         | a preview                              |
| **Markdown**    | rendered text                          |
| **Table** (CSV) | a grid                                 |
| **Code**        | source, not previewed                  |

Previews run in **sandboxed frames with no network access**: no cookies, no
storage, no requests out, no remote images. See
[what rendered artifacts can do](pyodide.md#what-rendered-artifacts-can-do).

**Every change is a new version.** When you ask for an edit, the model can
rewrite the artifact whole, or send targeted replacements that are applied to
the latest version, so it does not re-emit a long document to change a
sentence. The panel keeps the history and lets you move between versions.

Whether a model makes artifacts follows the model's setting in the
**Workspace → Models** tab: on for a model that can call tools unless the
setting says otherwise, and always on in the ML Assistant preset.

## File artifacts

A file produced by Python in the [browser sandbox](pyodide.md) (a spreadsheet, a
PDF, a Word document, a chart) is a file artifact. The card under the output
looks like a text artifact's: name, kind and size, with **Download** and **Open
in panel**.

- **Versions follow the filename.** Each run that writes the same filename adds
  a version: a re-run that rewrites `report.pdf` makes v2 of the same artifact.
  A re-run whose bytes are identical adds nothing.
- **Cards are matched by content, not by name.** A card opens the exact version
  its checksum belongs to (following the latest only when it _is_ the latest),
  so a filename that was reused can never open the wrong version.
- **Produced files are kept for 30 days**, per person, and survive reloads and
  other devices, so a chart or a document is still there the next day. How a
  file came to exist (a tool run, a code block that ran itself, an artifact
  cell) changes nothing about how it is kept or shown.

### Images

A **raster image** a run produces (PNG, JPEG, GIF or WebP) is shown **inline**
under its card, without a click. Matplotlib charts are captured automatically
and arrive this way, as `figure-1.png` and so on ([Matplotlib
figures](pyodide.md#matplotlib-figures)). **SVG is never shown inline**, because an
SVG can carry script, and neither are formats a browser may not decode; those
keep the click-to-preview and the download.

## The Artifacts panel

The conversation's menu opens the **Artifacts** panel in the same side pane the
previews use, so the list sits beside the chat instead of replacing it. It lists
everything this conversation produced, in the order it appeared: the text
artifacts, the files a run wrote, and any dashboards. Each row opens the
artifact in the panel with its versions and preview; each file has its own
**Download**, and the list has a reload button.

The panel is **per conversation**: it lists the open chat's files, not other
conversations', and files older than 30 days are gone.
