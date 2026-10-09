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

All of these run on **Python in your browser** (see
[Python in the browser](pyodide.md)): the needed packages are already
vendored by the deployment, and the files the code writes come back as
downloadable artifacts. The honest limits are listed with each skill — they
come from the browser sandbox, not from missing effort.

| Skill              | What it is for                                                 |
| ------------------ | -------------------------------------------------------------- |
| `word`             | Creating and editing Word documents with python-docx           |
| `excel`            | Workbooks with formulas, formatting and native charts          |
| `pdf`              | Creating PDF documents with reportlab                          |
| `pdf-tools`        | Working with existing PDFs: merge, split, forms, encryption    |
| `powerpoint`       | Decks from a markdown outline, on a template's real layouts    |
| `charts`           | Publication-minded figures with matplotlib and seaborn         |
| `data-analysis`    | Profiling data and testing hypotheses, with the caveats stated |
| `business-writing` | Internal communications in the usual formats                   |
| `themes`           | Colour and font themes applied across documents and decks      |

Three more built-ins handle data shaping: `csv-shaping`, `json-shaping` and
`report-writing`.

### word

Reports, letters, meeting notes — built structure-first: real heading styles,
tables, lists, and consistent typography. **Verified by reading the document
back** (headings, tables, cell values), not by rendering pages: there is no
document renderer in the browser, so exact spacing and pagination deserve a
look from you when layout matters.

### excel

Workbooks, analysis, charts. Formulas are written as **real formulas** — but
they are not recalculated here: `openpyxl` stores the formula, and its value
appears when the file is opened in a spreadsheet application. Anything the
assistant reports as a number in the chat was computed in Python from your
data, not read from a formula cell. Native charts (bar, line, pie, scatter)
live inside the workbook.

### pdf

Reports and documents created with reportlab — flowing layouts for prose,
exact placement for forms and tables. Verified by re-reading the pages with
pypdf (page count, extracted text). The standard PDF fonts cover ASCII; text
in other alphabets needs a font file supplied with the document, which the
sandbox does not ship.

### pdf-tools

The other half of PDF work, on an existing file: merge, split, rotate,
reorder pages, fill AcroForm fields, extract text and metadata, encrypt and
decrypt. Encryption uses RC4-128 because the browser has no AES library for
PDF work — the assistant will say so if you ask for it to encrypt.

### powerpoint

Decks generated from a markdown outline by filling a template's **real
layouts and placeholders** — never text boxes overlaid on slides — so the
template's branding carries through. It ships a demonstration template
inside the skill, and works with your own `.pptx` when you attach one.
Editing an existing deck is for small text fixes and reordering; layout
changes regenerate the deck. Validation is structural (empty placeholders,
estimated overflow, off-slide shapes); the visual verdict is yours to make
when you open the deck. Picture placeholders stay empty for images you
attach.

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
