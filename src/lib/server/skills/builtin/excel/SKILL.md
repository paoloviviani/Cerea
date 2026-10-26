---
name: excel
description: Create and edit Excel (.xlsx) workbooks with the doc_* tools - sheets, formulas, formats, tables, native charts and images - and analyse spreadsheet data in the sandbox. Use when a task involves creating, editing, analysing or visualising spreadsheet data.
---

# Spreadsheets

## One rule

**When `doc_create` is in your tool list, the `doc_*` tools are the ONLY way to create or edit an Excel workbook.**
Do not write Python to make or change one (no openpyxl, no bundled helper scripts, no `DataFrame.to_excel`, no zip
editing), and do not mix the two ways. If the tools are not in your tool list, jump to the last section,
"Fallback". Analysing data in the sandbox (pandas, plots for the chat) is a different job and stays there: see
"Analysing the data".

## Creating a workbook

Call `doc_create` with `format: "xlsx"` and a `spec` of `sheets`. The tool's description lists every property; the
service checks the spec first and answers with what is allowed if something is off.

- **Cells:** `rows` is the quick way to write a table of values from `start` (default A1); `cells` writes single
  cells with `value`, `formula`, `date`, `number_format`, `bold`, `italic`, `fill`, `color`, `align`, `wrap`.
  `header: true` styles the first row of `rows` as a header. A string starting with `=` is a formula.
- **Layout:** `column_widths`, `freeze` (a cell such as `A2`), `autofilter`, `merge`, `tables` (a named Excel table
  over a range whose first row is unique header text), `images` at a cell. Images are files in the conversation (an
  attachment, or a picture saved under `/mnt/output/` in the sandbox), listed in the call's `images` and named the
  same way in the sheet; this is also how a chart the tool cannot draw gets in: make the picture in the sandbox and
  pass it as an image reference.
- **Charts:** `charts` with `chart_type`, `data_range` (first column categories, first row series names), an
  `anchor` cell, titles, and `render`: `"native"` (a real Excel chart that follows the data) or `"image"` (a PNG
  drawn from the values; it needs literal values, not formulas).
- **Look:** neutral built-in style; `theme` only for what the person asked (fonts from the tool's list, colours,
  accent, table style). A workbook the person uploaded for its named styles is given as `theme.template`, and
  cells then take `style: "<named style>"`. A template with `{{placeholders}}` or named ranges is filled with
  `doc_create_from_template`.

### Formulas: honest about recalculation

The service writes formulas but never evaluates them; Excel computes them when the file opens.

- Use formulas for derived values instead of hardcoding results, so the file stays correct.
- Do NOT present a formula's result as if you computed it. If you need the number now, compute it from the data
  in the sandbox (pandas) and either write the value or report it in the chat, saying which is which. Never claim
  a cell "shows" a number you did not verify.
- Avoid dynamic array functions (`FILTER`, `XLOOKUP`, `SORT`, `SEQUENCE`) and volatile ones (`INDIRECT`,
  `OFFSET`) unless required; prefer cell references over magic numbers (`=H6*(1+$B$3)`); keep formulas simple, with
  helper cells for complex logic; guard against `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A` and `#NAME?`.
- Formulas that point outside the workbook are refused.

### Formatting

- Number and date formats that fit the data (dates as dates; percentages to one decimal; currencies with their
  format). Distinct header rows; fills and merges sparingly. Column widths so nothing spills.
- Group related calculations; make totals simple sums of the cells above them; leave whitespace between sections.
- If no style guidance is given: blue for inputs, black for formulas, green for links or imports, grey for
  constants, orange for review, light red for errors.

## Reading and editing a workbook

- `doc_outline` shows sheets, used ranges, tables, charts and images; `doc_read` reads a range with values and
  formulas. Look before you edit.
- `doc_edit` applies typed operations, all or none: `set_cells` (values, formulas, dates, style copied from a cell),
  `clear_cells`, `add_sheet`, `insert_image`. Other sheets, charts and extensions stay untouched. Inserting or
  deleting rows and adding charts to an existing workbook are not available: say so rather than improvising.
