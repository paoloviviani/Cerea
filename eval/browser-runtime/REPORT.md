# Browser runtime evaluation (ADR 0116 s7): INCOMPLETE, model runs blocked

Status: the architectural questions are answered and verified in code (`probe.mjs`, no LLM needed). The
**model-driven results table is empty**: every chat call to `https://api.cortecs.ai/v1/chat/completions` with the key in
`/home/ubuntu/.config/cerea-secrets/cortecs.key` returned `401 Unauthorized` (the JWT is well-formed and not expired,
so it was most likely revoked or rotated; `/v1/models` is public and worked). The directory also holds a newer
`cortecs-2026-11-05.key`; I did not use it because the brief named only `cortecs.key`. Once a working key is confirmed, run
`CORTECS_KEY_FILE=<path> node run.mjs both <models> ` (see "Re-running"); results land in `results/runs.jsonl`.

## Results table (model runs)

| engine | model | task | success | steps | prompt tok | completion tok | wall | failure |
|---|---|---|---|---|---|---|---|---|
| playwright, stagehand | qwen3-235b-a22b-instruct-2507 | form | not run | 0 | 0 | 0 | 1.3 s | LLM 401 (both engines) |
| all other engine x task x model combinations | | | not run | | | | | key rejected |

Models chosen from `/v1/models` (prices EUR per M tokens in/out), to run once the key works:
- capable non-vision: `qwen3-235b-a22b-instruct-2507` (0.18/0.54; non-reasoning, so tokens stay predictable);
- vision-capable: `claude-haiku-5.5` (0.10/0.51; Playwright engine run with `--shot`, Stagehand with `--shot` passing images through `generate`);
- small cheap: `ministral-8b-2512` (0.16/0.16).
Expected spend for 5 tasks x 3 models x 2 engines: well under 2 EUR.

Offline numbers that do not need a model:
- Playwright AI snapshot of the 200-row table: 44,179 chars, about 12.6k tokens (no row collapsing), so the ADR's "collapse repetition" feature is needed in our runtime, not provided by Playwright.
- Playwright AI snapshot of the 5-field form: about 25 lines (roughly 300 tokens).
- Stagehand `page.snapshot()` of the same form: 5.2k chars JSON (tree plus xpath and url maps); its internal hybrid tree prompt is larger and uglier (`[0-4] textbox: Full name` ids, LabelText/LineBreak/StaticText nodes).

## Answers (verified in code)

**1. Intercept every action before it runs (classify read/input/commit, hold for approval)?**
- Playwright snapshot core: yes, trivially. We own the loop: the model emits `{kind, ref}`, we resolve `page.getByRef(ref)`, read element metadata (tag, type, inForm, href, name) with `locator.evaluate`, classify (`src/classify.mjs`), and only then call click/fill. `probe.mjs` shows: fill -> `input` -> RUN; submit button click -> `commit` -> HELD; navigate to another origin -> `commit` -> HELD; same-origin navigate -> `read` -> RUN. Unknown element fails closed to commit. If instead we put Playwright MCP in the middle, the interception point is the MCP tool call (`browser_click {ref, element}`), which carries no form/href metadata, so our own runtime must do the lookup.
- Stagehand 4.4: **only by not using `act()`**. `ActOptionsSchema` has `model, variables, timeout, locator, ignoreLocators, cache` and no before-action hook; the LLM planning and execution both happen inside the extension runtime, and `act()` returns the executed `actions` after the fact. The usable path is `observe()`, which returns `{selector (xpath), method, arguments}` without executing (verified with a mock LLM in `probe.mjs`), then we classify and execute with Stagehand's `Locator` (`click, fill, type, selectOption, ...`) ourselves. That works, but then Stagehand is a "find the element" function costing one extra LLM call per step, and `observe` hands back an xpath, not a ref with role metadata, so classification needs another lookup. Note `act("click submit")` could silently submit a form: it fails the hard requirement as a default.

**2. Non-vision models?**
- Both work in principle. Playwright: text snapshot only; screenshots are optional. Stagehand: its observe/act prompts are text-only (confirmed from the captured `generate` params: only text blocks; `extract` can add a screenshot only with `screenshot: true`). Actual model-quality evidence is missing (key blocked).

**3. Stable refs and cheap diffs?**
- Playwright: refs (`e5`) are bound to the DOM element, not to a position. Verified: after a fill, unchanged elements kept their refs; after inserting a node at the top of the page, the Save button kept `f5e14` and the new link got a fresh ref. Refs are **reset on navigation** (0 of 55 shared between `/list?page=1` and `?page=2`, and a reload adds a frame prefix such as `f5e14`), which is acceptable for ADR's "full snapshot after navigation". `snapDiff()` in `engine-pw.mjs` keyed by ref gives added/removed lines in O(n) text diffing; weakness: the focus marker `[active]` makes a parent line "changed", which should be stripped. Playwright 1.66 has no built-in incremental/diff mode in `ariaSnapshot` (not found in the package).
- Stagehand: ids like `0-5` are CDP backend node ids, stable within a document, but results are xpaths and the API exposes no diff; we would diff `page.snapshot().formattedTree` ourselves.

