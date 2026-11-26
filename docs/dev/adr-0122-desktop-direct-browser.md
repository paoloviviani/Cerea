# ADR 0122 (draft): the chat in the desktop app drives its own embedded browser directly, with no galopin

- Status: **proposed**, to be moved to `ai-stack/docs/adr/0122-desktop-direct-browser.md` by the owner, like
  `adr-mcp-apps.md`. Owner decision 2026-11-26: option B (direct link), the galopin path stays unchanged.
- Builds on ADR 0116 (browser use: the `browse` tool, the runtime contract, approvals), ADR 0117 (the desktop app, its
  CDP bridge and browser panel) and ADR 0121's single-replica rule for in-process links.

## Context

Today the chat's `browse` tool reaches a browser only through a **paired computer**: the server calls the
`cerea-browser` MCP server that galopin runs there. In the desktop app galopin starts that runtime with
`--connect-file` pointing at the app's CDP bridge, so the runtime drives the app's embedded panel. With galopin
stopped or the computer unpaired, the chat has no browser, even inside the app that has one.

The user is looking at the chat in that very window. Going through the server, a relay and a daemon to reach a browser
next to the page is a long way round, and it fails whenever any of the links is not there.

## Decision

The app runs the runtime itself and the chat page relays between it and the server. The galopin path is unchanged and
stays the way to browse on other computers, for agents, and when the app is not the client.

```
Cerea server --WebSocket (/api/v2/browser/window)-- Cerea page (in the app's Cerea view)
                                                       | window.cereaDesktop.browser (preload, IPC)
                                                   app main process (windowBrowser.ts)
                                                       | MCP over stdio
                                                   cerea-browser --connect-file--> CDP bridge --> the panel
```

### 1. The app runs the runtime

- The app ships the runtime: the very bundle galopin embeds (`agent/internal/browserrt/cerea-browser.mjs`), staged by
  `desktop/scripts/stage-runtime.mjs` with the one dependency it leaves external (`playwright-core`, at the version
  galopin installs; the script refuses a mismatch), next to the Node the app already ships.
- One `WindowBrowser` per profile (`desktop/src/main/windowBrowser.ts`) spawns `cerea-browser --connect-file <the
profile's bridge endpoint file> --key-file <own key file> --state-dir <own dir>` and speaks MCP over stdio. The child gets a minimal environment
  (PATH, HOME, locale and temp variables; no inherited secrets, no `NODE_OPTIONS`, proxy or loader variables). A runtime
  that never ends a line overflows the stdio buffer: it is killed and every waiting call fails at once. It starts
  when that profile's Cerea view loads and stops on a switch, a removal or quit. It uses the **same per-profile endpoint
  and secret** as galopin's runtime (the bridge is unchanged), so only the active profile's runtime is served.
- An unpackaged run uses `browser-runtime/src/main.ts` and the `node` on `PATH`; a packaged app runs only what it ships.
- It does not touch galopin, `mcp.json` or the connector list.

### 2. Page and app: a narrow preload API

- The Cerea view gets one preload (`desktop/src/preload/cerea.ts`). It exposes **only**
  `window.cereaDesktop.browser = { available, send(json), onMessage(cb) }`, and only when the document is the **main
  frame**, its origin equals the profile's server origin and its path is under the profile's base path (passed as
  `--cerea-origin=` and `--cerea-base=`). The identity provider's page, other origins, other paths on the origin and
  every subframe get nothing. The browser panel's pages, the local UI and every other view have no
  such preload.
- `available` means the app can run a browser for this page: a runtime is shipped and the bridge is up.
- `send` takes one JSON string up to 256 KiB. The main process checks the sender **on every message** (`fromCereaPage`):
  the web contents is the active profile's Cerea view, the frame is its main frame, the frame's URL origin equals the
  profile's server origin, its path is under the base path, and the profile is the active one. Anything else is dropped without an answer.
