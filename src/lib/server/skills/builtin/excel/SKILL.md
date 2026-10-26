---
name: excel
description: Create, edit, and analyze spreadsheets (.xlsx, .csv, .tsv) with openpyxl and pandas — structured workbooks with formulas, formatting, native charts, and data analysis. Use when a task involves creating, editing, analyzing, or visualizing spreadsheet data.
---

# Spreadsheets

Use this skill when the person wants a spreadsheet created, edited, analyzed,
or visualized.

## Setup

Install before importing (openpyxl and pandas both ship with this runtime's
package set):

```python
import micropip
await micropip.install("openpyxl")
import openpyxl
import pandas as pd
```

## Choosing the tool

- **openpyxl** for `.xlsx` structure: creating and editing workbooks, cell
  formatting, formulas, and native charts (`openpyxl.chart`).
- **pandas** for analysis: reading, filtering, aggregating, pivoting, and
  CSV/TSV workflows; write results back with `DataFrame.to_excel` or
  `to_csv` when the deliverable is the data, and with openpyxl when the
  deliverable is a formatted workbook.

## Formulas: honest about recalculation

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

## Editing an existing workbook

**First choice: the document tools.** If `doc_outline`, `doc_read` and `doc_edit` are in your tool list, edit a
supplied workbook with them and write no code: `doc_outline` for the structure and ids, `doc_read` for exact
content, then `doc_edit` with typed operations (set cells and formulas, clear cells, add a sheet, insert an image; other sheets, charts and extensions are left untouched). The edit is saved as a new version of the file
under the same name, the original is kept, and the result gives you the diff and a verification report to
summarise for the person. Edit again by the same name to build on your last version. If the tools are not in
your list, the service is not set up on this deployment: use the helpers below, which do the same work inside
the sandbox. (New files are still made as described elsewhere in this skill.)

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

## Formatting a new workbook

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

## Colour conventions (if no style guidance is given)

- Blue: user input
- Black: formulas and derived values
- Green: linked or imported values
- Gray: static constants
- Orange: review or caution
- Light red: error or flag
- Purple: control or logic
- Teal: visualization anchors and KPI highlights

## Charts

Use openpyxl's native charts so the chart lives in the workbook:
`openpyxl.chart.BarChart`, `LineChart`, `PieChart`, `ScatterChart` — add data
ranges with `Reference`, set titles and axis titles, and add the chart to a
sheet with `ws.add_chart(chart, "H2")`. For exploratory plots of the data
itself (not embedded in the workbook), a matplotlib figure shown in the chat
is often the faster answer.

## Analysis

- Read the data first and print its shape: header, row count, one sample row.
  Never invent rows — work with exactly what was given.
- One focused code block per step, verifying each step's output before the
  next. Report intermediate shapes so the person can follow.
- Cite sources inside the workbook using plain-text URLs, and add a source
  column when each row of tabular data is a separate item.

## Checking before delivery

For a new workbook, re-open the saved file with openpyxl and verify: sheet names, the dimensions
you intended, a sample of cell values and formulas as written, number formats
on key cells, and that charts exist where you added them. Say in one line
what you checked and what you could not (the computed formula values, and the
exact visual layout).

## Rules

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
