# Desktop app (Electron)

Code: `desktop/`. Status: design plus MVP (draft). The owner's request: an Electron desktop app with
the embedded browser driven by the chat, the same features as the Cerea connector Mac app, and galopin
commands from the GUI (`galopin launch` and the rest). Assumptions the owner confirmed: the Cerea
window is the deployment's own web app with its normal sign-in; the app can replace the Cerea
connector; macOS and Linux first.

## Scope of v1

One window, three parts:

1. **The Cerea window.** A `WebContentsView` that loads the server the user chose and nothing else.
   The web app is unchanged: sign-in is the normal one, the browse approvals and Needs-you bar work
   as in any browser. Nothing special is needed in the web app, so none was changed.
2. **The browser panel.** Tabs in a second kind of `WebContentsView`, with its own session
   (`persist:cerea-browser`), that Cerea's browser use drives. The user watches it, can take over
   and hand back, and can browse in it themselves (sign in to a site once; the logins stay in that
   session, as they do in galopin's own profile today).
3. **The galopin panel.** Pair (the Pair dialog's options), status, start and stop, `launch <tool>`
   in a terminal, `setup <tool>` and `--remove`, upgrade, service install and uninstall (each asks
   for an explicit confirmation in the main process), Set up browser, Edit connectors, output log.

It does everything the Mac connector does today: connectors-only pairing (the default), the
coding-agent option under the same switch, local connectors (`mcp.json` opens in the system
editor, changes are picked up by galopin), browser ready, galopin kept running while the app is
open, start and stop. Not in v1: the embedded terminal (see "Not in v1"), the Mac menu-bar item
(the app has a tray later), Start at login (later; the service button covers it).

### First run: choose the server

Before anything loads the user types their Cerea's address. The main process (never the
renderer) asks the server who it is:

- the address is normalised: https only, `http` for localhost, 127.0.0.1 and ::1 only, no user
  name or password, query and fragment dropped, a base path such as `/chat` kept;
- `GET <address>/galopin/enroll.json` must answer 200 with `issuer` and `clientId` (the public
  facts galopin's own `enroll --cerea` reads, so it is the same test), no redirect followed, 64 KB
  and 8 s at most; anything else is "did not answer like a Cerea";
- `GET <address>/manifest.webmanifest` gives the name and an icon, shown on a confirmation card
  ("Use this server"). An icon from another origin is never shown. Both are a courtesy.

The origin is stored in `config.json` (userData, 0600) and is re-validated on every start. It is the
only origin the Cerea window may load (navigation guard below), and pairing uses it: `galopin enroll
--cerea <address>`, so the issuer, gateway and client id are discovered from the server the way the
Pair dialog's line does it, never typed. **Server tab, Switch server**: probe the new address, then
a native confirmation (in the main process, so a compromised renderer cannot skip it): signs the
Cerea window out (its storage is cleared), stops galopin and sets this computer's credentials aside
(`credentials.json.unpaired-<time>`, not deleted), because a pairing belongs to one server. It says
to remove the computer from the old server's Agents panel too, as removing the Mac app does.

## How the chat drives the embedded browser (the core decision)

Today galopin offers `browser-runtime` (a Node MCP server over `playwright-core`) as the local
connector `cerea-browser`; the runtime launches its own Chromium with a persistent profile, and
approvals are grants signed with a per-machine key. The question is how the runtime reaches the
app's browser.

### Options

**(a) Chromium's own debugging endpoint.** `--remote-debugging-port` or `--remote-debugging-pipe`,
and `connectOverCDP`. Rejected, with evidence: CDP has no authentication, and the endpoint is the
whole app. Measured on the prototype app started with `--remote-debugging-port=9333`:
`GET /json/list` answered, with no credentials, a list holding **both the Cerea window
(`http://127.0.0.1:…/`) and the local UI (`file:///…/renderer/`)**. Anything that reaches the port
(another OS user, any local process, a web page by DNS rebinding or a WebSocket from a page) drives
the signed-in Cerea window. A filtering proxy in front does not help while the raw port is open
beside it, and a pipe still exposes every target to its holder with no way to filter inside
Chromium. This option cannot meet the requirement.

**(b) Operations in the main process over `webContents.debugger`.** Safe by construction (the
debugger is attached to the panel's pages only) but the runtime's operations (2200 lines of
Playwright API: aria snapshot, locators, routes, downloads, popups) would have to be rewritten
over raw CDP and kept in step with the contract. Rejected as the primary path.

**(c) Chosen: a CDP bridge in the main process, a Unix socket, and the unchanged runtime.** The app
answers the small browser-level part of CDP that Playwright needs (one browser, one context,
these pages) itself and forwards page-level commands to the panel's pages through
`webContents.debugger`. The runtime gets a new mode, `--connect-file PATH`, that calls
`chromium.connectOverCDP` instead of `launchPersistentContext`. Everything else in the runtime
(the six operations, the classifier, signed grants, tabs, downloads) is untouched.

```
Cerea (server) -- galopin run -- mcp.json "cerea-browser" -- node cerea-browser.mjs --connect-file <run>/cdp-endpoint
                                                                |  ws+unix://<run>/cdp.sock:/cdp/<secret>
                                                                v
  Electron main:  bridgeServer (0600 socket, secret path, no Origin) -> CdpBridge (fake browser) -> Control (take over gate)
                                                                -> BrowserPanel.targets() = the panel's pages ONLY
                                                                -> webContents.debugger  (no other webContents is ever attached)
```

Why this meets the requirement:

- **No TCP port at all.** The socket is mode 0600 in a 0700 directory (`<userData>/run`, or a
  per-user temp directory when the path is too long for `sun_path`). Another OS user cannot open
  it, a web page cannot reach it (no TCP, and a request carrying an `Origin` header is refused).
- **A secret per start.** The path carries 256 random bits made at each app start. The endpoint
  (socket and secret) is written to `cdp-endpoint`, 0600, and the runtime reads that file at every
  connect, so the connector entry in `mcp.json` is static and survives restarts. Another process
  of the same user could read the file, which is the same boundary as galopin's key file and
  profile today; it cannot connect without that.
- **The Cerea window is unreachable, structurally.** `CdpBridge` is constructed with the
  `BrowserPanel` and nothing else. It has no reference to the Cerea view or the local UI. A
  `sessionId` the bridge did not mint is refused; `Target.closeTarget` and `activateTarget` take
  only ids the panel lists; `Target.createBrowserContext` and `disposeBrowserContext` are refused;
  any browser-wide command (`Storage.*`, `SystemInfo.*`, `Network.getAllCookies`) is unknown.
  The smoke test asserts the runtime's tab list never contains the Cerea page.

### What the prototype showed

- Playwright's `connectOverCDP` accepts a `ws+unix://SOCKET:/PATH` endpoint (its `ws` transport
  speaks to a Unix socket), so no port is needed on the runtime side either.
- It needs only these browser-level calls: `Browser.getVersion`, `Target.setAutoAttach` (flatten),
  `Target.getTargetInfo`, `Browser.setDownloadBehavior`, `Target.createTarget`,
  `Target.closeTarget`, `Target.activateTarget`, `Browser.getWindowForTarget`. Page-level
  commands (Page, Runtime, Network, Fetch, Emulation, Input, DOM, Accessibility, child sessions
  for iframes) pass straight through `webContents.debugger.sendCommand(method, params, sessionId)`.
- **Two traps found by running it**, both written into `browserPanel.ts`/`cdpBridge.ts`:
  1. Playwright keys a page's session by the **main frame id** and expects it to equal the target
     id (`_sessionForFrame`). The bridge's target id is therefore `Page.getFrameTree`'s frame id,
     not a made-up one (otherwise: "Frame has been detached").
  2. A new page must start as a committed blank document (a view with no document has no frame
     and CDP commands hang), and its first navigation must happen only after the client sends
     `Runtime.runIfWaitingForDebugger` (Playwright waits for a "first non-initial navigation").
     `Target.createTarget` is answered with `waitingForDebugger: true` and the navigation is
     started on that call, as Chrome does.
- Verified end to end by `desktop/scripts/smoke.mjs`, which starts the real app under Xvfb and
  runs the **real runtime** (`browser-runtime/src/main.ts --connect-file`) over MCP: `open` +
  `resume` + `snapshot` (aria snapshot with refs) + `act` (fill) against browser-runtime's own
  fixture pages, then take over and hand back, then a wrong secret (refused).

### Watch, take over, hand back

The semantics follow ADR 0116's phase-2 note in `session.ts` ("a takeover pauses the protocol
operations"): **while the user drives, the runtime's operations do not run.** In the MVP this is
the `Control` gate in the bridge: in `user` mode every page-level command and `createTarget`
and `closeTarget` is refused at once with "The user has taken over the browser and is using it
themselves. Do nothing until they hand it back." (connection set-up calls still pass, so the
runtime does not break); handing back lets them run, and the runtime looks at the page afresh before
each action. An approval is bound to the page address and element as they were, so nothing
approved earlier can run on a page that moved on.

While the runtime works (a command in the last 4 s), a transparent shield view covers the panel so
a stray click cannot disturb it, and the UI says "Cerea is browsing. Watch, or take over." The
user's own browsing in the panel is never blocked when no task runs.

Not done, and needs an owner decision because it changes the contract: the chat's Browsing card
cannot yet say "you are driving"; the runtime sees a failed action with the message above. A
proper `control` tool in `contract.ts` (and the runtime holding its queue instead of failing)
is the phase-2 follow-up. Live view in the chat (screencast) is not needed by the desktop app: the
user sees the real panel.

## galopin as a bundled sidecar

- **Per-platform binary** at `resources/galopin/galopin` inside the app (electron-builder
  `extraResources`), built from `agent/` at the **same commit** as the app (`npm run galopin:build`;
  CI builds one per target). The app version pins the galopin version; there is no separate
  install. `GALOPIN_BIN` overrides it for development.
- **Same state as the CLI.** It uses galopin's normal config directory (`~/.config/galopin`,
  `~/Library/Application Support/galopin`), so a user with the CLI keeps one pairing. Tests set
  `HOME` and `XDG_CONFIG_HOME` to a temp directory.
