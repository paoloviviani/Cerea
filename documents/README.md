# cerea-documents

The Cerea document service (ADR 0103): precise, hardened edits of Word, Excel and PowerPoint files, and
creation of Word, Excel, PowerPoint and PDF files from a spec, behind a small internal HTTP API. Step 1 of
the plan: the service skeleton, the hardening, outline, read and edit for `.docx`, `.xlsx` and `.pptx`.
Step 2: the chat's `doc_outline`, `doc_read` and `doc_edit` tools (built from `/v1/capabilities`) and the
kit's `documents` service. Step 3: `/v1/create` and `/v1/create_from_template`, and the chat's `doc_create`
and `doc_create_from_template`. Conversion comes in a later step. The in-sandbox helpers in the skills stay
as the fallback.

- Python 3.13, Starlette + uvicorn, lxml. No LibreOffice, no browser. Stateless, no storage.
- Edits touch only the parts they change; every other part of the package is copied through byte for byte.
- Creation is deterministic: the same spec gives the same bytes (fixed timestamps in every zip entry and
  document property, a fixed chart style).
- Licence: Apache-2.0, like the rest of the repository.

## Layout

```
documents/
  pyproject.toml, uv.lock     uv project (lockfile committed), Python 3.13
  Dockerfile                  non-root, slim base, HEALTHCHECK, no build tools in the final image
  src/cerea_documents/
    api.py          HTTP layer: auth, size limits, multipart, envelope schema. Never parses a document.
    runner.py       one fresh, resource-limited subprocess per request; killed on overrun
    worker.py       the subprocess: applies RLIMIT_* first, then runs core on the job directory
    core.py         outline / read / edit on bytes; format detection; all-or-none; verify
    schemas.py      JSON-schema validation of bodies and of every operation
    word.py excel.py powerpoint.py   the three engines (ported from the 0.29.0 sandbox helpers)
    verify.py       the post-edit check (byte-identical untouched parts, XML, rels, content types, reopen)
                    and the check of a created file (verify_created)
    spec.py         the document spec: JSON schemas, validation, the Markdown shorthand (published in capabilities)
    theme.py        the neutral built-in style set and the spec's theme overrides
    create.py       create and create_from_template: validate, build, verify, outline; fills uploaded templates
    make_docx.py make_xlsx.py make_pptx.py make_pdf.py   the four builders (python-docx, openpyxl, python-pptx, reportlab)
    charts.py       charts: matplotlib (Agg) PNGs and native charts (python-pptx; the same chart part serves Word)
    determinism.py  fixed zip dates and document stamps
    pkg.py          lazy OOXML package with fresh-ZipInfo rewrite; xmlsafe.py, zipsafe.py, images.py: hardening
    config.py       limits and settings, all overridable by environment variables
  tests/            pytest: engines, HTTP API, hostile fixtures, limits, units, fuzz, licences
```

## API

All `/v1/*` calls need the header `X-Cerea-Documents-Secret: <CEREA_DOCUMENTS_SECRET>` (constant-time
comparison). `GET /healthz` is open. Requests are `multipart/form-data`:

| part    | meaning                                                                                     |
| ------- | ------------------------------------------------------------------------------------------- |
| `file`  | the document (exactly one)                                                                  |
| `body`  | JSON object (required for `read` and `edit`, optional for `outline`)                        |
| `image` | zero or more image files; the part's **filename** is the name operations use to refer to it |

The document type comes from the file's own content (the main part's content type). The filename
extension, or `format` in the body, is checked against it: a mismatch is refused (415), never
silently converted. `.docm`/`.xlsm`/`.pptm` are edited as what they are and stay what they are.

### `GET /healthz`

`{"status": "ok", "version": "0.1.0"}`

### `GET /v1/capabilities`

Formats and operations actually implemented, deferred ones, and the effective limits:

```json
{
	"engine": "cerea-documents/0.1.0",
	"formats": {
		"docx": {
			"outline": true,
			"read": true,
			"operations": ["..."],
			"deferred_operations": ["add_comment", "insert_chart"],
			"track_changes": true
		},
		"xlsx": {},
		"pptx": {}
	},
	"image_types": ["png", "jpeg", "gif"],
	"create": true,
	"create_from_template": true,
	"create_formats": ["docx", "xlsx", "pptx", "pdf"],
	"create_schemas": { "docx": { "document": {}, "blocks": {} }, "xlsx": {}, "pptx": {}, "pdf": {} },
	"convert": false,
	"limits": { "max_zip_entries": 5000 }
}
```

