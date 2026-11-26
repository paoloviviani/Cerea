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
open, start and stop, and **Start at login** (Settings, off by default; a macOS login item, a Linux
XDG autostart entry). Not in v1: the embedded terminal (see "Not in v1") and a tray icon.

**The Mac connector (`galopin-tray`) is kept for one release alongside the desktop app, then
retired** (owner, 2026-11-25). The desktop app is the replacement: pairing, browser, connectors,
keep-running and start-at-login are all in it. During the release both can be installed, and the
docs say the desktop app is the one to use; pairing and the browser connector entry are shared
(galopin's own state), so a Mac moving from one to the other keeps its pairing and runs `galopin
browser setup --connect-file ...` once. The release after, the tray, its workflow and its docs are
removed.

### First run: choose the server

Before anything loads the user types the site where they use Cerea, just that (`chat.example.org`).
The main process (never the renderer) finds the Cerea and asks it who it is:

- the input is normalised: https only, `http` for localhost, 127.0.0.1 and ::1 only, no user name
  or password, query and fragment dropped;
- **the chat path is discovered**, not typed: when the user gave a path, only that is tried;
  otherwise, in order, the site root, the first path segment of the root web app manifest's
  `start_url` (same origin only), then `/chat`. The first candidate that passes the next check wins,
  and the error names where it looked. Nothing in the web app had to change: `/galopin/enroll.json`
  and the manifest already exist under the chat's base path;
- `GET <address>/galopin/enroll.json` must answer 200 with `issuer` (https, or loopback http) and
  `clientId`, the public facts galopin's own `enroll --cerea` reads, so it is the same test; no
  redirect is followed, and the body is read with a 64 KB cap;
- `GET <address>/manifest.webmanifest` gives the name and an icon. The icon is fetched in the main
  process (200 only, a raster type, at most 200 KB) and handed to the UI as a `data:` URL, so the UI
  never loads anything from the server. A card shows **what was found** (name, icon and the full
  address, path included) before the user confirms with "Use this server".

The address, origin, identity provider's origin and icon are stored with the profile (below) in
`config.json` (userData, 0600) and re-validated on every start. The origin is the
only origin the Cerea window may load (navigation guard below), and pairing uses it: `galopin enroll
--cerea <address>`, so the issuer, gateway and client id are discovered from the server the way the
Pair dialog's line does it, never typed.

### Server profiles: a work server and a home server

A **profile** is a server (address and discovered chat path, identity provider, icon) with a
display name, its own web sessions and its own galopin pairing. The switcher is a box in the
window's header, a **Profiles** menu (Ctrl or Cmd with Shift and 1 to 9), and the **Profiles** tab,
where profiles are added (the same address check as the first run, showing what was found),
renamed and removed. The window title names the active profile. There is no tray icon yet (v1 has
none), so the menu is the "tray entry" for now.

- **Nothing crosses.** The Cerea window uses `persist:cerea-<id>` and the browser panel
  `persist:panel-<id>`; the ids are 12 random hex characters made by the app, validated wherever
  they are read (config file, IPC, partition and directory names), never taken from user text.
  The smoke test sets cookies in one profile and shows they are in neither session of the other.
- **galopin is enrolled on each server separately; credentials never move between profiles.**
  The first profile (and the single server of the earlier version of this app, which becomes
  profile 1 when the file is read) uses galopin's default configuration directory, so a computer
  already paired with the CLI keeps that pairing and the shims `galopin setup` made keep working.
  Every later profile has `<userData>/profiles/<id>/galopin/` and every command for it gets
  `--creds <that>/credentials.json` (`service install` passes it as a run flag). `galopin setup
TOOL` (not `--desktop`) takes no `--creds`: its shims follow the default pairing, so they belong
  to the first profile.
- **Switching** (one code path, `switchTo`, whose order is tested): stop the active profile's
  galopin and wait for its exit; cut the runtime off (the bridge router closes the old connection
  and refuses new ones) and dispose the old panel (its tabs close); load the other profile (a new
  Cerea view and a new panel on that profile's own sessions, a new bridge behind the router); save;
  start that profile's galopin. Only the active profile's galopin runs, and the bridge only ever
  targets the active profile's panel: a command with an old session id gets "No session" from the
  new bridge (unit test and smoke step).
- **A galopin service follows the active profile**, after a confirmation on switch: it is installed
  again for the new profile (or removed when this computer is not paired there yet). **Start at
  login** is the app's, not a profile's: it opens the app on the profile that was active.
- **Remove** (Profiles tab) asks first, in the main process: the profile's sessions (both) are
  cleared, a profile with its own directory has it deleted, and the default one's credentials are
  set aside (`credentials.json.unpaired-<time>`). The server is not told: this computer's sign-in
  there stays valid until the computer is removed from that server's Agents panel. Removing the
  active profile switches to another first; removing the last leaves the first-run screen.
- **Profile operations run one at a time** (a mutex): a second switch, add or remove waits, and
  each stops whichever galopin is current when it actually runs. The earlier single-server
  config is saved as profile 1 the first time it is read, and its two session directories are
  moved to the profile's own, so the user stays signed in and no partition is orphaned.
- Up to 9 profiles; the same address cannot be added twice.

### The window: the chat, and a side area that is a tool

The Cerea view takes the window; the **side area** at the right (Browser, galopin and Profiles,
three views of one panel) is closed at every start and on the first-run screen, and never overlaps
the chat. One function decides where everything goes (`layout.ts`, tested): with the panel closed the
Cerea view is the whole window under the 40 px header; open, it is exactly `window width - panel
width`, re-laid out on every resize; with no server chosen there is no panel and the first-run screen
has the whole window (it scrolls rather than clips, down to 900 x 560).

- **Opens when needed:** the browser runtime starting on a task (its first command, or its control
  stream connecting, after 30 s of quiet) opens it on the Browser tab; the user opens it with the
  header's Browser button (a globe), Window, Show Browser (a packaged app has no View menu, so it is in
  the Window menu) or Ctrl or Cmd+Shift+B. **Closing only hides it**: the panel's pages stay and the
  task goes on, and the same task does not reopen it. While a task runs the Browser button says
  "Browser working" with a pulse.
- **Resizable:** a divider (8 px hit area, accent line on hover or focus, `col-resize`) between the
  chat and the panel. Drag it (pointer capture, so the moves keep coming over the native views),
  arrow keys when focused (Shift for bigger steps), double-click for the default 440 px. 360 px at
  least, 70% of the window at most. The HTML panel follows the pointer at once and the main process
  moves the Cerea view and the browser's pages to the same width in the same turn. The width is
  remembered per profile (written once when it settles, and at quit); whether the panel is open is
  remembered per profile for the session only.
- **One tab at a time:** the browser's pages are native views, which sit above any HTML, so they are
  hidden **and given zero bounds** whenever the panel is closed or shows galopin or Profiles, and
  their toolbar is HTML that is hidden with the pane. (A `display: flex` rule had overridden the
  `hidden` attribute, so the panel and the browser's toolbar were drawn on every tab and at start; a
  global `[hidden] { display: none !important }` fixes the cause, and the smoke test asserts the
  rendered state, not the attribute.)

### The galopin tab

A status card at the top with one sentence and one action (Pair this computer, Sign in again, Stop,
Start); one row per coding tool (Launch, and a switch "Use galopin by default" = `setup TOOL
--default` or `--remove`; a tool not found on PATH is greyed with no buttons; galopin's own shims are
not counted as the tool); Browser and connectors, each with a line of status; one switch for the
background service; and a collapsed Advanced (version and upgrade, and the log, de-duplicated so a
repeated line shows once with a count, copyable). The shims go to `<userData>/shims`
(`GALOPIN_INSTALL_DIR`), a place that does not move, because the app's own galopin may live in a
mount that does; the row says to put that folder first on PATH. "Sign-in expired" is read from
galopin's own `invalid_grant` link error; **Sign in again** runs `galopin auth login` with the
profile's `--creds`. galopin cannot tell expired from revoked in that message, so there is one state.

### galopin runs from a stable copy

The bundled galopin is copied to `<userData>/bin/galopin` (a 0700 directory and file, checked against
the bundled binary's hash and made again when they differ: a new app version, or a copy that was
changed) and **every** galopin command the app runs goes through that copy, on every platform. Why:
`galopin setup` and `galopin service install` record the path of the galopin that wrote them
(`os.Executable()`), and an AppImage runs from `/tmp/.mount_<random>`, which is gone when the app
quits and can be recreated by another local user, so a shim or a login service would run whatever
they plant there, as the victim. `GALOPIN_INSTALL_DIR` is `<userData>/bin`, so shims and units name the
stable copy. At every start, shims and the service unit that name a mount or resources path (written
by an earlier version) are re-pointed (a changed unit is followed by `systemctl --user daemon-reload`;
a changed macOS plist takes effect when it is next loaded). The path is quoted the way each format
needs (shell single quotes with an apostrophe escaped, systemd `ExecStart` quotes with `%` and `$` doubled,
XML for the plist), the systemd user directory follows `XDG_CONFIG_HOME`, and leftover `.galopin-*`
temporary copies are removed at start. **There is no Upgrade action in the app**: `galopin upgrade` would
replace this copy and the next start would put the app's own back, so the galopin tab says "galopin updates
with the app (version X)" and `galopin upgrade --show` stays as information only.

### A profile uses only a pairing for its own server

A credential counts for a profile only when its recorded Cerea address (origin) and identity provider
match the profile's. Profile 1 used to adopt galopin's default directory whatever was in it. Now,
when that directory holds another server's pairing (made by the CLI or for another profile), the
profile gives the default directory up and gets its own: that pairing is neither used nor
overwritten nor set aside, galopin is **never started** on it, and the card says "Paired with another
server ... Pair for this profile", which pairs into the profile's own directory.

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
Cerea (server) -- galopin run -- mcp.json "cerea-browser" -- node cerea-browser.mjs --connect-file <galopin dir>/cdp-endpoint
                                                                |  ws+unix://<run>/cdp.sock:/cdp/<profile's secret>
                                                                v
  Electron main:  bridgeServer (0600 socket, secret path, no Origin) -> CdpBridge (fake browser) -> Control (take over gate)
                                                                -> BrowserPanel.targets() = the panel's pages ONLY
                                                                -> webContents.debugger  (no other webContents is ever attached)
```

Why this meets the requirement:

- **No TCP port at all.** The socket is mode 0600 in a 0700 directory (`<userData>/run`, or a
  per-user temp directory when the path is too long for `sun_path`). Another OS user cannot open
  it, a web page cannot reach it (no TCP, and a request carrying an `Origin` header is refused).
- **A secret per profile and per start.** The path carries 256 random bits, made at each app start
  for each profile. A profile's endpoint (socket and secret) is written to `cdp-endpoint`, 0600, in
  **that profile's own galopin directory** (galopin's default directory for profile 1), and
  `galopin browser setup --connect-file` registers that file for that profile's connector, so the
  entry in its `mcp.json` is static and survives restarts. **Only the active profile's secret is
  served**, on CDP and on `/ctl`: another profile's gets `403 This browser belongs to another