- An edit is saved as a new version under the same name; the original stays. Preserve existing formatting; give
  new cells a matching style (`style_from`). New formulas have no computed value until the file is opened in Excel.

## Analysing the data

- Read the data first and print its shape: header, row count, one sample row.
  Never invent rows — work with exactly what was given.
- One focused code block per step, verifying each step's output before the
  next. Report intermediate shapes so the person can follow.
- Cite sources inside the workbook using plain-text URLs, and add a source
  column when each row of tabular data is a separate item.
- If the answer should be a spreadsheet, put the values you computed into `doc_create` as cell values (or
  formulas); do not write the file from Python.

## Reporting

The result carries an outline of what was written (or the diff of an edit) and a verification report. Say in one
line what you checked and what you could not: the computed formula values and the exact visual layout. Describe
only files the tools actually saved.

## Fallback: only when the doc_* tools are not available

**Read this section only if `doc_create` is NOT in your tool list.** If it is, stop reading here: everything below
is the older in-sandbox method for deployments without the document service, and it must not be mixed with the
tools. These instructions write Python inside the browser sandbox; the helper scripts are bundled with this skill.

### Setup

Install before importing (openpyxl and pandas both ship with this runtime's
package set):

```python
import micropip
await micropip.install("openpyxl")
import openpyxl
import pandas as pd
```

### Choosing the tool

- **openpyxl** for `.xlsx` structure: creating and editing workbooks, cell
  formatting, formulas, and native charts (`openpyxl.chart`).
- **pandas** for analysis: reading, filtering, aggregating, pivoting, and
  CSV/TSV workflows; write results back with `DataFrame.to_excel` or
  `to_csv` when the deliverable is the data, and with openpyxl when the
  deliverable is a formatted workbook.

### Formulas: honest about recalculation

**openpyxl does not evaluate formulas.** A cell written as `=SUM(B2:B10)` is
stored as that formula string; its cached value is absent until the file is
opened in a spreadsheet application. So:

- Use formulas for derived values instead of hardcoding results — the file is
  correct even though this sandbox never sees the computed number.
- Do NOT present a formula's result as if you computed it. If the person (or
  you, for the analysis) needs the value now, compute it in Python — with
  pandas on the source data — and either write the computed value or report
  it in the chat, saying which is which.
- Never claim a cell "shows" a number you did not verify.

Formula requirements:

- Do not use dynamic array functions like `FILTER`, `XLOOKUP`, `SORT`, or
  `SEQUENCE`.
- Keep formulas simple and legible; use helper cells for complex logic.
- Avoid volatile functions like `INDIRECT` and `OFFSET` unless required.
- Prefer cell references over magic numbers (for example, `=H6*(1+$B$3)`
  instead of `=H6*1.04`).
- Use absolute (`$B$4`) or relative (`B4`) references carefully so copied
  formulas behave correctly.
- If you need literal text that starts with `=`, prefix it with a single
  quote.
- Guard against `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A`, and `#NAME?` errors.

### Editing an existing workbook

A workbook the person attached is at `/mnt/data/<its filename>` in the
sandbox; one produced earlier in the conversation is in the working
directory.

**Decision rule.** A new workbook: openpyxl. A workbook the person supplied
that you must change: use the bundled `xlsx_patch` helper. **Never**
`openpyxl.load_workbook(...).save(...)` on a supplied file: openpyxl rebuilds
the package and silently drops what it does not model (conditional-formatting
and data-validation extensions, slicers, custom XML) from every sheet,
including sheets you never touched.

1. Inspect first (read-only): sheet names, used range, existing formulas,
   number formats. Report briefly what you found.
2. Load `scripts/xlsx_patch.py` with `load_skill_file`, write it into the
   working directory, and import it (same flow as the `pdf-tools` skill).
3. `patch_cells` into a NEW file in the working directory (the output folder
   the sandbox tells you to save deliverables in); never overwrite the
   original. One call per sheet.
4. `verify`, then reopen read-only and print the cells you set.

