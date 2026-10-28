# Word, Excel, PowerPoint and PDF files

Ask the assistant for a report, a workbook, a deck or a PDF and it makes the
file, saves it in the chat and shows it in the side pane. Give it a file of your
own and ask for a change, and it changes only what you named.

This page says what you can ask for, what you get and what it cannot do. The
last parts are for administrators.

## What to ask for

- **A new file.** "Write a two-page report on the survey results as a Word
  file." "Make a budget workbook with a total row and a chart." "Build a
  ten-slide deck for the board meeting, with speaker notes." "Make a PDF
  handout."
- **A change to a file.** Attach a Word, Excel or PowerPoint file, or point to
  one the assistant made earlier, and ask: "Change 2025 to 2026 everywhere",
  "fix the total in B12", "move slide 5 to the front", "replace the logo".
- **A filled-in PDF form.** Attach a PDF form and say what to put in it:
  "Fill in this application with my details." See "Filling PDF forms" below.
- **A file from your template.** Upload a Word, PowerPoint or Excel template that
  has `{{placeholders}}`, and the assistant fills them in.
- **A look.** See "Styling by asking" below.

The assistant says what it made or changed and what it checked. It cannot see
the finished page, so open the file when the layout matters.

## What you get

A file card in the chat, with a preview, a download and a version list. Word,
Excel and PowerPoint files are real Office files: you can open and edit them
in Office. PDFs are made directly, so the same request gives the same file.

### Creating

The assistant writes a description of the document and the service builds it.
These can go in:

| Format     | What it can hold                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Word       | headings, paragraphs with bold, italic, links and colour, lists, tables, images with captions, charts, quotes, code, a table of contents, page breaks, page size and margins, headers and footers with page numbers |
| Excel      | sheets, values, formulas, number formats, bold and fills, column widths, frozen rows, filters, tables, charts, pictures at a cell                                                                                   |
| PowerPoint | slides in six layouts, tables, pictures, charts, speaker notes, backgrounds and shapes (see "Designed slides")                                                                                                      |
| PDF        | the same as Word, except that charts are pictures                                                                                                                                                                   |

Pictures must be files the chat already has: an attachment, a chart the
assistant drew, or an image from the browser sandbox. The assistant never
downloads anything for a document. Only PNG, JPEG and GIF work.

### Editing

An edit can replace text, fill placeholders, set cells and formulas, change
table cells, add or swap pictures, and reorder, copy or delete slides. Word
edits can be tracked changes, under your name unless you say another. The
result lists what changed.

- All the changes in one request apply, or none do.
- Only the parts you named change. Everything else stays exactly as it was.
- **Every edit is a new version** under the same name. Your original is never
  changed, and the version list on the file card gives you the earlier ones.
  Making a file again under the same name also saves the next version.
- **Earlier versions stay reachable.** Version 1 is your original attachment (or
  the first file the assistant made), then 2, 3 and so on, and they keep their
  numbers. The assistant sees the list (when, which tool, one line on what
  changed) every time it outlines a file that has more than one version, and
  it can outline, read, look at, convert or **edit from** any earlier version
  by number, or as the "previous" one. An edit from version 1 is saved as the
  next version, with the earlier ones unchanged. To go back, ask it to restore
  a version: that version becomes the latest again, and the result says which
  one it started from.
  The numbers are the assistant's: it counts your attachment as version 1, and a
  version keeps its number even after older ones expire. The version list on
  the file card counts the files the assistant made, so its "v1" can be the
  assistant's version 2 when the file started as an attachment.
- **Code sees the latest version.** Every file of the conversation (what you
  attached and what was made since, by the document tools or by code) is in the
  sandbox at `/mnt/data/<name>` as its latest version; earlier versions are not
  mounted there.

### Charts

A chart can be **native**, which stays editable in Office with its data in the
file, or a **picture**. Bar, column, stacked, line, area, pie, doughnut and
scatter charts are available. Word, Excel and PowerPoint can have either kind;
a PDF always gets a picture. If a native chart cannot be written, the file gets
a picture instead and the assistant says so.

### Styling by asking

