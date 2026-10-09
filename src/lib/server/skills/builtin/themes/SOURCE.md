# Source

- **Upstream:** https://github.com/anthropics/skills, `skills/theme-factory`
- **Commit:** 683bc88e56f3e09ba94f7055977f3d3aa499f202
- **Licence:** Apache-2.0 (`LICENSE.txt`, kept verbatim beside this file)

## Changes from upstream

- Renamed the skill `theme-factory` → `themes` (shorter built-in name; the
  description carries the searchable wording).
- The ten theme definitions moved from `themes/` to `references/themes/` —
  Cerea bundled files must live under `scripts/`, `references/` or `assets/`
  to be readable through `load_skill_file`. The files are unmodified.
- `theme-showcase.pdf` is not shipped: there is no renderer in Cerea's
  browser sandbox to produce it, and the skill now renders a swatch preview
  with matplotlib on request instead.
- The workflow text was rewritten for Cerea's execution model (apply themes
  with python-docx / python-pptx / matplotlib, never raw OOXML; font names
  are carried as names, no font files are bundled — none were shipped
  upstream either).