```python
import datetime, xlsx_patch as xp   # xlsx_patch.py written out first

rep = xp.patch_cells("/mnt/data/budget.xlsx", "budget-updated.xlsx", "Q3", {
    "B3": "Approved",                          # text
    "C3": 12.5,                                # number (bool works too)
    "D3": datetime.date(2026, 1, 31),          # date; the cell needs a date format
    "E3": xp.Formula("=C3*2"),                 # formula, no cached value
    "F3": None,                                # clear the value, keep the style
    "A40": xp.Cell("Total", style_from="A39"), # new cell styled like another
})
print(rep["cells_set"], rep["changed_parts"])
print(xp.verify("/mnt/data/budget.xlsx", "budget-updated.xlsx", "Q3"))
```

`xp.sheet_names(path)` lists `(name, part, state)`. Cells keep their existing
style unless you pass `Cell(..., style_from="A1")` or `style=<int>`. Strings
are stored inline (Excel converts them on its next save).

Errors, all `xlsx_patch.PatchError` with a message saying what to do:

- a cell inside a merged range other than its top-left: write to the top-left;
- the master cell of a shared or array formula: it would orphan the cells that
  depend on it, so write elsewhere or tell the person;
- unknown sheet (the message lists the real names), a chart sheet, a strict
  OOXML workbook, a sheet over 50 MB of XML, or an unsupported value type;
- `verify` failing: a part other than the target sheet changed, the zip is
  corrupt, or openpyxl cannot reopen the result. Do not deliver that file.

If a refusal blocks the edit, say so and ask; never hand-edit the zip (and
never build one by reusing `ZipInfo` objects from another archive).

Not covered: inserting or deleting rows or columns, adding sheets or styles,
extending a table or validation range, comments, rich text. Say so rather than
reaching for openpyxl load+save. After delivery, tell the person what changed,
that new formulas have no computed value until the file is opened in Excel,
and that the check was structural (not a rendered view).

Preserve existing formatting and style exactly; match styles for newly filled
cells that were previously blank. Never overwrite established formatting
unless the person explicitly asks for a redesign.

### Formatting a new workbook

- Use appropriate number and date formats; dates render as dates, not plain
  numbers.
- Percentages default to one decimal place unless the data calls for
  something else; currencies use the appropriate currency format.
- Headers visually distinct from raw inputs and derived cells; fills, borders,
  and merged cells sparingly and intentionally.
- Set row heights and column widths so content is readable; ensure text does
  not spill into adjacent cells.
- Group related calculations and make totals simple sums of the cells above
  them. Add whitespace to separate sections.

### Colour conventions (if no style guidance is given)

- Blue: user input
- Black: formulas and derived values
- Green: linked or imported values
- Gray: static constants
- Orange: review or caution
- Light red: error or flag
- Purple: control or logic
- Teal: visualization anchors and KPI highlights

### Charts

Use openpyxl's native charts so the chart lives in the workbook:
`openpyxl.chart.BarChart`, `LineChart`, `PieChart`, `ScatterChart` — add data
ranges with `Reference`, set titles and axis titles, and add the chart to a
sheet with `ws.add_chart(chart, "H2")`. For exploratory plots of the data
itself (not embedded in the workbook), a matplotlib figure shown in the chat
is often the faster answer.

### Checking before delivery

For a new workbook, re-open the saved file with openpyxl and verify: sheet names, the dimensions
you intended, a sample of cell values and formulas as written, number formats
on key cells, and that charts exist where you added them. Say in one line
what you checked and what you could not (the computed formula values, and the
exact visual layout).

### Rules

- The workbook is the deliverable: the file must exist when you finish —
  run the code yourself or write one complete runnable block; a script the
  person still has to run is not the file.
- The app's Python cannot recalculate formulas and there is no spreadsheet
  renderer — say so once if it matters, then deliver the workbook.
- Deliverables are saved by a code block to `/mnt/output/<clear filename>`
  (e.g. `/mnt/output/report.xlsx`); only files under `/mnt/output/` are offered
  to the person as downloads. Scratch files elsewhere (the working directory,
  `/tmp`) are never shown, so keep round-trip or test copies there. Only
  describe files you actually produced.
- Iterate with the `execute_code` tool when you need to see a result — run,
  read, fix, run again.