- **Supervision.** The app starts `galopin run` when the computer is paired and stops it on quit;
  it restarts it after a stop (backoff), and gives up after three starts that each fail within five
  seconds (a second galopin holding the pairing's lock, say) and shows the output. It never starts
  one when a service is installed: the service buttons stop the app's own first. galopin's
  instance lock stops a second copy in any case.
- **Browser**: Set up browser runs `galopin browser setup --connect-file <endpoint file>` then
  `galopin browser enable`. These are new (agent/browser_cmd.go): `setup --connect-file` installs
  the runtime and its one dependency but **no Chrome or Chromium**, and `enable` registers
  `cerea-browser` with `--connect-file` and no profile, display or sandbox flags. galopin's own
  status says "the Cerea desktop app's browser panel". It still needs Node 22.18+ on the computer
  (the runtime is Node); bundling Node (as the Mac connector does) is the next packaging step.
- **Enrollment UX**: the panel's Pair runs `galopin enroll --cerea <chosen server>` with the Pair
  dialog's options (connectors-only unless "Also let Cerea use coding agents here"); galopin's own
  sign-in opens the system browser or prints the code, shown in the output log. The app never
  passes `--yes`: galopin's confirmations (an issuer on another domain) stay.
- **Updates**: the app's update is galopin's update. `galopin upgrade` (which fetches the
  installer from the paired Cerea) is offered with its own confirmation; with a bundled sidecar the
  right answer later is the app's auto-update, and upgrade hidden.

## Platforms and packaging

- **macOS and Linux first.** galopin has no Windows build. Windows later through WSL (galopin runs
  in the distro, the app talks to it with `wsl.exe`) or a Windows galopin; the bridge would use a
  named pipe instead of a Unix socket (`ws` supports IPC paths). This is a gap, not a plan.
- **electron-builder**, `desktop/electron-builder.yml`: Linux AppImage and deb; macOS zip for arm64
  and x64. Electron is pinned to an exact version (45.3.0, 15 days old when chosen, per the
  two-week rule). Fuses: `runAsNode` off, node options and inspect arguments off, asar integrity
  on, `onlyLoadAppFromAsar`.
- **Signing**: macOS **unsigned and not notarised for now, like the connector app** (no Apple
  account). The same first-open steps apply (docs/agent-machines.md); an install script that
  clears quarantine can follow the connector's. Linux needs none.
- **Auto-update**: later (electron-updater against GitHub releases once the app is signed; an
  unsigned macOS app cannot auto-update).
- **CI**: `.github/workflows/desktop.yml`: lint, unit tests, build, the Xvfb smoke (with a 20 s
  idle measurement), then Linux and macOS packages as run artifacts. Nothing is published and no
  release is touched.

## Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true` on
  every web contents; no `<webview>` (attaching one is refused).
- **Only the local UI has a preload**, exposing `window.cerea.call(channel, arg)` for the 22
  channels in `shared/ipc.ts` and `window.cerea.on` for three events. The Cerea window and the
  browser panel's pages have no preload and no Node: they are web pages.
- **Every IPC argument is validated again in the main process** (`validate()`: closed object
  shapes, enums, no leading dash in anything that becomes a galopin argument, absolute paths, no
  NUL, size limits) and the sender is checked to be the UI's main frame. Replies are plain strings:
  no stack or object crosses. The renderer cannot name a galopin command; it picks from typed
  actions, which `galopinArgs.ts` turns into argument lists (no shell; the one shell hand-off, a
  terminal for `launch`, quotes every piece, tested with hostile paths).
- **Navigation guard** (`navGuard.ts`, tested): the Cerea window loads only the chosen origin
  (scheme, host and port compared as a URL origin; look-alikes fail). A link, `window.open` or
  scripted navigation to another origin opens in the system browser (http, https, mailto only).
  The one exception is sign-in: a server-side **redirect** that starts on the server's origin may
  take the window to the identity provider (https, or loopback http) and between its redirects and
  back, for 10 minutes; a click on that page cannot leave for a third site. The browser panel loads
  http(s) and `about:blank` only (also enforced by the runtime's own routes).
- **Separate sessions**: the Cerea window uses `persist:cerea`, the browser panel
  `persist:cerea-browser`. Cookies and storage are not shared.
- **Permission handlers**: the panel denies every permission request and check; the Cerea window
  allows only clipboard write and notifications.
- **CSP for local UI**: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'
  data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, set on
  every `file://` response. The renderer has no inline script or style and no network.
- **The debugging surface is closed**: no remote-debugging switch is set; the runtime bridge is
  the only door and is described above.
- galopin runs with the user's own privileges, as today; the app adds no new ones.

## Energy

Rules, and where they are applied:

- `backgroundThrottling: true` on every web contents, never disabled. Nothing is `--disable-gpu`
  or high-performance; no `powerPreference` (the integrated GPU is used on a Mac).
- **No polling.** The UI is pushed state on change (galopin start and stop, pairing, tabs, take
  over) and asks once when the window is looked at (`visibilitychange`, `focus`). There is no
  `setInterval` in the main process. The only timers are one-shot: the 4 s "Cerea is browsing"
  decay is computed from a timestamp, and the idle-freeze timer below.
- **Hidden or minimised window**: the UI pauses animation (`body.hidden` and
  `prefers-reduced-motion`); there is no screencast to stop (the panel is a real view). The
  shield view is created only when first needed.
- **Idle panel**: when the window is not visible (or the panel closed) and the runtime has been
  silent for two minutes, the tabs are muted and **frozen** (`Page.setWebLifecycleState frozen`)
  after a grace of 30 s (3 s on battery or under thermal pressure, immediately on sleep or screen
  lock), and thawed as soon as the panel is shown or the runtime sends anything.
- **`powerMonitor`**: `suspend`, `lock-screen`, `on-battery`, `thermal-state-change` (macOS) shorten
  that grace; `resume`, `unlock-screen`, `on-ac` restore it. Nothing else changes: galopin's link
  must stay up for Cerea to reach the computer, so it is not paused.
- **Lazy**: the browser panel has no tab until a task or the user needs one; the shield is created
  on first use; one window, no hidden helper windows; the Cerea view loads only once a server is
  chosen.
- **galopin sidecar**: started only when paired (the user enabled it), never twice. Its own idle
  wake-ups are for the separate audit; the app adds no loop around it.

### Measured (Xvfb, software rendering, Electron 45.3.0, app idle with a Cerea page loaded, no task)

Cumulative CPU of all app processes (`app.getAppMetrics`) over 60 s, as a share of one core:

| State                                       | CPU    |
| ------------------------------------------- | ------ |
| visible, idle                               | 0.12 % |
| hidden (`win.hide()`), idle, after 3 s grace | 0.05 % |

`scripts/smoke.mjs` fails when the hidden figure is 1 % or more (`IDLE_BUDGET_PERCENT`); CI uses a
20 s window. Caveats: Xvfb has no window manager, so "minimised" is `win.hide()`, which takes the
same visibility path; there is no real GPU, display link or battery here, so numbers on a Mac
will differ and should be re-measured; the 30 s freeze grace is longer than the measurement's
settle time, so the figure shows the window-hidden cost without the freeze.

## Not in v1

- **Embedded terminal** (xterm.js with `node-pty`): `launch <tool>` opens the system terminal
  (Terminal.app through AppleScript; on Linux the first of x-terminal-emulator, gnome-terminal,
  konsole, xfce4-terminal, kitty, alacritty, xterm). `node-pty` is a native module per platform
  and Electron ABI; it is a packaging project of its own.
- Tray icon and Start at login, auto-update, Windows, bundled Node (the runtime needs Node 22.18+
  on the computer for now), downloads from the panel into a chat (the bridge implements the
  download events, and no test exercises them yet), file uploads from the panel (the runtime
  refuses file choosers in any case), a `control` tool in the contract (above).
- The installer-less macOS first-open flow and a `curl | sh` installer like the connector's.

## Open questions for the owner

1. Replace the Mac connector (`galopin-tray`) once the desktop app is on a Mac, or keep both for a
   release? The tray's menu has no equivalent of "Start at login" yet.
2. Bundle Node (about 40 MB) so the browser needs nothing installed, as the connector does?
3. A `control` tool in the browse contract and a "You are driving" state on the Browsing card
   (phase 2), so take over is visible to Cerea and the runtime holds its queue.
4. Apple signing and notarisation, and so auto-update: is an Apple developer account coming?
5. The stored Cerea address is the whole base URL (with `/chat`); is asking for it as a
   plain address right for users, or should the app also accept the public origin and find the
   chat (`/galopin/enroll.json` exists only under the base path)?
