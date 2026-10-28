# Skills

!!! info "For everyone"

    Built-in skills the assistant can follow to produce office files — Word, Excel, PDF, PowerPoint, charts, data analysis, writing and themes — what each one does, and what it honestly cannot.

A **skill** is procedural knowledge the assistant loads when your request
matches it: a written procedure it follows with the app's own capabilities,
not a program that runs by itself. Every deployment ships a set of **built-in
skills**, listed below. You can also add your own in the **Workspace →
Skills** tab (a `SKILL.md` file, optionally zipped with bundled scripts and
reference documents), and an administrator manages the built-in ones there
too — reviewing, editing or turning any of them off deployment-wide.

The assistant sees only one line per skill at first; when your request
matches, it loads the full instructions (`load_skill`), and any bundled
scripts or reference documents it needs (`load_skill_file`). You can force a
skill by naming it in your message with an `@`: asking for
"@word a two-page report" loads the word skill no matter what else the
description matching decides.

## The office skills

With the document service (the default in the kit, see
[Word, Excel, PowerPoint and PDF files](office.md)) the `word`, `excel`,
`powerpoint` and `pdf` skills create and edit files **only** through the
`doc_*` tools: one rule, stated first in each skill, and no Python for
documents. The one exception is a custom deck design you explicitly ask for
(see [powerpoint](#powerpoint)). Where the service is not deployed they fall back to **Python in your
browser** (see [Python in the browser](pyodide.md)): the needed packages are
already vendored by the deployment, and the files the code writes come back as
downloadable artifacts. The fallback instructions sit in a clearly labelled last
section of each skill and say they apply only when the tools are absent. The
honest limits are listed with each skill.

| Skill              | What it is for                                                      |
| ------------------ | ------------------------------------------------------------------- |
| `word`             | Creating and editing Word documents (document tools)                |
| `excel`            | Workbooks with formulas, formatting and native charts               |
| `pdf`              | Creating PDF documents (document tools)                             |
| `pdf-tools`        | Working with existing PDFs: merge, split, forms, encryption         |
| `powerpoint`       | Decks on real layouts, with backgrounds and shapes (document tools) |
| `charts`           | Publication-minded figures with matplotlib and seaborn              |
| `data-analysis`    | Profiling data and testing hypotheses, with the caveats stated      |
| `business-writing` | Internal communications in the usual formats                        |
| `themes`           | Colour and font themes applied across documents and decks           |

Three more built-ins handle data shaping: `csv-shaping`, `json-shaping` and
`report-writing`.

### word

Reports, letters, meeting notes — built structure-first: real heading styles,
tables, lists, and consistent typography. **Verified by reading the document
back** (headings, tables, cell values), not by rendering pages: there is no
document renderer in the browser, so exact spacing and pagination deserve a
look from you when layout matters. With the document service it also edits a
Word file you supply, as tracked changes if you ask; comments, footnote text,
content controls and fields are not available.

### excel

Workbooks, analysis, charts. With the document service it also edits a
workbook you supply (cells, formulas, new sheets, pictures); inserting or
deleting rows and adding charts to an existing workbook are not available.
Formulas are written as **real formulas** — but
they are not recalculated here: the file stores the formula, and its value
appears when the file is opened in a spreadsheet application. Anything the
assistant reports as a number in the chat was computed in Python from your
data, not read from a formula cell. Native charts (bar, column, stacked, line, area, pie,
doughnut, scatter) live inside the workbook.

### pdf

Reports and documents built from the same spec as a Word file — flowing
layouts for prose, tables with repeating headers, images, charts (always
images in a PDF), a table of contents with page numbers. Verified by reopening
the file and counting its pages. Latin, Greek and Cyrillic text render with
embedded fonts; other scripts do not, and the assistant says so. Where the
document service is absent the skill falls back to reportlab in the browser,
whose standard fonts cover ASCII only.

### pdf-tools

The other half of PDF work, on an existing file: fill in a form, merge, split,
rotate, reorder pages, extract text and metadata, encrypt and decrypt. With the
document service a form is filled by `doc_outline` and `doc_edit` (see
[Filling PDF forms](office.md#filling-pdf-forms)), one rule stated first in the
skill; the browser route for forms is only the fallback when the service is
absent. Everything else is done in the browser. Encryption uses RC4-128 because
the browser has no AES library for PDF work — the assistant will say so if you
ask for it to encrypt.

### powerpoint

Decks built by filling real **layouts and placeholders** — never text boxes
overlaid on slides — so the master's branding carries through. With the document
service the assistant writes a slide spec: six 16:9 layouts, titles, body
blocks, speaker notes, native charts, tables and images. Text is 20 to 24 pt
and never below 14 pt (the assistant splits a crowded slide), and content stays
below the title. It works with your own `.pptx` when you attach one and ask for
its look; editing an existing deck changes only the slides and text it names.
For designed pages a slide can have a background (a colour, a two-colour
gradient or a picture cropped to fill) and up to 30 shapes (rectangle, rounded
rectangle, ellipse, line, arrow, chevron, text box). A shape without text may
run off an edge if at least 0.5 cm shows; text always stays on the slide. The
result warns about overflow, overlap and low contrast.

The tools are the default. The one exception: when you **explicitly ask for a
custom design** the tools cannot express (an infographic, a timeline drawn from
shapes, a "designed" deck), the assistant builds it in the browser sandbox and
says so in one line. When it is unclear which you want ("make it look great"),
it asks, with two choices: a clean deck in standard layouts, or a custom design.
A deck is never made both ways. Adding native charts to an existing deck and
editing chart data are not available.

Without the service the skill falls back to the bundled outline generator: it
ships a demonstration template, picks visual types from a markdown outline and
validates structurally (empty placeholders, estimated overflow, off-slide
shapes). Either way the visual verdict is yours to make when you open the deck.

### charts

Figures that keep the data honest: zero-baseline bars, labelled axes,
uncertainty shown and named, colour-blind-safe palettes, raw points visible.
Output is static — PNG or SVG files (or the automatic figures under a code
block). There is no interactive charting and no Plotly in the sandbox.

### data-analysis

Profiling an unfamiliar dataset, then hypothesis testing with the discipline
shown: the test chosen for the design, assumptions checked and reported,
effect sizes computed alongside p-values, power analysis when asked.
Built on pandas, scipy and statsmodels. It will not make causal claims from
observational data, and Bayesian methods are out of reach in the sandbox.

### business-writing

3P updates, company newsletters, FAQ answers, status and leadership updates,
incident reports — each with a bundled format guide the assistant follows.
Every claim in the document traces to your conversation or a computed
result; nothing is invented.

### themes

Ten curated colour-and-font themes (Arctic Frost to Tech Innovation) applied
consistently across a Word document, a deck, a chart or an HTML artifact —
plus a custom theme built from your description. Font names are carried in
the file and substituted by the viewer's system; no font files are embedded.

## Managing skills

- **For you:** the Workspace → Skills tab lists your own skills with an
  on/off switch; import a multi-file skill as a zip of its folder.
- **For administrators:** the same tab shows the deployment's built-in
  skills. A built-in can be edited in place — the deployment's updates never
  overwrite an edited skill — or disabled. An operator can switch a skill
  off for the whole deployment with `CHAT_SKILLS_DISABLED` (a comma-separated
  list of names) in the environment.
- Skills are instructions, never code the server runs: everything executes
  in your own browser's sandbox, under the same rules as every other code
  block.
