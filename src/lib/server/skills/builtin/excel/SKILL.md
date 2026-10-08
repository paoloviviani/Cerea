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

- Inspect first: sheet names, used range, existing formulas, number formats.
  Report briefly what you found.
- Preserve existing formatting and style exactly; match styles for any newly
  filled cells that were previously blank. Never overwrite established
  formatting unless the person explicitly asks for a redesign.

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

Re-open the saved file with openpyxl and verify: sheet names, the dimensions
you intended, a sample of cell values and formulas as written, number formats
on key cells, and that charts exist where you added them. Say in one line
what you checked and what you could not (the computed formula values, and the
exact visual layout).

## Rules

- The app's Python cannot recalculate formulas and there is no spreadsheet
  renderer — say so once if it matters, then deliver the workbook.
- Files are written to the working directory by a code block under a clear
  filename; only describe files you actually produced.
- Iterate with the `execute_code` tool when you need to see a result — run,
  read, fix, run again.