profile.`, so a galopin of an inactive profile (a `galopin run` or a shim outside the app) cannot
  drive the panel that is open. Another process of the same user could read a profile's file, which
  is the same boundary as galopin's key file and profile today; it cannot connect without it.
- **The Cerea window is unreachable, structurally.** `CdpBridge` is constructed with the
  `BrowserPanel` and nothing else. It has no reference to the Cerea view or the local UI. A
  `sessionId` the bridge did not mint is refused; `Target.closeTarget` and `activateTarget` take
  only ids the panel lists; `Target.createBrowserContext` and `disposeBrowserContext` are refused;
  any browser-wide command (`Storage.*`, `SystemInfo.*`, `Network.getAllCookies`) is unknown.
  The smoke test asserts the runtime's tab list never contains the Cerea page.
- **Page-level commands are deny-by-default** (`cdpPolicy.ts`). A security review reproduced the
  hole this closes: Electron's debugger is a full DevTools agent, so on the prototype a page
  session's `Target.getTargets` listed the Cerea view and the local UI, `Target.attachToTarget`
  with `flatten` opened a session on the UI, and `Runtime.evaluate` read its `window.secret`
  (and `window.cerea.call(...)` would have passed the UI sender check); `Page.navigate` also took
  the panel to `file:///etc/hostname`. Now only the Page, Runtime, DOM, Input, Emulation,
  Network, Fetch, Accessibility, Log, Performance and Inspector domains pass; `Target.*` is
  limited to `setAutoAttach` and `detachFromTarget`; `Storage`, `SystemInfo`, `IO`, `Tracing`,
  `Debugger`, `Browser` and `DOM.setFileInputFiles` are refused. A child session is registered
  only for an iframe or worker that a panel page's own auto-attach reported (anything else is
  dropped and detached), and the Target events a page sends are not forwarded. Navigations (`Page.navigate`, `Target.createTarget`) are checked with the panel's URL
  guard in the bridge, and `did-start-navigation` in the main process puts the panel back on a blank page if one
  gets through anyway. Each of these has a test, and the smoke test repeats them over the real
  socket (a raw CDP client with the right secret).

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