- The main process parses what the page sends and relays only `tools/call` for the runtime's own tool names
  (`RUNTIME_TOOLS`, kept equal to the contract by a test) and the page's one announcement, `cerea/window {windowId}`: **no cookie field, and the page never names a cookie**.
  Every other method, tool name or shape is refused with an error to that call id. Rate limits (40 calls in 10 s; 5
  announcements a minute, in the app's main process), at most 8 calls in flight, answers capped at 20 MiB, and only
  `content`, `structuredContent` and `isError` of a result cross.
- Messages to the page go to the Cerea view's main frame only, and only while it shows the server's origin.

### 3. Server and page: the window socket

- `POST /api/v2/browser/window/ticket {windowId}` (the ordinary hooks: session, content-type rule, `CHAT_BROWSER_ENABLED`)
  mints a single-use, 30-second ticket bound to the user, the session, the window id and the window's grant key (§4).
  The page asks for one only when `cereaDesktop.browser.available`, with a random window id it made at load. The answer
  is `{ticket}` and nothing else: no cookie name, no value, no key. At most ten tickets a minute per user.
- `GET /api/v2/browser/window` is a WebSocket upgrade below SvelteKit like the machine link and the terminal
  (`browser/windowChannel.ts`, dispatched from `registerMachineUpgrade`). The ticket is **not in the URL** (proxies log
  URLs): the page opens the socket with the subprotocols `cerea-window.v1` and `ticket.<t>`, and only the first is
  echoed. It checks the switch, the `Origin` header against `PUBLIC_ORIGIN` **before** the ticket is spent (cross-site
  WebSocket hijacking), the ticket (single use), that the user has a free window slot, and that the session exists;
  the session is checked again every minute and the socket closes 4403 when it is gone, or when three checks in a row
  failed (a blip is forgiven, a database that cannot answer is not trusted).
- **`PUBLIC_ORIGIN` is required for this socket.** It is the one origin the deployment answers as; with it unset (or not
  a URL) the upgrade is refused 403 for every request, so the feature fails closed and the chat uses computers. The kit
  always sets it; the configuration page lists it, and a deployment outside the kit must set it.
- **Limits**, per window and per user, in `windowRegistry.ts`: an answer to an id the server never issued is an
  offence, like malformed JSON (five close the socket 4400; a few late answers to calls that timed out or were
  aborted are allowed); at most 50 messages per 10 s and 96 MiB per minute, past which the socket closes 4429; at most
  4 live windows per user (a reconnecting window replaces its own); image blocks only of `image/png`, `image/jpeg`,
  `image/webp` and `image/gif`, anything else refuses the message.
- The page opens it, then relays text between the socket and the bridge without reading it. It sends the window id with
  each generation request (`windowId` in the request's data, validated by pattern) only while the socket is open.
- **In memory, one replica**, like the machine link: the registry (`browser/windowRegistry.ts`) is a `Map` in the process
  that holds the socket. With `CHAT_REPLICAS` above 1 a turn that carries a `windowId` this process does not hold
  **refuses** with a plain message ("connected to another server instance, try again") instead of quietly browsing on
  a computer the user did not choose; with one replica a vanished window falls back to computers as before. The kit
  documents the single-replica limit next to `CHAT_REPLICAS`, as for the other in-process links.
- Wire: MCP JSON-RPC 2.0. Down, `tools/call` for the contract's tools only. Up, responses only. No secret crosses it.
  Anything else is an offence; five close the socket 4400. Binary frames close it. A window with the same id that
  connects again replaces the old link (4409).

### 4. Target selection in `browse`

- A new target, **this window**, beside **a computer**. A turn that carries a `windowId` naming this user's live window
  on this session (`windowForTurn`) browses in that window by default, whatever computers are ready, the conversation's
  remembered computer or the user's default. A scheduled run never has a window.
- A computer wins only if the model's `machine` hint is the exact name of a ready computer **and** the user's latest
  message names it as a whole word (the same test the computer choice applies to a hint): the user's words decide.
- Otherwise today's computer selection runs unchanged. `browse` is offered when there is a window or a ready computer.
- The card says where: "Runs in this app's browser" or "Runs on <computer>" (`MessageBrowseUpdate.where`, en and it).
- Lease, approvals, action classification, `control` ("You are driving"), the loop and its budgets work as for
  computers. The server-side gate (`classifier.ts`, `policy.ts`, `approvals.ts`) is unchanged. Two adaptations:
  - **every grant on a window is single use.** Grants cross the page, so a captured one must not be replayable for its
    10 minutes: the loop issues a site rule's grant as `siteonce:<host>:<uuid>` (the runtime spends any id that does not
    start with `site:`), and an approval card's grant is spent by the runtime as always. On a computer a `site:` grant
    stays standing, as before;
  - the **grant key** of a window is `HMAC-SHA256(session secret, "cerea-window-grant-key|" + windowId)`. The session
    secret is the value of the session cookie, which is `HttpOnly`: the server reads it from the ticket request, the
    app's main process reads it from the Cerea view's cookie jar, and **the page cannot**. Each side derives the key
    itself (one shared test vector keeps the two functions equal); it is never sent anywhere. **Which cookie is the
    server's word, not the page's:** the cookie's name (`COOKIE_NAME`, a public setting) is published in the server's
    `enroll.json` as `sessionCookie`, read by the app when the profile is added (or once, for a profile saved before) and
    kept with the profile. The page sends no name and the ticket answer carries none. The app reads that cookie at the
    profile's base-path URL (so `Path=/chat` is found) and writes a key **only when exactly one cookie of that name is
    visible, it is `HttpOnly`, on an https server `Secure`, and the server's own: host-only (no `Domain=`), its domain
    the server's host and its path `/`**. A cookie that script on the page could have set is none of these; neither is
    one a sibling host under the same registrable domain plants with `Domain=example.com` (after `/logout` deleted the
    real one), nor one on another path; and a second cookie of the same name means no key. Deployments should name the
    cookie with a `__Host-` prefix (`COOKIE_NAME`, see the configuration page; the default name is unchanged), which
    makes browsers refuse such planted cookies outright. In every other case an old key is removed. The app writes the
    key 0600 to the profile's own key file (removed when the runtime starts and stops) and the runtime reads it at each
    check, as it reads a computer's key. Only the latest `cerea/window` announcement can write the key (a generation
    counter), and nothing is written after the profile's browser is disposed. With no key the runtime accepts no
    approval;
  - the **lease** and the **kept page** are in memory and live with the link (one task per window). A window that
    reconnects starts free. A lease lapses after 5 minutes without a call or answer on the window; the loop's
    keep-alive (every 2 minutes, which refreshes the lease without a message on the wire) holds a live task's, an
    approval wait included, and the lease's `check()` is true only for the holder, so a task whose lease did lapse and
    was taken stops with `lease_lost` instead of acting in the other task's page after its approval.