The default style is neutral. To change it, say what you want in the request:

- fonts for body and headings, from a list of common Office fonts (Arial,
  Calibri, Cambria, Georgia, Garamond, Verdana and others);
- colours, an accent colour, heading sizes, spacing and table style.

There is no company template set up by the administrator. To use your own look,
upload a Word, PowerPoint or Excel file in the chat and ask for it: the
assistant takes the styles, headers and page setup from it (for a deck, its
layouts and fonts too). A PDF cannot use a template. Files with macros are
refused, and a file the assistant makes never contains macros or other active
content.

### Designed slides

By default a deck uses six 16:9 layouts: title, title and content, section,
two columns, title only and blank. Text is 20 to 24 pt and never shrinks below
14 pt: when a slide has too much on it, the assistant splits it. Tables,
pictures and charts sit below the title.

For a more designed page you can ask for:

- **a background**: a colour, a two-colour gradient, or a picture, cropped to
  fill the slide;
- **shapes**: up to 40 on a slide (rectangle, rounded rectangle, ellipse, line,
  arrow, chevron or text box), placed on the slide in centimetres, for cards, a
  cover or a section slide; their text may be as small as 8 pt;
- **slide numbers**: on every slide but the first, bottom right, as a field, so
  moving a slide keeps the number right;
- **title size**: the deck's slide titles follow the theme's first heading size
  (36 pt by default).

Shapes with text stay fully on the slide. A decoration without text, such as a
big circle in a corner, may run off an edge as long as at least 0.5 cm of it
shows. The assistant gets a warning when text is hard to read on its background,
when a shape covers the title or body, or when text runs out of its shape onto
other text, out of a filled card or off the slide, and fixes it or tells you. A
short label in a box that is slightly too small, with nothing around it, is
not a warning.

To fix one slide the assistant rebuilds just that slide (or adds one after a
given slide) in your file, in the deck's own look, and nothing else in the file
changes. It reads the look back from the file: size, fonts, accent, title
style, the text colour and background most slides share, and whether the
slides are numbered. It says which values it could not recover and used the
defaults for. It can also move or resize a single shape.

If the request is refused, the message says which value was wrong and what is
allowed, so the assistant can correct it.

### A custom design

Backgrounds and shapes cover cards, covers and section pages. For something
the tools cannot draw, such as an infographic or a timeline built from shapes,
you can **explicitly ask for a custom design**. The assistant then builds the
deck in the browser sandbox and says so in one line. That route is more
distinctive and more likely to need fixes, and a deck is made one way or the
other, never both.

If you only say "make it look great" or "something eye-catching", the assistant
asks which you want: a clean deck in standard layouts (the reliable default) or
a custom design. "A deck about X" goes to the standard route without a question.
You can still ask for edits to a sandbox-built deck afterwards.

## Filling PDF forms

Attach a fillable PDF form (an AcroForm, the kind with boxes you can click and
type in) and tell the assistant what to enter. It first lists the form's
fields: each one's name, type, page, current value and, for a checkbox, a radio
group or a list, what it accepts. It matches your details to the fields and asks
you about anything unclear instead of guessing. Then it fills the form and saves
the result as a new version of the file; your original stays as it was.

- **Every kind of field, on every page:** text, checkboxes (including those
  whose "on" value is not "Yes"), radio groups, list and drop-down boxes
  (several choices where the form allows it).
- **Checked before anything is written.** A value a field does not accept (a
  radio option that does not exist, a text longer than the field's limit, a
  read-only field) is refused with what the field takes, and the file is not
  changed. All values go in or none do.
- **Checked afterwards.** The assistant reads every value back from the saved
  file and tells you the fields it filled, the ones left empty, the required
  ones still empty and any value that did not take.
- **Shown in any viewer.** The values are written so browsers, Acrobat, Preview
  and LibreOffice all show them.
- **Flatten.** Ask for a final copy and the values are baked into the pages: the
  form is no longer editable.

What it cannot do:

- **XFA forms** (Adobe LiveCycle) keep their values in a different place that
  this tool cannot fill. The assistant says so; Adobe Acrobat can fill them.