**Take over cuts the runtime off.** When the user takes over, the bridge detaches every session
(Playwright sees the pages close), releases the debugger (its request interception ends, so no
request waits for a runtime that is not there), forwards no event of what the user does, and does
not attach a tab the user opens. On hand-back every tab is attached again as a fresh page. The
runtime then finds the pages as the user's own tabs, so using one asks first ("Let Cerea use
your tab"): the page is the user's now, and an approval is bound to the page address and element
as they were. The cost is that the task's page is no longer "its own" after a take-over.

**The `control` tool** (ADR 0116 phase 2; the contract is Cerea's `contract.ts`, copied to the
runtime by `sync-contract.mjs`) is how Cerea and the runtime know: `control {wait?}` ->
`{state: "agent" | "user"}`.

- The desktop app pushes who is driving to the runtime over `GET /ctl/<secret>` on the same
  private socket (one event now, one per change; a lost stream means "not driving", so the runtime
  never holds for an app that is gone).
- While the user drives, the runtime **holds** every other tool call (up to 25 s, inside Cerea's
  call timeout) instead of failing it; one held longer fails with "The user is driving the browser"
  and a pointer to `control`.
- Cerea's loop calls `control` before each step. On `user` it shows **"You are driving"** on the
  Browsing card (status waiting, `driving`), long-polls `control {wait: true}` until `agent`, does
  not count the time against the task's budget (as an approval's wait), and carries on at
  hand-back. A stopped turn ends it as `aborted`. A runtime with no such tool, or a browser that
  cannot be taken over (headless), is read as always `agent`.
