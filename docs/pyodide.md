# Python in the browser

!!! info "For everyone"

    What the in-browser Python sandbox does and its limits; the last section is for operators.

Cerea runs Python **in your browser**, not on the server, using
[Pyodide](https://github.com/pyodide/pyodide) (CPython compiled to
WebAssembly) inside a Web Worker. You ask; the assistant writes the code; the
code runs on your device and its output appears under it. A Python block in an
answer runs by itself when the answer finishes, and on deployments that allow
it the assistant can also run code while it answers and use the result. Nothing
runs on the deployment, and the files the code opens never leave your browser.

## What you can do

- **Ask for calculations and analysis.** The assistant's code can use `numpy`,
  `pandas` and the rest of Pyodide's scientific set, plus the office libraries
  (`python-docx`, `openpyxl`, `pypdf`, `python-pptx`, `XlsxWriter`).
- **Ask about your files.** Attach a file, or use a knowledge base, and the
  code can read it (it sees it under `/mnt/data/<filename>`). A knowledge-base
  document arrives as its indexed text, not the original file; an attachment
  arrives as the original, see [Files you attach](#files-you-attach).
- **Ask for a file back.** "Give me this as an Excel sheet", "make a Word
  report": the file appears under the answer with **Download** and, where the
  type allows, a preview (text, images, PDF, Word). When a file is what you
  asked for, the file is the answer and the code folds away behind a
  disclosure. A run lists only the files it **created or changed**. Every
  listed file is kept with the conversation for 30 days and shows up as an
  [artifact](artifacts.md).
- **Ask for charts.** See [Charts](#charts) below.

## Files you attach

The first time code runs in a chat conversation, the files attached to its
messages are put in the sandbox, and any attached later are added before the
next run. Each one is at `/mnt/data/<its original name>` with its original
bytes, so `pd.read_excel("/mnt/data/sales.xlsx")` works even when the
assistant could not read the file's text. When the app extracted text from it
(a PDF, a Word file), that text is beside it as `<name>.md`. They show as chips
under the conversation, like knowledge files.

- **When the assistant can run code**, the text it sees for an attachment starts
  with one line saying where the original is: "The original file is available
  to code at `/mnt/data/<name>`." Without the code tool the line is left out.
- **Same name twice** (two `report.pdf`): the second is `report (2).pdf`, and
  the assistant is told that name.
- **Size caps**: a file over 20 MB is not mounted, and once 100 MB is mounted
  the rest are not. A chip says which file was left out and why.
- **Not mounted**: page images of scanned PDFs, pasted text, and anything in
  shared or read-only views or the [code panel](code-panel.md),
  which has its own machine.
- **Switching conversations** takes that conversation's files out of the
  sandbox, so one chat's files are never visible from another. Knowledge files
  you mounted yourself stay.

## Charts

Ask for a chart ("plot monthly sales as bars", "fammi un grafico delle vendite
per mese") and it appears under the answer as an image, with a card to download
it or open it in the panel. Charts are named `figure-1.png`, `figure-2.png`, …
in the order that run drew them. The count restarts every run, so when you ask
for a change and the assistant redraws, the new `figure-1.png` becomes the next
version of the same artifact, not a new one.

- **Want a real name?** Ask for it: "save the chart as `vendite-2026.png`". The
  chart then appears once, under that name, and not also as `figure-1.png`.
- **At most 20 charts per run.** Ask for one chart per row of a big table and
  the first 20 appear; the run's output says the rest were dropped. Ask for a
  combined chart, or for them in batches.
- **No chart appeared?** The automatic capture could not start in that run,
  though the code still ran. Ask the assistant to save the chart to a file,
  which does not depend on the capture.
- **Building on an earlier chart** ("add last year's line to that chart"): the
  assistant can reopen an earlier run's image, because earlier files stay in
  the sandbox's working folder. A run only shows the files it creates or
  changes, so the old chart is not shown again.

!!! note "If you write the cell yourself, or ask the model how it saves figures"

    - No `savefig` needed: `plt.show()` is replaced by "save every open figure
      as `figure-<n>.png` in the working directory (`/home/pyodide`), then
      close it". Any figure still open when the run ends, even one that failed
      part-way, is saved the same way.
    - A figure the code saves itself with `savefig` is left out of that sweep.
      Its own file is its card, so the image is never shown twice.
    - Past 20 figures, later ones are discarded with a note on stderr.
    - Code that mentions `matplotlib`, `pylab` or `seaborn` gets matplotlib
      imported before it runs, on the non-interactive Agg backend.
    - An earlier run's `figure-<n>.png` can be read back from the working
      directory.

## Limits

|           |                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Time      | 20 seconds per run. A longer run is stopped and the sandbox restarts; ask for the work in smaller steps, or on a sample of the data |
| Output    | 8,000 characters per stream (stdout, stderr)                                                                                        |
| Files     | 50 MB per file loaded into a run; chat attachments 20 MB each and 100 MB together                                                   |
| Memory    | the WebAssembly heap; running out raises `MemoryError`                                                                              |
| Network   | none: no `fetch`, sockets, WebSockets or storage APIs, including through `pyfetch`, `micropip` or the `js` bridge                   |
| First run | loads the runtime (about 12 MB) once; later runs start immediately                                                                  |
| Listing   | at most 200 files listed per run                                                                                                    |
| Figures   | at most 20 per run                                                                                                                  |
| Retention | files a run produced are kept 30 days                                                                                               |

## Installing more packages

**You never need to ask for an install.** The assistant's imports are resolved
before the code runs: Pyodide's own packages and the office libraries the
deployment ships load by themselves. If the answer shows `ModuleNotFoundError`,
the package isn't available here. For a **pure-Python** package from the public
PyPI index, you can turn on **install packages from PyPI** in your settings (off
by default; it sends no credentials), then ask again. Packages with compiled
code that Pyodide does not ship cannot be installed.

## What rendered artifacts can do

HTML artifacts are previewed in sandboxed frames with no access to cookies,
storage or the page, and a content security policy that blocks network
requests, form submission, and remote images or media (`connect-src 'none'`,
`form-action 'none'`, `img-src data: blob:`). Only the libraries the preview
itself loads (Tailwind, React, Mermaid) come from their CDNs. A document in a
knowledge base therefore cannot turn an artifact into a way to send data out.

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
- **Imports.** Before a run, Cerea scans its imports: packages in Pyodide's own
  set load automatically, and the office libraries the deployment ships
  (`python-docx`, `python-pptx`, `openpyxl`, `pypdf`) are installed on the spot,
  so `from docx import Document` works with no `micropip.install`. It is best
  effort: an import it cannot resolve raises its ordinary `ModuleNotFoundError`,
  and a package is installed once per interpreter. `micropip.install(...)` works
  for everything shipped with the deployment.
- **PyPI access.** Operators can force the per-person PyPI setting off for
  everyone with `CHAT_PYODIDE_PYPI_DISABLED=true`.
- One residual path, for the record: code in the worker can start a dynamic
  `import()` of a remote URL. That is a one-way signal: no cookies travel, and
  nothing can be read back.