**4. CDP for screencast and takeover?**
- Playwright: yes. `context.newCDPSession(page)` gave `Page.startScreencast` frames (2 frames in 0.8 s on a static page) and `Input.dispatchMouseEvent`; or launch with `--remote-debugging-port` and attach several clients.
- Stagehand: yes. It launches its own Chrome with `--remote-debugging-port` and exposes `browser.cdpUrl` (`http://127.0.0.1:<port>`), and also supports connecting to an existing CDP endpoint, with `userDataDir` for persistent profiles. We could attach a second CDP client (or Playwright `connectOverCDP`) for screencast and input. Caveat: it needs a real Chrome/Chromium with extension support (it injects a "Stagehand Runtime" extension, started with `--enable-unsafe-extension-debugging`); `chrome-headless-shell` will not do, and as root or in containers it needs `chromiumSandbox: false` (`--no-sandbox`).

**5. Licence and weight?**
- Stagehand `@browserbasehq/stagehand` 4.4.0: MIT; node_modules total 62 MB with playwright (Stagehand's own part 15 MB; extension zip 0.56 MB; deps `@browserbasehq/sdk`, `@opentelemetry/api`+`core`, `zod`). **No analytics found**; telemetry is opt-in OTLP tracing (`telemetry.traces.endpoint`), off unless configured. Cloud features (server-side caching, Model Gateway) activate only with a Browserbase `apiKey` and browser session. v4 is a different architecture from the v3 library people know (v3 ran in-process with the AI SDK): the logic now lives in a bundled extension plus a JSON-RPC protocol that is version-locked between SDK and extension (`StagehandRuntimeIncompatibleError`).
- Playwright `playwright` + `playwright-core` 1.66.0-alpha: Apache-2.0; about 20 MB installed (`playwright-core` 14 MB), no dependencies of weight; no telemetry. `@playwright/mcp` 0.0.85: Apache-2.0, 120 KB, depends only on Playwright. Note the AI-snapshot API (`ariaSnapshot({mode:'ai'})`, `getByRef`) is in the 1.66 alpha line; pin the exact version.

**6. Stagehand action caching and replay, fit for phase 3?**
- In 4.4.0 caching is `cache` on create/act/observe/extract, but the code says it is **server-side and "Requires client Browserbase transport and a browser sessionId"** (cache.get/cache.set go to the Browserbase API); there is no local `cacheDir`, no local replay. So it is unusable for a self-hosted, privacy-routed setup. What does fit phase 3: `observe()` returns serialisable `{selector, method, arguments}`, so we can store a successful action list ourselves and replay via `Locator`, which is the same thing we would build on Playwright (record `{role, name, kind}` per step, re-resolve by ref/role at replay, fall back to the LLM on a miss). Stagehand adds nothing we need here.

## Recommendation (provisional: based on the hard requirement and code, not on model accuracy numbers)

**Choose the Playwright AI snapshot core**, wrapped in our own runtime and MCP protocol (ADR 0116 s2 as written).
Reasons:
1. The ADR's hard requirement (intercept every action before it runs) is native to it and impossible by default with Stagehand `act()`; with Stagehand we would reduce it to `observe()` only.
2. We need our own snapshot/diff/ref/classification metadata and collapse of repeated rows anyway; Stagehand's tree and xpath results do not give that.
3. Stagehand v4's caching is Browserbase-cloud only, which contradicts the self-hosted model; its v4 runtime is an extension with a version-locked protocol and needs a real Chrome with extension support.
4. Lightest footprint: Apache-2.0, no telemetry, about 20 MB, one process, direct CDP.

Risks of the choice:
- The AI snapshot/`getByRef` API is new (1.66 alpha); pin the version and expect churn.
- No built-in diff, collapse of long tables (12.6k tokens for 200 rows) or `extract(schema)`; we must write them (the ADR already plans this). `extract` is one extra LLM call over a pruned snapshot.
- Refs reset on navigation; the sub-agent must not carry refs across pages.
- Weak models may mis-pick refs; not measured here. **Not verified: success rates, token-per-step, latency, injection resistance of any model on either engine.** Those need the model runs below.

## Re-running (once a key is confirmed)

```
cd eval/browser-runtime && export PATH=$HOME/.local/opt/node/bin:$PATH TMPDIR=/var/tmp/browser-eval-tmp
npm ci   # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; Chromium at ~/.cache/ms-playwright/chromium-1254 (override CHROMIUM_PATH)
CORTECS_KEY_FILE=/home/ubuntu/.config/cerea-secrets/<file> node run.mjs both qwen3-235b-a22b-instruct-2507,ministral-8b-2512
CORTECS_KEY_FILE=... node run.mjs pw claude-haiku-5.5 --shot      # vision variant
CORTECS_KEY_FILE=... node run.mjs pw qwen3-235b-a22b-instruct-2507 --diff   # diff-mode tokens
node probe.mjs                      # LLM-free architecture checks
```
Harness: `src/fixtures.mjs` (5 local pages plus server-side state for success checks, including a hit counter on `/evil` for the injection task), `src/tasks.mjs`, `src/engine-pw.mjs` (loop with `classify` and an `approve` hook), `src/engine-sh.mjs` (Stagehand with a ClientLLM adapter and a planner loop; no `agent()` exists in v4), `src/llm.mjs` (usage metering; key from file, never logged), `run.mjs`. The model loops themselves were smoke-tested only as far as the 401 (untested beyond that, treat as unproven).
Note: `/opt/pw-browsers` does not exist on this box; Chromium 158 lives in `~/.cache/ms-playwright/chromium-1254`.