- The "paused" semantics of ADR 0116 are the same shape as a verification: the task waits for the
  user, the wait is not task time, the page is checked afresh afterwards, and a lost lease ends it.

While the runtime works (a command in the last 4 s), a transparent shield view covers the panel so
a stray click cannot disturb it, and the UI says "Cerea is browsing. Watch, or take over." The
user's own browsing in the panel is never blocked when no task runs. Live view in the chat
(screencast) is not needed by the desktop app: the user sees the real panel.

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
  status says "the Cerea desktop app's browser panel".
- **Bundled Node.** The app ships a pinned Node.js (24.22.2; `node-pins.json` holds the SHA-256 of
  each platform's tarball, checked by `scripts/fetch-node.mjs` before anything is unpacked, in CI
  and locally) with npm, so browser use needs nothing installed. Set up browser copies it once into
  `<userData>/node/<version>` (an AppImage mounts at a new path each start, and the connector
  entry names Node by an absolute path that must last), checks the copy against the hash recorded
  at build time and puts it first on galopin's PATH for that command. **Size:** 140 MB unpacked,
  58 MB (Linux x64) and 53 MB (macOS arm64) compressed in the tarball, so roughly 45 to 60 MB more
  for the app download, and 140 MB more on disk once copied. `npm ci` still needs the network, as
  `galopin browser setup` always has. A development run uses the Node on PATH.
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
  developer account yet, owner 2026-11-25), and **no macOS auto-update** (an unsigned app cannot
  take one). The app's **About** (Server tab) says both, and that a new version is a new download. The same first-open steps apply (docs/agent-machines.md); an install script that
  clears quarantine can follow the connector's. Linux needs none.