### 5. Lifecycle and UX

- The panel opens when a task starts, through the same hook a galopin runtime task uses (#377): the app's first call of
  a task is a sign of life on `Control` (`control.touch()`), which opens the panel on the Browser tab and drives the
  "Browser working" indicator. The runtime goes through the same bridge, so #377's focus rules (no focus for hidden
  pages, `Page.bringToFront` refused while the panel is hidden) apply to it unchanged; the smoke test checks it.
- A profile switch, a removed profile or a closed window drops the socket. The registry rejects every waiting call with
  a plain reason, the task ends ("the app's window was closed, or the app switched to another server, so its browser is
  gone") and the lease goes with the link.
- One driver at a time per panel: the bridge replaces an older, idle runtime connection with a newer one, but **refuses**
  a newcomer while the current one has sent a command in the last 30 s ("Another task is using this browser.", shown on
  the card as the `busy` stop, en and it; it is said only when the refused runtime was the app's own: the window
  runtime connects with its own secret on the same bridge, `cdp-endpoint-window`, so a refusal is known to be its). A galopin task and a window task on the same panel at once therefore do not
  cut each other off: the one that started first keeps the panel. The app's own first-call sign of life (it opens the
  panel) is not a command and never makes its own runtime a newcomer to refuse. Coordinating beyond that is §7.

### 6. Security

Everything from the page and from the app is untrusted on the server, and the page is untrusted in the app:

- **Server side.** An answer is parsed against a strict JSON-RPC shape (one of `result` and `error`, content blocks of
  `text` and `image` only, size caps) and then by the contract's own schemas in `runtimeClient.ts`, like a computer's.
  The server sends only `RUNTIME_TOOLS`. The ticket, the origin check, the session re-check and the per-user registry key
  mean a window can only ever be the signed-in user's own; the limits of §3 bound what a hostile page can cost.
- **App side.** Origin and frame pinning on every IPC message, the method and tool allowlist, size and rate limits,
  and the CDP policy of the bridge (ADR 0117: only the panel's web pages are reachable, never the Cerea view or the UI)
  are unchanged and apply to this runtime too.
- **The residual risk, stated plainly.** Script running on the Cerea origin (an XSS) can call `cereaDesktop.browser.send`
  and drive the panel, which holds the user's signed-in sessions in its own partition. This is the same class of risk as
  the galopin path, where script on the Cerea origin can start a browse turn. What limits it: the origin and frame
  pinning above; the CDP policy; and **approvals**: a commit-class action (paying, sending, deleting, downloading,
  leaving the site) needs a grant signed with the window's key, which script on the page cannot compute because the
  session secret it derives from is `HttpOnly`. So script on the Cerea origin can read pages, navigate and fill fields
  in the panel (read and input class, as on the galopin path) but cannot make the runtime run a commit it was never
  approved for. It also could not sign for the server's own approval flow: the user still answers the card.
- Not done: the app does not read cookies or storage of the panel for the page, and no new capability is given to the
  Cerea view beyond the three-member object.

### 7. Not in this ADR

Coordinating two drivers of one panel, a window browser for agents, the key leaving the page's path, a live view of the
panel in the Cerea page, and Windows.

## Consequences

- The chat in the app can browse with galopin stopped or unpaired. galopin is still needed for agents and other computers.
- The app grows by `playwright-core` (about 10 MB) and runs a Node process per active profile while its view is loaded.
- One more WebSocket path and one more in-process registry; both share the machine link's single-replica rule.
- The window's grant key follows the session secret: if it rotates (a session invalidated and reissued), approvals in an
  open window stop working until the page reconnects (reload). The task then ends with a plain refusal, not a wrong action.