- **Signed PDFs** (a digital signature in the file) are refused, because
  filling would invalidate the signature. Fill a copy made before signing.
- **Other alphabets.** Text in forms is limited to Western European characters:
  accents and the euro work, Polish "Ł", Greek or Cyrillic are refused.
- **A scanned or printed form** has no fields, only lines drawn on the page.
  Filling those by writing text at positions is not available yet.
- **Encrypted PDFs** (password-protected or restricted) are refused: remove the protection first.
- A PDF can be changed in no other way with these tools; merging, splitting,
  rotating and the like are the `pdf-tools` skill, in the browser.

Without the document service the `pdf-tools` skill fills the form in the browser
sandbox with the same checks and the same report.

## Previews

The side pane shows the file you open.

- **With the converter** (the administrator turned on Office previews), Word,
  Excel, PowerPoint and OpenDocument files open as a PDF, drawn the same on a
  desktop and a phone. Files the assistant makes are converted as soon as they
  are saved; others the first time you open them. The assistant can also
  convert a file in the chat to PDF, or write Markdown or HTML out as a PDF
  (the `convert_document` tool).
- **Without it**, a deck is drawn in the browser, one picture per slide. When it
  uses something the browser cannot draw (some charts, SmartArt, some effects)
  the pane says the view is approximate. Word files keep a simpler preview.
  Excel and other formats have no preview. The download is always there.

Every PDF is drawn in the page, one canvas per page; the first 60 pages are
shown, and "New tab" and "Download" stay in the header.

## The assistant looking at a file

When the chosen model can read images and the document service is running, the
assistant can look at pages of a Word, Excel, PowerPoint or PDF file in the chat
(the `look_doc` tool): after it makes or redesigns a deck or document it checks
the layout and fixes what is broken (text running out of a box, a cut-off table,
an empty slide). It can also read a scanned or image-only PDF, or a form, as it
really looks. This is for the assistant; you keep the preview above.

- **It looks sparingly.** At most 6 pages or slides per call, about 1,000 tokens
  or more for each, and not after small text edits.
- **Office files need the converter.** They are drawn by LibreOffice, like the
  preview, so fonts and line breaks can differ slightly from Microsoft Office:
  it spots a broken layout, not a pixel difference. Without the converter the
  assistant can still look at PDFs.
- **A text-only model is not offered the tool.** It has no way to see an image.
- **Some models take images but mishandle them inside a tool turn**, and some
  chat templates reject them. So the tool is offered only to a model whose
  "Images in tool results" capability is on:
  - **With Pystino**, the capability is on by default for every model that
    accepts images, and an administrator turns it off for one model in the
    console's model page. A Pystino version that does not list the capability
    at all changes nothing: the tool is offered to every model that accepts
    images.
  - **With a standalone or other OpenAI-compatible endpoint**, the tool is
    offered to every model that accepts images. To switch it off for one
    model, add `"toolImages": false` to its entry in `MODELS`, for example
    `MODELS='[{"id": "my-model", "toolImages": false}]'`. A `MODELS` entry
    with `"multimodal": true` for a model the listing shows as text-only is
    offered the tool too, and so is a text-only model when you force images on
    for a message: only an explicit "off" (the console switch or
    `"toolImages": false`) withholds it. An entry that gives its own
    `endpoints` is treated like a standalone endpoint.
- **A model that rejects the pictures does not break the turn.** If the
  endpoint refuses a request that carries pictures (a 400 or 422 answer, which
  can also mean the request was too long, so the cause is not assumed), the
  chat sends the same request once more without them, with a note that the
  images could not be sent. For the rest of that turn the assistant gets no
  more pictures: `look_doc` answers that images are not available on this
  model, and the assistant describes what it can from the text or tells you.
  Other errors (server errors, timeouts, rate limits) are not retried this way.
- Encrypted PDFs are refused.

## Limits

- **Size.** A request to the service may be up to 64 MiB, the description of the
  document up to 1 MiB, a picture up to 20 MiB and 40 million pixels, and a deck up
  to 200 slides, a workbook up to 100,000 cells and a chart up to 5,000 values.
  An edit may have up to 200 operations. A file to convert to PDF may be up
  to 20 MB.
