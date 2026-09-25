# Python in the browser

Cerea runs model-written Python **in your browser**, not on the server, using
[Pyodide](https://github.com/pyodide/pyodide) (CPython compiled to
WebAssembly) inside a Web Worker. Python code blocks and code artifacts run by
themselves when the answer finishes streaming, and their output appears under
the code. Nothing is executed on the deployment, and nothing you load leaves
your browser.

## What you can do

- **Compute and analyse.** The interpreter ships with its standard scientific
  packages (`numpy`, `pandas` and the rest of Pyodide's set), plus the office
  libraries: `python-docx`, `openpyxl`, `pypdf`, `python-pptx`, `XlsxWriter`.
- **Work on your files.** Message attachments and knowledge-base documents can
  be loaded into the run; they appear under `/mnt/data/<filename>`.
  Knowledge-base documents arrive as their indexed text, not the original
  file.
- **Get files back.** Files a run writes to its working directory are listed
  under the output, with a download and a preview where the type allows one
  (text, images, PDF, Word). When you ask for a file, the file is the answer
  and the code folds behind a disclosure.

## Limits

| | |
|---|---|
| Time | 20 seconds per run, then the run is stopped and a fresh interpreter is started |
| Output | 8,000 characters per stream (stdout, stderr) |
| Files | 50 MB per file loaded into a run |
| Memory | the WebAssembly heap; running out raises `MemoryError` |
| Network | none: no `fetch`, sockets, WebSockets or storage APIs, including through `pyfetch`, `micropip` or the `js` bridge |
| First run | loads the runtime (about 12 MB) once; later runs start immediately |

## Installing more packages

`micropip.install(...)` works for everything shipped with the deployment.
Each person can also turn on, in their settings, access to the public PyPI
index for other **pure-Python** packages. It is off by default, and it carries
no credentials. Operators can force it off for everyone with
`CHAT_PYODIDE_PYPI_DISABLED=true`. Compiled packages that Pyodide does not
ship cannot be installed.

## What rendered artifacts can do

HTML artifacts are previewed in sandboxed frames with no access to cookies,
storage or the page, and a content security policy that blocks network
requests, form submission, and remote images or media (`connect-src 'none'`,
`form-action 'none'`, `img-src data: blob:`). Only the libraries the preview
itself loads (Tailwind, React, Mermaid) come from their CDNs. A document in a
knowledge base therefore cannot turn an artifact into a way to send data out.

One residual path, for the record: code in the worker can start a dynamic
`import()` of a remote URL. That is a one-way signal: no cookies travel, and
nothing can be read back.

## For operators and maintainers

- The runtime and the extra wheels are served from the chat's own origin
  (`<base>/pyodide/`), with no CDN. They are generated from the pinned npm
  package and wheel list by `scripts/sync_pyodide.mjs` and
  `scripts/sync_pyodide_wheels.mjs`, which run before `dev` and `build`.
- The wheel filenames are pinned exactly: `micropip` needs a PEP 503 index
  page per package (the sync script writes them), and compiled dependencies
  sit beside `pyodide-lock.json`.
- **Licences:** Pyodide is MPL-2.0 and is served unmodified as static files.
  The vendored wheels are MIT, BSD or PSF; each is listed in
  `static/pyodide/wheels/NOTICE.txt`, and `static/pyodide/NOTICE.txt` carries
  Pyodide's attribution.
