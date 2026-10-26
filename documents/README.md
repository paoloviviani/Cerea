# cerea-documents

The Cerea document service (ADR 0103): precise, hardened edits of Word, Excel and PowerPoint files
behind a small internal HTTP API. Step 1 of the plan: the service skeleton, the hardening, outline,
read and edit for `.docx`, `.xlsx` and `.pptx`. Tools in the chat, document creation, conversion and
the kit wiring come in later steps. The in-sandbox helpers in the skills stay as the fallback.

- Python 3.13, Starlette + uvicorn, lxml. No LibreOffice, no browser. Stateless, no storage.
- Edits touch only the parts they change; every other part of the package is copied through byte for byte.
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
	"create": false,
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

### Operations

Implemented (also listed by `/v1/capabilities`):

| format     | operations                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Word       | `replace_text`, `fill_placeholders`, `set_paragraph_text`, `insert_paragraph_after`, `delete_paragraph`, `set_table_cell`, `add_table_row`, `insert_image_after`, `replace_image`; `track_changes` + `author` write `w:ins`/`w:del` |
| Excel      | `set_cells` (strings, numbers, booleans, `{"formula": "=B3*2"}`, `{"date": "2026-01-31"}`, `{"datetime": "..."}`, `style_from`), `clear_cells`, `add_sheet` (appended), `insert_image` (at a cell)                                  |
| PowerPoint | `replace_text`, `set_placeholder_text`, `replace_image`, `insert_image`, `duplicate_slide`, `delete_slide`, `reorder_slides`, `set_notes`                                                                                           |

Deferred (not in capabilities as operations; an unknown name is refused with the list of what exists):
Word `add_comment`, `insert_chart`; Excel `insert_rows`/`delete_rows` (v1.1: needs safe formula, merge
and table shifting), `insert_chart`; PowerPoint `add_slide`, `insert_chart`, and `insert_image` into a
picture placeholder (positioned images work). `set_notes` refuses a deck that has no notes master;
`track_changes` is Word-only (Excel and PowerPoint refuse it). Creation (`doc_create`) and conversion
are later steps (`create` and `convert` are `false` in capabilities).

## Hardening (ADR 0103 section 6)

| rule                                                                                                                                                          | where                      | limit (env var, default)                                                                                     | refused as                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| XML: `resolve_entities=False`, `no_network`, `load_dtd=False`, `huge_tree=False`; DOCTYPE and ENTITY refused in **every** XML part before any library sees it | `xmlsafe.py`, `zipsafe.py` |                                                                                                              | `unsafe_document` / `doctype`                                                        |
| zip entry count                                                                                                                                               | `zipsafe.py`               | `CEREA_DOCUMENTS_MAX_ZIP_ENTRIES` 5000                                                                       | `too_many_entries`                                                                   |
| per-part and total uncompressed size                                                                                                                          |                            | `MAX_PART_BYTES` 32 MiB, `MAX_TOTAL_BYTES` 256 MiB                                                           | `part_too_large`, `total_too_large`                                                  |
| compression ratio (large parts and overall)                                                                                                                   |                            | `MAX_RATIO` 200                                                                                              | `zip_bomb`                                                                           |
| absolute paths, `..`, backslashes, drive letters, control characters, duplicates (case-folded), symlinks, encrypted and non-deflate entries                   |                            |                                                                                                              | `path_traversal`, `duplicate_entry`, `symlink`, `encrypted`, `compression`           |
| macros (`vbaProject.bin`), ActiveX, OLE: copied through untouched, never parsed or executed, listed in `passed_through`; no operation adds active content     | `core.py`                  |                                                                                                              |                                                                                      |
| images: PNG, JPEG, GIF only (SVG refused); header checked against content; pixel and byte budget; `PIL.Image.MAX_IMAGE_PIXELS` set                            | `images.py`                | `MAX_IMAGE_PIXELS` 40,000,000, `MAX_IMAGE_BYTES` 20 MiB                                                      | `invalid_request` / `image_type`, `image_pixels`, `image_too_large`, `image_damaged` |
| request size, JSON body size, operation and image counts                                                                                                      | `api.py`                   | `MAX_REQUEST_BYTES` 64 MiB, `MAX_BODY_BYTES` 1 MiB, `MAX_OPERATIONS` 200, `MAX_IMAGES` 20                    | `too_large`, `invalid_request`                                                       |
| every request in a fresh subprocess; the HTTP process never parses a document; the worker sees no secret and a minimal environment                            | `runner.py`, `worker.py`   |                                                                                                              |                                                                                      |
| `RLIMIT_AS`, `RLIMIT_CPU`, `RLIMIT_FSIZE`, `RLIMIT_CORE=0`, `RLIMIT_NOFILE`, wall-clock kill of the whole process group                                       |                            | `WORKER_MEMORY_BYTES` 1.5 GiB, `WORKER_CPU_SECONDS` 20, `WORKER_WALL_SECONDS` 30, `MAX_OUTPUT_BYTES` 128 MiB | `resource_limit`, `time_limit`                                                       |
| simultaneous workers                                                                                                                                          |                            | `MAX_CONCURRENCY` 4                                                                                          | queues                                                                               |
| typed operations only: no `eval`, no executing templates, no formula evaluation; schemas validated before any work                                            | `schemas.py`               |                                                                                                              | `invalid_request`                                                                    |
| structurally odd but well-formed documents (a number that is not a number)                                                                                    | `core.py`                  |                                                                                                              | `invalid_document` / `malformed_structure`                                           |

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