### `POST /v1/outline`

JSON structure with stable ids. Word: blocks `p1..` and `t1..` (style, text, table cells), images `i1..`,
sections, header/footer text, `{{placeholders}}`, comment and tracked-change counts. Excel: sheets
(state, used range, tables, charts, images, merged ranges), defined names. PowerPoint: slides with
layout, shapes (id, kind, placeholder, text, box, picture part) and notes. Every outline also lists
`passed_through`: macro, ActiveX and OLE parts present (never parsed, executed or modified).

### `POST /v1/read`

Body `{"targets": [...]}`; targets by format: Word `["p3", "t1"]` (paragraph text with run formatting;
table cells); Excel `[{"sheet": "Data", "range": "A1:C10"}]` (values and formulas of non-empty cells);
PowerPoint `[{"slide": 2}]` (paragraphs with runs, notes).

### `POST /v1/edit`

Body:

```json
{
	"operations": [{ "op": "replace_text", "find": "Acme", "replace": "Beta" }],
	"track_changes": false,
	"author": "Cerea",
	"format": "docx"
}
```

Response: `multipart/form-data` with a `result` part (JSON) and a `file` part (the new file bytes).
Send `Accept: application/json` or `?response=json` to get one JSON object with `file_base64` instead.

```json
{
	"format": "docx",
	"engine": "cerea-documents/0.1.0",
	"operations": [
		{
			"index": 0,
			"op": "replace_text",
			"result": { "replaced": 1, "by_part": { "word/document.xml": 1 } }
		}
	],
	"diff": ["word/document.xml:", "- Dear Acme", "+ Dear Beta"],
	"verify": {
		"ok": true,
		"parts": 20,
		"byte_identical": 19,
		"changed": ["word/document.xml"],
		"added": [],
		"removed": [],
		"reopened_with": "python-docx"
	},
	"passed_through": [],
	"file_name": "report.docx",
	"content_type": "...",
	"file_bytes": 38000
}
```

All operations or none: a failing operation fails the whole call and no file is produced. References
inside one request (`p3`, `t1`, slide numbers) always mean the **original** document, whatever earlier
operations in the request did; a reference to something an earlier operation deleted is refused.

Errors are JSON with a stable `code`, a `reason`, an actionable `message` listing what exists, and the
failing `operation_index`:

```json
{
	"error": {
		"code": "operation_failed",
		"operation_index": 1,
		"message": "operation 1 (set_table_cell): t1 has 3 rows (0-based); row 40 does not exist",
		"details": {
			"operation": "set_table_cell",
			"applied_before_failure": 1,
			"nothing_written": true
		}
	}
}
```

| status | code                          | when                                                                                |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------- |
| 401    | `unauthorized`                | missing or wrong secret                                                             |
| 413    | `too_large`, `resource_limit` | request, body or output too large; worker out of memory                             |
| 415    | `unsupported_format`          | not Word/Excel/PowerPoint, or name and content disagree                             |
| 422    | `invalid_request`             | body or operation fails its schema (`reason: schema`), unknown operation, bad image |
| 422    | `operation_failed`            | the operation cannot be applied to this document                                    |
| 422    | `invalid_document`            | not a package, malformed XML, damaged part                                          |
| 422    | `unsafe_document`             | a hardening rule fired; `reason` says which (below)                                 |
| 504    | `time_limit`                  | wall-clock or CPU limit; the worker was killed                                      |

### `POST /v1/create`

A new file from a document spec. Multipart parts: `body` (JSON, required), `image` parts (the names the spec
uses), and optionally one `file` part: the uploaded file `spec.theme.template` takes its styles from.

```json
{
	"format": "docx",
	"file_name": "report",
	"spec": {
		"title": "Q3 report",
		"language": "en-GB",
		"page": { "size": "A4", "orientation": "portrait", "margins_cm": 2.5 },
		"header": { "text": "Confidential" },
		"footer": { "text": "Page {page} of {pages}" },
		"theme": { "body_font": "Georgia", "accent": "00AA55", "table_style": "banded" },
		"blocks": [
			{ "type": "heading", "level": 1, "text": "Q3 report" },
			{ "type": "paragraph", "runs": [{ "text": "Units rose " }, { "text": "12%", "bold": true }] },
			{
				"type": "table",
				"header": ["Region", "Units"],
				"rows": [
					["North", 3],
					["South", 5]
				]
			},
			{
				"type": "chart",
				"chart_type": "column",
				"categories": ["North", "South"],
				"series": [{ "name": "2026", "values": [3, 5] }],
				"render": "native"
			},
			{ "type": "image", "image": "logo.png", "width_cm": 4 }
		]
	}
}
```