- **Auto-update**: later (electron-updater against GitHub releases once the app is signed; an
  unsigned macOS app cannot auto-update).
- **CI**: `.github/workflows/desktop.yml`: lint, unit tests, build, the Xvfb smoke (with a 20 s
  idle measurement), then Linux and macOS packages as run artifacts. Nothing is published and no
  release is touched.

## Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true` on
  every web contents; no `<webview>` (attaching one is refused).
- **Only the local UI has a preload**, exposing `window.cerea.call(channel, arg)` for the 25
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
- **The local UI is `app://ui/`, not `file://`**: a custom standard scheme served by
  `protocol.handle` from the UI directory only (dot segments cannot leave it, only three file
  types), so `grantFileProtocolExtraPrivileges` is off. Its sender check requires that origin.
- **CSP for local UI**: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'
data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, as a
  `<meta>` tag in the page (a test keeps it equal to the header the protocol also sends:
  `webRequest` does not see local pages). No inline script or style, no network, and the server's
  icon arrives as a `data:` URL made in the main process.
- **Permissions**: the default session denies everything; the Cerea window grants clipboard write
  and notifications only to the chosen origin itself (the request's origin is checked, so not the
  identity provider and not a frame); the panel denies all.
- **Sign-in excursion**: the Cerea window may follow a server-side redirect only to the
  **identity provider the server names** (`issuer` in `enroll.json`, stored with the server), and
  back; a provider upstream of it is not reachable (an administrator-configured list of extra hops
  can come later).
- **Fuses**: `runAsNode`, node options and inspect arguments off; cookie encryption on; the file
  protocol's extra privileges off; asar integrity and `onlyLoadAppFromAsar` on; the ad-hoc Darwin
  signature reset for the unsigned arm64 build. No DevTools or View menu in a packaged app.
