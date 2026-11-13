# cerea-browser: the browser runtime

ADR 0116, phase 1. A Node/TypeScript MCP server (stdio and Streamable HTTP) over a pinned
`playwright-core`. galopin embeds it (`npm run bundle`) and manages it (`galopin browser`).

Tools (contract: `src/contract.ts`, a copy of Cerea's `src/lib/server/browser/contract.ts`):
`snapshot`, `diff`, `act`, `extract`, `screenshot`, `download`, `open` (a page of its own, no task), plus `end_task`.

```
npm ci
npx playwright-core install chromium
npm test                    # fixture pages on 127.0.0.1 only, a real Chromium
npm run lint                # prettier + tsc
npm run bundle              # writes ../agent/internal/browserrt/ (commit the result)
node scripts/sync-contract.mjs   # re-copy contract, classifier, site rules from Cerea
node src/main.ts --profile /tmp/p --headless          # MCP over stdio
node src/main.ts --profile /tmp/p --http 8765 --token T --key-file KEY
```

Set `CEREA_TEST_NO_SANDBOX=1` for the tests where Chromium's sandbox is unavailable.

Layout: `session.ts` (browser, tabs, the six operations, approval gate), `tree.ts`
(aria JSON to the pruned snapshot, collapsing, size cap), `extract.ts`, `grants.ts`
(signed grants), `server.ts` (MCP), `args.ts` (lenient argument parsing), `sanitize.ts`.
`live.ts` is the live view (phase 2a): CDP screencast (frames go out as `notifications/cerea/frame`
over stdio), the control state (`control`: takeover pauses every agent tool with "paused"), the
user's `input` (mouse, touch, special keys, text) and the headed window's banner (isolated world,
closed shadow root, hidden from snapshots and screenshots). The tools `control`, `screencast` and
`input` are for Cerea's live-view routes, not the sub-agent, and bypass the session's queue.
