# Energy: idle cost of the web UI and galopin

The web UI runs all day in browser tabs and soon in the desktop app; galopin
runs all day on laptops. An idle surface should cost close to nothing: no
timer firing for data nobody is looking at, no animation on a hidden tab, no
request when nothing can have changed.

## Rules

- **No bare `setInterval` for polling in a component.** Use
  `visibleInterval(fn, ms)` (`src/lib/utils/visibleInterval.ts`): it stops while
  `document.hidden` and runs `fn` once, then restarts, when the tab is shown.
  Prefer an existing stream (SSE) over a poll; keep a poll only as the safety
  net behind it.
- **Shared polls are ref-counted** (`useCodeDevicePoll`): one interval however
  many components use it, and it skips hidden tabs.
- **Animations are for something happening.** Loops (`infinite`) only while a
  thing is loading or running; `prefers-reduced-motion` is handled globally in
  `src/styles/tokens.css` and again beside any `animation:` in a component.
- **galopin**: nothing ticks faster than needed. The link's ping (20 s) and its
  wake detector (5 s) are the protocol's and stay; everything else is
  event-driven or at least 5 s. A terminal held back by flow control waits on a
  channel (`wakeCh`), not a 20 ms timer.

## Measuring

Both specs are inert unless `ENERGY=1`, and write one JSON line per run to
`$ENERGY_OUT` (default `/var/tmp/energy-tmp/results.jsonl`).

```bash
export TMPDIR=/var/tmp/energy-tmp && mkdir -p $TMPDIR
NODE_OPTIONS=--max-old-space-size=10000 npm run build        # once, heavy
ENERGY=1 ENERGY_LABEL=mine E2E_SKIP_BUILD=1 \
  npx playwright test tests/energy-idle.spec.ts --project=chromium      # 8 runs x 120 s
ENERGY=1 ENERGY_LABEL=mine E2E_SKIP_BUILD=1 \
  npx playwright test tests/energy-galopin.spec.ts --project=chromium   # 5 min
```

`ENERGY_SECONDS`, `ENERGY_SURFACES=new-chat,agents` and `GALOPIN_SECONDS` narrow a run.

- **Web** (`energy-idle.spec.ts`): new chat, a chat with 60 turns, the Agents
  panel (computer online, a running agent), settings; each visible and hidden.
  Per minute: main-thread task and script time (CDP `Performance.getMetrics`),
  layouts, style recalcs, network requests, and timer / animation-frame
  callbacks fired (counted by wrapping `setTimeout`, `setInterval`,
  `requestAnimationFrame`). "Hidden" overrides `document.hidden` and fires
  `visibilitychange`, so it measures what the app does when told it is hidden;
  a real hidden tab is also throttled by the browser.
- **galopin** (`energy-galopin.spec.ts`): the real binary, paired, with its
  opencode child, nothing happening. CPU time and context switches (wakeups)
  per minute from `/proc`, per process.

Read the biggest numbers first; compare against a run on `main`.

## Left on purpose

- Link ping (20 s) and wake detector tick (5 s): the protocol's liveness.
- The agent stream's server-side 1 s heartbeat check: it only sends after
  `HEARTBEAT_AFTER_MS` of silence, and runs on the server.
- Terminal drag-scroll timers and the stick-to-bottom animation frame: only
  while the user is dragging or the transcript is scrolling.