- **The bridge directory** is a real directory owned by the user with no group or world access
  (a symlink, another user's directory or an open one is refused), and a bridge that cannot start
  switches the panel off, not the app. Quit waits for galopin and the socket to close.
- **galopin**: a packaged app runs only the galopin it ships (`GALOPIN_BIN` is for development).
  Switching server waits for galopin to exit before moving its credentials, removes an installed
  service, and says the old server is not told (its sign-in for this computer stays valid until the
  computer is removed from its Agents panel).
- **The panel**: at most 20 tabs, five popups in ten seconds, a popup opens in the background; a
  download is saved silently only while the runtime has just asked for one, and is otherwise
  Electron's usual save dialog.
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

| State                                        | CPU    |
| -------------------------------------------- | ------ |
| visible, idle                                | 0.12 % |
| hidden (`win.hide()`), idle, after 3 s grace | 0.05 % |

`scripts/smoke.mjs` fails when the hidden figure is 1 % or more (`IDLE_BUDGET_PERCENT`); CI uses a
20 s window. Caveats: Xvfb has no window manager, so "minimised" is `win.hide()`, which takes the
same visibility path; there is no real GPU, display link or battery here, so numbers on a Mac
will differ and should be re-measured; the 30 s freeze grace is longer than the measurement's
settle time, so the figure shows the window-hidden cost without the freeze.

## How builds are published

Every Cerea release carries the desktop builds as **preview** assets: `release.sh` runs
`scripts/release/desktop-assets.sh vX.Y.Z` after creating the GitHub release. It takes the
`desktop` workflow's artifacts (kept 90 days) for the tag's commit, or the last earlier build when
nothing it reads changed since (and runs the workflow on the tag when there is none), renames them
`Cerea-Desktop-PREVIEW-<version>-…` with a SHA256SUMS file, and adds a "Cerea Desktop: preview"
section to the notes (template: `scripts/release/desktop-notes.md.tmpl`). The builds are
unsigned and not notarised, and have no auto-update: users download each new build by hand. A
failure there never fails the Cerea release; rerun the script.

## Not in v1

- **Embedded terminal** (xterm.js with `node-pty`): `launch <tool>` opens the system terminal
  (Terminal.app through AppleScript; on Linux the first of x-terminal-emulator, gnome-terminal,
  konsole, xfce4-terminal, kitty, alacritty, xterm). `node-pty` is a native module per platform
  and Electron ABI; it is a packaging project of its own.
- Tray icon, auto-update, Windows, downloads from the panel into a chat (the bridge implements the
  download events, and no test exercises them yet), file uploads from the panel (the runtime
  refuses file choosers in any case).
- The installer-less macOS first-open flow and a `curl | sh` installer like the connector's.

The check runs **before every galopin action** (start, pair, sign in, service, browser setup, launch,
setup, upgrade), not only at start, because the default directory can change while the app runs; the
action refuses with a message when there is no pairing for this profile, and the profile's endpoint
file moves with its directory (the old one is removed). A credential with no recorded Cerea address (an
older enrolment) counts only on the **exact issuer** (a trailing slash aside) **and** the profile's OAuth
client id, both from `enroll.json` and stored with the profile (an issuer's origin alone is shared by Entra
tenants, Google and Keycloak realms); a profile stored before they were kept is probed once at start, and
until then such a pairing is not its own. A default directory nobody owns goes to the profile its pairing
is for. `galopin setup` (the default-shim switches) is refused unless the profile owns that directory, and
editing connectors goes through the same recheck as every other galopin action. **The base path (`/chat`) is not compared**, only the origin and
the identity provider: two deployments on one origin under different paths would look the same.
Accepted for now. The shims `galopin setup` writes follow galopin's default pairing, so only the
profile that owns that directory shows the "Use galopin by default" switches; the others say whose
pairing coding tools use. The log is kept per profile, so one profile's sign-in problem is not read
from another's lines.

A hidden browser page must not keep or take the keyboard: hiding the panel while a page has focus gives
focus to the chat, a hidden page calling `window.focus()` gives it straight back, and `Page.bringToFront`
is refused while the panel is not showing. The header's Browser button shows "Browser working" while a
task runs, whether or not the panel is open.

## Decisions taken (owner, 2026-11-25)

1. The Mac connector stays one release beside the desktop app, then is retired; the desktop app
   has start at login (opt in).
2. Node is bundled (above, with its size).
3. A `control` tool in the browse contract, "You are driving" on the Browsing card.
4. No Apple account yet: unsigned, not notarised, no macOS auto-update; said in About.
5. The user types just the site; the app finds the chat path and shows what it found.

## Still open

- An administrator-configured list of extra sign-in hops (federated identity providers upstream
  of the server's own), if a deployment needs one.
- Re-measure idle CPU on a real Mac (and on battery); the figures here are Xvfb.
- After a take-over the task's page is the user's tab and asks for approval to use: acceptable, or
  should hand-back re-adopt it without asking?
