# cerea-browser: the browser runtime

ADR 0116, phase 1. A Node/TypeScript MCP server (stdio and Streamable HTTP) over a pinned
`playwright-core`. galopin embeds it (`npm run bundle`) and manages it (`galopin browser`).

Tools (contract: `src/contract.ts`, a copy of Cerea's `src/lib/server/browser/contract.ts`):
`snapshot`, `diff`, `act`, `extract`, `screenshot`, `download`, plus `end_task`.

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
Phase 2 (screencast, input) hooks in through `BrowserSession.withPage`.