## Intended compose settings

The service holds no state and needs no outbound network. Step 2 wires it into `kit/compose.yaml`; the
intended settings are:

```yaml
# documents:
#   image: ghcr.io/<owner>/cerea-documents:<pinned, like the chat image>
#   restart: unless-stopped
#   environment:
#     CEREA_DOCUMENTS_SECRET: ${CEREA_DOCUMENTS_SECRET}   # generated by the kit
#   read_only: true
#   tmpfs:
#     - /tmp:rw,noexec,nosuid,size=256m                    # job directories; sized for MAX_REQUEST_BYTES x concurrency
#   cap_drop: [ALL]
#   security_opt: ["no-new-privileges:true"]
#   networks: [internal]                                   # an internal-only network: no published port, no egress
#   mem_limit: 2g                                          # above WORKER_MEMORY_BYTES x MAX_CONCURRENCY is not needed: workers are capped
#   cpus: 2
#   pids_limit: 128
#   healthcheck: {test: ["CMD", "python", "-c", "..."], interval: 30s}   # the image already defines one
# chat service: environment CEREA_DOCUMENTS_URL=http://documents:8090 and the same secret
```

Size the tmpfs and `mem_limit` together: a request can hold the upload, the working copy and the
output in memory, at most `MAX_REQUEST_BYTES` each, per concurrent worker.

## Dependencies and licences

Every dependency, runtime and development, is under an OSI-approved licence (`tests/test_licences.py`
fails on anything it does not recognise; a new licence must be checked against the OSI list and added
there and here).

| package                                                            | licence      |     | package              | licence                             |
| ------------------------------------------------------------------ | ------------ | --- | -------------------- | ----------------------------------- |
| starlette                                                          | BSD-3-Clause |     | python-docx          | MIT                                 |
| uvicorn, click                                                     | BSD-3-Clause |     | python-pptx          | MIT                                 |
| h11, anyio                                                         | MIT          |     | XlsxWriter           | BSD-2-Clause                        |
| python-multipart                                                   | Apache-2.0   |     | openpyxl, et_xmlfile | MIT                                 |
| jsonschema, jsonschema-specifications, referencing, rpds-py, attrs | MIT          |     | typing_extensions    | PSF-2.0                             |
| lxml                                                               | BSD-3-Clause |     | Pillow               | MIT-CMU (HPND family, OSI-approved) |

Development only: pytest, pluggy, iniconfig (MIT); hypothesis, sortedcontainers (MPL-2.0 and Apache-2.0);
httpx, httpcore, idna (BSD); certifi, pathspec (MPL-2.0); ruff, mypy (MIT); lxml-stubs, types-\*
(Apache-2.0). The Python base image is the official `python:3.13-slim` (PSF-2.0 and Debian licences).
The build stage uses `uv` (Apache-2.0 or MIT); it is not in the final image.