- **Time.** One call is stopped after about 30 seconds of work (60 seconds in
  all). A very large file may need to be split.
- **Editing a deck:** you cannot add a native chart to an existing deck, edit
  a chart's data, or redesign layouts. Ask for a new deck instead.
- **Editing a workbook:** you cannot insert or delete rows, or add charts to an
  existing workbook. New formulas have no value until the file is opened in
  Excel; numbers the assistant quotes come from your data, not from a formula.
- **Editing a Word file:** comments, footnote text, content controls and fields
  are not available.
- **Editing a PDF** is limited to filling its form (see above): merging,
  splitting, rotating and similar work on an existing PDF is the `pdf-tools`
  skill, in the browser. A PDF may have up to 2,000 pages and 5,000 form fields.
- **PDF text.** Latin, Greek and Cyrillic render. Chinese, Japanese, Korean
  and Arabic do not, and the assistant says so.
- **Not checked by eye.** Nobody renders the page for the assistant, so it
  checks that the file is valid and reopens, and leaves the visual verdict to
  you.

## When there is no document service

If your administrator has not set up the document service, the assistant has no
document tools. The Word, Excel, PowerPoint and PDF skills then write the file
as Python in your browser (see [Python in the browser](pyodide.md)). That works,
but without the precise, all-or-nothing edits: a deck is built from a markdown
outline, and checks are less thorough. Ask your administrator if the tools are
missing.

## For administrators

Two services are involved, both in the kit and both optional for the chat to
work.

| Service                         | What it does                                            | Setting                                                                |
| ------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `documents` (`cerea-documents`) | creates and edits Word, Excel, PowerPoint and PDF files | `CHAT_DOCUMENTS_URL`, `CHAT_DOCUMENTS_SECRET`; on with the chat        |
| `gotenberg`                     | Office previews as PDF and the `convert_document` tool  | `CHAT_GOTENBERG_URL`; off until you run `./configure --office-preview` |

The settings are in [Configuration](configuration.md) and the kit's runbook
([the deploy kit](deploy-kit.md)) covers resources, the secret and upgrading
from 0.29.x (run `./configure` once).

### The document service (`cerea-documents`, ADR 0103)

The tools `doc_outline`, `doc_read`, `doc_edit`, `doc_create` and
`doc_create_from_template` are offered only while `CHAT_DOCUMENTS_URL` and
`CHAT_DOCUMENTS_SECRET` are set and the service answers. The chat asks the
service what it can do, and builds the tools from the answer, so a new
operation in the service reaches the assistant without a chat release.
`doc_create` and `doc_create_from_template` are offered when the service reports
that it can create; `doc_edit` offers exactly the operations it lists. Without the
service, or with `CHAT_DOCUMENTS_URL` empty, the skills use their in-browser
methods.

The service parses untrusted files and descriptions, so the kit runs it on an
internal-only network with no internet access, a read-only filesystem, no
capabilities and CPU, memory and process limits, and every request runs in a
fresh process with its own limits. Its image is versioned with the chat. The
limits above are its defaults; the service's own settings (all prefixed
`CEREA_DOCUMENTS_`) are listed in `documents/README.md`.

### Office previews (Gotenberg, the `office` profile)

Run `./configure --office-preview && docker compose up -d` in the kit
(`--no-office-preview` removes it). Previews are made the first time a file is
opened, except for files the assistant made, which are converted when they are
saved. A preview is kept in the chat's file store under the hash of the file and
a converter version, so identical files share one preview, an edited file gets
its own, and a new converter version in a release makes fresh ones. It is deleted with the last file that
uses it. If the converter cannot make a PDF, the browser preview is used.

`convert_document` is offered to models only while Gotenberg is configured. It
needs the converter, so without it nothing converts to PDF except the
document service's own PDF creation. Gotenberg parses untrusted files, so the kit
runs it on an internal-only network with no internet access, no published port,
no shared volumes, CPU and memory limits and timeouts.
