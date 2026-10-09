# Source

- **Upstream:** https://github.com/openai/skills, `skills/.curated/doc`
- **Commit:** 77963424cd7687fd52e5fcfdd3f08d826ab9b1ab (the last commit that
  carried the skill; it was removed from HEAD in 228962a "Remove curated doc
  skill (#382)")
- **Licence:** Apache-2.0 (`LICENSE.txt`, kept verbatim beside this file)

## Changes from upstream

- Renamed the skill `doc` → `word` (the deployment's naming for file formats;
  the description carries the searchable wording).
- Every soffice / pdftoppm / `render_docx.py` (pdf2image / Poppler) step is
  removed: none of those exist in Cerea's browser sandbox, and no install
  makes them appear. Verification is now "read the document back with
  python-docx" instead of "render pages and look at them", stated honestly.
- The `agents/openai.yaml` metadata and the `assets/` icons are not shipped —
  they are platform packaging, not skill content.
- The dependency section (uv/pip/brew/apt) is replaced by Cerea's
  micropip-with-vendored-wheels setup, and the temp/output conventions
  (`tmp/docs/`, `output/doc/`) by Cerea's working-directory deliverable rule.
- The quality expectations and the ASCII-hyphen rule are kept as written.
