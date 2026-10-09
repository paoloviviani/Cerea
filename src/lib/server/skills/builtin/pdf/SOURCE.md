# Source

- **Upstream:** https://github.com/openai/skills, `skills/.curated/pdf`
- **Commit:** 49f948faa9258a0c61caceaf225e179651397431 (still on upstream's
  main at extraction time; last modified by 77963424cd7687fd52e5fcfdd3f08d826ab9b1ab)
- **Licence:** Apache-2.0 (`LICENSE.txt`, kept verbatim beside this file)

## Changes from upstream

- The rendering and extraction story is rewritten for Cerea: pdfplumber pins
  Pillow beyond Pyodide's build and pypdfium2 has no WASM wheel, so reads go
  through pypdf; pdftoppm/Poppler does not exist here, so verification is
  "read the text back with pypdf", not "render pages to PNG".
- Creation is reportlab (as upstream), with the sandbox's font reality stated:
  the base-14 fonts always work, Unicode needs a TTF registered from bytes the
  person supplies, and there is no font bundle.
- PDF editing/manipulation (merge, split, forms, encryption) is delegated to
  the separate `pdf-tools` skill; this skill is creation and checking.
- The `agents/openai.yaml` metadata and the `assets/` icons are not shipped;
  the dependency section is replaced by Cerea's micropip setup.