The response is the same as an edit's: `multipart/form-data` with `result` and `file` parts, or one JSON object with
`file_base64` for `Accept: application/json`. The result carries `format`, `engine`, `outline` (what was written,
with ids the edit tools take), `verify` (valid package, reopens, or for a PDF its page count), `charts` (per chart:
what was asked and what was written), `notes` (for example a style the template lacks), `styled_from` (`built-in`
or `template`), `file_name`, `content_type` and `file_bytes`. `file_name` is made safe and given the format's
extension.

**The spec** (all properties are checked; an unknown or misplaced one is refused with the allowed list, and the
whole call fails before anything is built). `GET /v1/capabilities` publishes every schema as `create_schemas`.

| format    | top level                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docx, pdf | `title`, `language`, `page` (`size`: A4, A3, A5, Letter, Legal; `orientation`; `margins_cm`), `header`, `footer`, `theme`, and `blocks` **or** `markdown` |
| xlsx      | `title`, `language`, `theme`, `sheets`                                                                                                                    |
| pptx      | `title`, `language`, `theme`, `size` (`16:9` or `4:3`), `slides`                                                                                          |

Blocks (Word and PDF; slides take the last seven): `heading` (level 1-6), `paragraph` (runs with bold, italic,
underline, code, colour, link; `align`), `list` (ordered or bulleted, nested through `children`), `table` (header
row, rows, `widths`, per-column `align`, `style`, `caption`), `image` (name of an `image` part, width or height in
cm, caption, alt, alignment), `chart`, `page_break`, `toc` (a field with cached entries in Word; with page numbers
in PDF), `quote`, `code`. Sheets: `rows` (plain values from `start`) and `cells` (value, formula, date, number
format, bold, italic, fill, colour, alignment, wrap, a named `style` of a template), `column_widths`, `freeze`,
`autofilter`, `merge`, `tables`, `charts` (a `data_range` on the sheet and an `anchor`), `images` at a cell. A
string value starting with `=` is a formula (written, never evaluated; the workbook recalculates on open; formulas
that reach outside the workbook or run a command are refused). Slides: `layout` (`title`, `title_content`,
`section`, `two_content`, `title_only`, `blank`, or a layout name of the template), `title`, `subtitle`, `body`,
`body_right`, `notes`, `images` (an explicit box in cm, or `fit: "placeholder"` to fit the body area) and `charts`.

Markdown (`markdown` instead of `blocks`) takes headings, paragraphs with `**bold**`, `*italic*`, `` `code` ``
and links, nested lists, pipe tables with alignment, quotes, fenced code, `![alt](image-name)`, `[TOC]` and
`\newpage`, with an optional front-matter (`title`, `language`, `page_size`, `orientation`, `header`, `footer`).
It becomes the same block tree; raw HTML and links that are not http, https or mailto are refused.

**Styling.** One neutral built-in set (Calibri, A4, a blue accent, banded tables). `theme` overrides only what the
person asked for: `body_font` and `heading_font` from an allow-list of fonts commonly installed with Office
(PDF maps them to the nearest of three embedded DejaVu families), `body_size_pt`, `heading_sizes_pt`,
`colors` (text, heading, accent, muted, link, table header fill and text, table band, border), `accent`,
`line_spacing`, `paragraph_spacing_pt`, `table_style` (banded, grid, minimal, plain). With `theme.template` the
uploaded file supplies the styles (Word: styles, headers, footers, page setup; PowerPoint: master, layouts and
size; Excel: named styles), the template's own content is dropped, only what the theme names explicitly is
applied on top, and a style the template lacks falls back to direct formatting and is listed in `notes`. A
template is hostile input like any file: package checks, the right type, and **macros, ActiveX and OLE objects
are refused** (`unsafe_document` / `active_content`), because created files never carry active content.

**Charts.** `chart_type`: bar, column, stacked (stacked columns), line, area, pie, doughnut, scatter (series of
`points`). `render`: `native` (the default) or `image`.

