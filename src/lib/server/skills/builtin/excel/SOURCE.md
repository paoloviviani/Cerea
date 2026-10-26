# Source

- **Upstream:** https://github.com/openai/skills, `skills/.curated/spreadsheet`
- **Commit:** 7b54889398822db28c72aeec8e95be7c20418d1a (the last commit that
  carried the skill; it was removed from HEAD in fdf90d6 "Remove spreadsheets
  and slides skills (#350)")
- **Licence:** Apache-2.0 (`LICENSE.txt`, kept verbatim beside this file)

## Changes from upstream

- Renamed the skill `spreadsheet` → `excel`.
- The recalculation and rendering story is rewritten for Cerea: openpyxl does
  not evaluate formulas and there is no LibreOffice/Poppler, so the skill now
  states that plainly and splits "formula in the file" from "value computed
  in Python for the analysis" instead of assuming a recalculation tool.
- The `agents/openai.yaml` metadata and the `assets/` icons are not shipped.
- The formula, formatting, colour, finance and citation requirements are kept
  as written. The four openpyxl example scripts under
  `references/examples/openpyxl/` are upstream's, moved one level (Cerea
  bundled files must live under `scripts/`, `references/` or `assets/`).
- Added `scripts/xlsx_patch.py`: original Cerea work (Apache-2.0, not from
  upstream). It edits cells of an existing workbook at the XML level so parts
  openpyxl would drop (x14 extensions and the like) survive. The excel
  `SKILL.md` "Editing an existing workbook" section is rewritten around it.