| `render` | Word                                                                    | Excel                                             | PowerPoint          | PDF   |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------- | ------------------- | ----- |
| `native` | a chart part written like PowerPoint's, with its data workbook embedded | an openpyxl chart over the `data_range`           | a python-pptx chart | image |
| `image`  | a PNG from matplotlib (Agg, fixed style)                                | the same PNG at the anchor (needs literal values) | the same PNG        | image |

If a native chart cannot be written it is delivered as an image and the result says so (`charts[].note`).

### `POST /v1/create_from_template`

Fills a template the person uploaded: parts `file` (the template, required), `body` (`{"values": {...},
"format"?}`) and `image` parts. Word: `{{name}}` in the body, tables, headers and footers (also split across runs);
PowerPoint: `{{name}}` in text boxes, placeholders and notes; Excel: cells containing `{{name}}` (a cell that is only
the placeholder keeps the value's type) and defined names (a list value fills the named range). A value
`{"image": "logo.png", "width_cm": 3}` replaces a paragraph, shape or cell that holds only the placeholder with a
picture. A key that is not in the template fails the whole call (`unknown_placeholder`, with the names that exist);
placeholders without a value stay and are listed as `unfilled`. It reuses the edit engines, so only the parts it
fills change and the result has the edit report's `diff` and `verify`, plus `filled` and `unfilled`.

### Operations

Implemented (also listed by `/v1/capabilities`):

| format     | operations                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Word       | `replace_text`, `fill_placeholders`, `set_paragraph_text`, `insert_paragraph_after`, `delete_paragraph`, `set_table_cell`, `add_table_row`, `insert_image_after`, `replace_image`; `track_changes` + `author` write `w:ins`/`w:del` |
| Excel      | `set_cells` (strings, numbers, booleans, `{"formula": "=B3*2"}`, `{"date": "2026-01-31"}`, `{"datetime": "..."}`, `style_from`), `clear_cells`, `add_sheet` (appended), `insert_image` (at a cell)                                  |
| PowerPoint | `replace_text`, `set_placeholder_text`, `replace_image`, `insert_image`, `duplicate_slide`, `delete_slide`, `reorder_slides`, `set_notes`, `replace_slide`, `add_slide`, `update_shape`                                             |

Deferred (not in capabilities as operations; an unknown name is refused with the list of what exists):
Word `add_comment`, `insert_chart`; Excel `insert_rows`/`delete_rows` (v1.1: needs safe formula, merge
and table shifting), `insert_chart`; PowerPoint `insert_chart`, and `insert_image` into a
picture placeholder (positioned images work). `set_notes` refuses a deck that has no notes master;
`track_changes` is Word-only (Excel and PowerPoint refuse it). Conversion is a later step (`convert` is
`false` in capabilities); the edit operations also work on files this service created.

## Hardening (ADR 0103 section 6)

| rule                                                                                                                                                          | where                      | limit (env var, default)                                                                                                               | refused as                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| XML: `resolve_entities=False`, `no_network`, `load_dtd=False`, `huge_tree=False`; DOCTYPE and ENTITY refused in **every** XML part before any library sees it | `xmlsafe.py`, `zipsafe.py` |                                                                                                                                        | `unsafe_document` / `doctype`                                                        |
| zip entry count                                                                                                                                               | `zipsafe.py`               | `CEREA_DOCUMENTS_MAX_ZIP_ENTRIES` 5000                                                                                                 | `too_many_entries`                                                                   |
| per-part and total uncompressed size                                                                                                                          |                            | `MAX_PART_BYTES` 32 MiB, `MAX_TOTAL_BYTES` 256 MiB                                                                                     | `part_too_large`, `total_too_large`                                                  |
| compression ratio (large parts and overall)                                                                                                                   |                            | `MAX_RATIO` 200                                                                                                                        | `zip_bomb`                                                                           |
| absolute paths, `..`, backslashes, drive letters, control characters, duplicates (case-folded), symlinks, encrypted and non-deflate entries                   |                            |                                                                                                                                        | `path_traversal`, `duplicate_entry`, `symlink`, `encrypted`, `compression`           |
| macros (`vbaProject.bin`), ActiveX, OLE: copied through untouched, never parsed or executed, listed in `passed_through`; no operation adds active content     | `core.py`                  |                                                                                                                                        |                                                                                      |
| images: PNG, JPEG, GIF only (SVG refused); header checked against content; pixel and byte budget; `PIL.Image.MAX_IMAGE_PIXELS` set                            | `images.py`                | `MAX_IMAGE_PIXELS` 40,000,000, `MAX_IMAGE_BYTES` 20 MiB                                                                                | `invalid_request` / `image_type`, `image_pixels`, `image_too_large`, `image_damaged` |
| request size, JSON body size, operation and image counts                                                                                                      | `api.py`                   | `MAX_REQUEST_BYTES` 64 MiB, `MAX_BODY_BYTES` 1 MiB, `MAX_OPERATIONS` 200, `MAX_IMAGES` 20                                              | `too_large`, `invalid_request`                                                       |
| every request in a fresh subprocess; the HTTP process never parses a document; the worker sees no secret and a minimal environment                            | `runner.py`, `worker.py`   |                                                                                                                                        |                                                                                      |
| `RLIMIT_AS`, `RLIMIT_CPU`, `RLIMIT_FSIZE`, `RLIMIT_CORE=0`, `RLIMIT_NOFILE`, wall-clock kill of the whole process group                                       |                            | `WORKER_MEMORY_BYTES` 1.5 GiB, `WORKER_CPU_SECONDS` 20, `WORKER_WALL_SECONDS` 30, `MAX_OUTPUT_BYTES` 128 MiB                           | `resource_limit`, `time_limit`                                                       |
| simultaneous workers                                                                                                                                          |                            | `MAX_CONCURRENCY` 4                                                                                                                    | queues                                                                               |
| typed operations only: no `eval`, no executing templates, no formula evaluation; schemas validated before any work                                            | `schemas.py`, `spec.py`    |                                                                                                                                        | `invalid_request`                                                                    |
| the spec: JSON nesting (iterative, no recursion), blocks and items, table cells, sheet cells, slides, chart values; link schemes; fonts from an allow-list    | `spec.py`, `api.py`        | `MAX_SPEC_DEPTH` 24, `MAX_BLOCKS` 3000, `MAX_TABLE_CELLS` 20,000, `MAX_SHEET_CELLS` 100,000, `MAX_SLIDES` 200, `MAX_CHART_POINTS` 5000 | `invalid_request` / `too_deep`, `too_large`, `schema`                                |
| templates for creation: the same package checks, the right type, no macros, ActiveX or OLE; created files never carry active content                          | `create.py`                |                                                                                                                                        | `unsafe_document` / `active_content`                                                 |
| native libraries that give up on the memory cap (BLAS under numpy) are the same refusal as `MemoryError`                                                      | `runner.py`                |                                                                                                                                        | `resource_limit`                                                                     |
| structurally odd but well-formed documents (a number that is not a number)                                                                                    | `core.py`                  |                                                                                                                                        | `invalid_document` / `malformed_structure`                                           |

All environment variables are prefixed `CEREA_DOCUMENTS_`. Other settings: `SECRET` (required),
`ALLOW_NO_AUTH=1` (explicit dev flag; without a secret and without this flag the service refuses to
start), `HOST`, `PORT` (8090), `TMPDIR` (per-request job directories, default `/tmp`), `LOG_LEVEL`.

Tests for each rule are in `tests/test_hostile.py` (zip bombs by ratio, many parts and per-part cap,
XXE in docx/xlsx/pptx, billion laughs, external DTD, DOCTYPE in an untouched part, path traversal in
four spellings, duplicates, symlink, encrypted entry, malformed and deeply nested XML, truncated and
non-zip input, macro-enabled file passed through byte-identical, huge/SVG/fake/garbage images, oversized
request by header and by stream, oversized body, too many operations or images) and
`tests/test_limits.py` (a runaway worker killed by the wall clock and by the CPU limit, memory cap, no
process left behind, the API returning 504 and serving the next request). Workers report their own peak
memory; the hostile suite asserts it stays far below the cap. `tests/test_units.py` holds property and
fuzz tests (random bytes, single-byte mutations of real files: only a clean refusal or success).

## Running

```sh
uv sync                       # dev environment (uv.lock is committed)
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest
CEREA_DOCUMENTS_SECRET=... uv run python -m cerea_documents     # listens on :8090
docker build -t cerea-documents documents/
```

## Compose settings

The service holds no state and needs no outbound network. The kit's `compose.yaml` runs it as the
`documents` service of the chat profile, with these settings (the kit mints the secret and passes it to
the chat as `CHAT_DOCUMENTS_SECRET` and to the service as `CEREA_DOCUMENTS_SECRET`):

```yaml
documents:
  image: ghcr.io/<owner>/cerea-documents:<the chat's version> # DOCUMENTS_IMAGE overrides
  read_only: true
  tmpfs: ["/tmp:rw,noexec,nosuid,size=256m"] # job directories
  cap_drop: [ALL]
  security_opt: ["no-new-privileges:true"]
  networks: [docs] # an internal-only network: no published port, no egress
  mem_limit: 2g # DOCUMENTS_MEM_LIMIT
  cpus: 2 # DOCUMENTS_CPUS
  pids_limit: 128
```

Size the tmpfs and `mem_limit` together: a request can hold the upload, the working copy and the
output in memory, at most `MAX_REQUEST_BYTES` each, per concurrent worker.

## Dependencies and licences

Every dependency, runtime and development, is under an OSI-approved licence (`tests/test_licences.py`
fails on anything it does not recognise; a new licence must be checked against the OSI list and added
there and here).

| package                                                            | licence                                        |     | package                           | licence                                |
| ------------------------------------------------------------------ | ---------------------------------------------- | --- | --------------------------------- | -------------------------------------- |
| starlette                                                          | BSD-3-Clause                                   |     | python-docx                       | MIT                                    |
| uvicorn, click                                                     | BSD-3-Clause                                   |     | python-pptx                       | MIT                                    |
| h11, anyio                                                         | MIT                                            |     | XlsxWriter                        | BSD-2-Clause                           |
| python-multipart                                                   | Apache-2.0                                     |     | openpyxl, et_xmlfile              | MIT                                    |
| jsonschema, jsonschema-specifications, referencing, rpds-py, attrs | MIT                                            |     | typing_extensions                 | PSF-2.0                                |
| lxml                                                               | BSD-3-Clause                                   |     | Pillow                            | MIT-CMU (HPND family, OSI-approved)    |
| reportlab, charset-normalizer (its dependency)                     | BSD-3-Clause, MIT                              |     | pypdf                             | BSD-3-Clause                           |
| matplotlib (charts as images)                                      | PSF-style (matplotlib licence, OSI classifier) |     | numpy                             | BSD-3-Clause (see the exception below) |
| contourpy, kiwisolver, cycler                                      | BSD                                            |     | fonttools, pyparsing, six         | MIT                                    |
| python-dateutil, packaging, tzdata                                 | Apache-2.0 or BSD                              |     | (matplotlib's other dependencies) |                                        |

Two things to know about the chart and PDF dependencies:

- **numpy's licence metadata** reads `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0`. numpy itself is
  BSD-3-Clause; 0BSD and Zlib are OSI-approved; **CC0-1.0 applies to one vendored header** (Highway's
  `hwy/contrib/random/random-inl.h`, a public-domain dedication) and is not on the OSI list. `tests/test_licences.py`
  therefore allows that exact expression for numpy and nothing else, so any change to it is seen.
- **The DejaVu fonts** that matplotlib ships (Bitstream Vera licence plus public-domain changes, a permissive font
  licence that is not on the OSI list) are what the PDF builder embeds, as subsets. They are data, not code; the
  alternative is a PDF without Unicode text.

Development only: pytest, pluggy, iniconfig (MIT); hypothesis, sortedcontainers (MPL-2.0 and Apache-2.0);
httpx, httpcore, idna (BSD); certifi, pathspec (MPL-2.0); ruff, mypy (MIT); lxml-stubs, types-\*
(Apache-2.0). The Python base image is the official `python:3.13-alpine` (PSF-2.0 and Alpine's licences).
The build stage uses `uv` (Apache-2.0 or MIT) and `binutils` (to strip the libraries); neither is in the final image.

## Image size

CI fails the image over 300 MB (`docker image inspect --format '{{.Size}}'`). Creation adds numpy, matplotlib,
fontTools, reportlab and pypdf, which on `python:3.13-slim` took the image to about 357 MB (layers) and past the
gate. The Dockerfile therefore builds on `python:3.13-alpine` (musl wheels exist for every locked package) and
prunes the build stage's virtualenv before copying it: type stubs, C and header sources, test directories,
matplotlib's sample data, icons and AFM fonts, and debug symbols (`strip`). The result is about 229 MB of layers
(about 305 MB by the containerd image store's `.Size`, which also counts the compressed layers). A worker pays
about 1 to 5 seconds of import time per request (numpy and matplotlib only when an image chart is drawn).
