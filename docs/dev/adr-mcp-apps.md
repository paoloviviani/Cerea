# ADR (draft): MCP Apps, interactive tool UIs from connectors

- Status: **proposed**, to be moved to `ai-stack/docs/adr` by the owner. Issue #44. Owner go 2026-11-25.
- Spec: [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (`specification/draft/apps.mdx`, extension id
  `io.modelcontextprotocol/ui`). Host bridge: `@modelcontextprotocol/ext-apps` **2.1.0** (published 2026-10-27), the
  official `AppBridge`. Cerea does not speak its own protocol with the page.

## Context

A connector can link a tool to an interactive HTML page (`_meta.ui.resourceUri`, a `ui://` resource of type
`text/html;profile=mcp-app`). A host that supports the extension shows the page in the chat, passes it the tool's input
and result, and lets it call the connector's tools and talk to the host. Hosts that do not support it show the tool's
text result, so adding it breaks nothing.

The page is **code written by the connector's author, running in the user's browser, next to the chat**. Some
connectors are the user's own, some an administrator's, some a third party's. Cerea treats it like an HTML artifact the
model wrote, with one difference: it can reach back to its server through the host. That is the part that needs a
design.

## Decision

### 1. Where the page runs

- **One sandboxed iframe, rendered from `srcdoc`, with `sandbox="allow-scripts"` and no
  `allow-same-origin`.** The page gets an opaque origin: it cannot read Cerea's cookies, storage, DOM or session, and it
  cannot make a credentialed request to Cerea. This is the sink that HTML artifacts already use (`PREVIEW_SANDBOX`,
  `previewSrcdoc.ts`; `artifactTool.ts` noted that the `ui://` slice would share it). No popups, no downloads, no
  modals, no top navigation.
- **Deviation from the spec text, on purpose.** The spec asks for `allow-same-origin` plus a _different_ origin served
  by a host-controlled server with CSP response headers (single or double iframe). Cerea has one origin per deployment
  and no second domain to rely on. An opaque origin gives the same isolation (a unique origin the host cannot be
  confused with) without a domain. The cost: the page has no origin-bound storage (`localStorage`, cookies, IndexedDB
  throw or are empty) and cannot be used as an OAuth redirect target, and a resource's `_meta.ui.domain` is ignored.
  Pages written for the common examples do not need any of these. The `postMessage` channel is the official
  `PostMessageTransport`, which accepts messages only from that one iframe's window.
- The page is **never** loaded from the connector's URL, only from the HTML Cerea read itself.
- **The frame cannot take the bridge with it.** A sandboxed frame can navigate itself (script, meta refresh, a link to itself), and the new document would keep the same window and the bridge, outside the CSP built for the first one. The card counts the frame's `load` events: any load after the page's own, or a second `initialized`, closes the bridge and removes the frame (the card says so). `navigate-to` is not available in browsers, so detection is what there is.
- **No delegated permissions** (`allow` is not set: no clipboard, camera, fullscreen), and `allow-forms` is not granted: `form-action 'none'` makes it moot.
- **Single iframe, not the reference double iframe.** There is no outer proxy frame on a second origin: one sandboxed frame, opaque origin, and the bridge talks to it directly.

### 2. What the page may load (CSP)

- The CSP comes from the resource's own declaration (`_meta.ui.csp`: `connectDomains`, `resourceDomains`,
  `frameDomains`, `baseUriDomains`), read from the `resources/read` content item, falling back to the `resources/list`
  entry. It is injected as a `<meta http-equiv="Content-Security-Policy">` that comes **first** in the document, in front
  of anything the page contains (the page's markup is concatenated after it, so a script cannot run before the policy).
- **Strict default** when nothing is declared: the spec's restrictive default (`default-src 'none'`, inline script and
  style, `data:` images and media, `connect-src 'none'`, `object-src 'none'`), plus `form-action 'none'`.
- Declared domains are **validated**, not pasted: only `https:` and `wss:` origins (and `http://localhost` is _not_
  accepted), with an optional leading `*.` wildcard label and an optional port. A value with a space, quote, semicolon,
  comma, path, or any other character, a bare `*`, a scheme-only source or `'unsafe-*'` is dropped (and logged), never
  rewritten. Wildcards are accepted only as a first label of a host with at least two more labels.
- `unsafe-eval` is **not** granted. Pages that need it fail visibly in their frame.
- The permissions a resource may ask for (`camera`, `microphone`, `geolocation`) are **not granted**; only
  `clipboard-write` is delegated, as for artifacts. The host advertises no `sandbox.permissions`.
- The user sees which external domains a page declared (the card's details), so the audit trail the spec asks for is
  visible and not only logged.

### 3. What the page may do (the bridge)

Everything goes through the official `AppBridge` and a small set of handlers. **A request with no handler is refused.**

| Page request                                                                                          | Cerea                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/call`                                                                                          | Server-side, same connector only, only tools whose `_meta.ui.visibility` includes `"app"` (default both). **Through the approval gate, except a page-only tool** (visibility lists `"app"` and not `"model"`), which runs without a prompt. See below.                                                              |
| `ui/message`                                                                                          | Allowed, **conservatively**: the text becomes a _suggestion chip above the composer_, "<connector> suggests a message: Insert · Dismiss". It is never written into the draft, never takes the focus and is never sent: Insert is the user's click. At most one suggestion per 10 seconds. Text only; length-capped. |
| `ui/open-link`                                                                                        | `http`/`https` only, after a **confirmation dialog** that shows the full address and the connector's name. Opened with `noopener,noreferrer`.                                                                                                                                                                       |
| `ui/request-display-mode`                                                                             | `inline` and `fullscreen` (the card's own element restyled as a fixed layer over the whole window; Escape or the close button leaves; the page is told each change through the host context). `pip` is declined.                                                                                                    |
| `ui/notifications/size-changed`                                                                       | Height follows the page, capped.                                                                                                                                                                                                                                                                                    |
| `notifications/message` (logging)                                                                     | Accepted, kept in the browser console at debug level. At level `error` or `warning` it also lands in the card's problem list ("Show details"), see section 7.                                                                                                                                                       |
| `ui/update-model-context`, `ui/download-file`, `resources/*`, `tools/list`, `sampling/*`, `prompts/*` | **Not supported yet**, refused.                                                                                                                                                                                                                                                                                     |

**Page-initiated tool calls (the one real risk).** The page is untrusted, and a call it starts acts with the
connector's credential. So:

0. **The connector is never taken from the browser or the page.** It is the one recorded on the server when the tool answered (stored with the page), and the call route refuses a connector the conversation holds no stored page of. `appsAllowedFor(connectorRef, userId)` is asked with that record and the user.
1. The call is made by the **server** (`POST /conversation/<id>/mcp-app/call`), with the connector's own credential for
   that user, resolved by the same resolver a turn uses (ADR 0104), never a credential or address the browser or the
   page supplies. The connector must be on for this user and apps must be allowed for it (`appsAllowedFor`).
2. The tool must belong to **that connector** and be visible to apps. The page names no server.
3. **Page-only tools run without the gate** (owner decision, 2026-11-26). A tool whose `_meta.ui.visibility` lists `"app"` but not `"model"` is the app's private API: the model never sees it, it belongs to the page's own connector (resolved on the server, never named by the page), its visibility is read from the connector's own listing (`getToolUiMeta`), never from the page, and the page is rate limited. A prompt for every autosave or refresh would make such an app unusable and protects nothing the model could not already be stopped from. The page's links still go through the open-link confirmation. Everything else below is unchanged for the tools the model can also see.
4. **For those, the gate is the model's gate, with the page's own grants** (ADR 0075; owner decision): under _Allow_
   (`always-allow`) a call runs; under _Ask_ (`manual`) a call runs only if the conversation holds a grant **for pages**
   for `connector:tool`, **otherwise the server answers "approval required"** with an id and runs nothing. The browser then
   shows Cerea's own approval card, _worded as the page's request_, "The view from <connector> wants to call <tool>", with
   the arguments, and **Allow once / Allow this tool for the rest of the conversation / Deny**. "For the conversation"
   records `Conversation.approvedAppTools`: **a separate list from the model's `approvedTools`. A grant given to the
   model's call never covers a page's call, and the other way round.**
   - The id is issued with the 409, bound to (conversation, connector, tool, hash of the arguments, user), valid for two
     minutes and **spent once**. The server never trusts a bare `once` in a request body: the retry carries the id and
     the choice, and an id that was not issued for exactly this call, was spent or has expired runs nothing. A denial
     spends it too, so the one waiting slot is freed.
   - **At most one approval is issued per conversation at a time** (server side). The card queues the rest: a call the server turns away as busy waits for its turn in the browser (up to three waiting, past that it is refused). Asking (the 409 path)
     is rate limited like calling.
   - The card sits in the flow above the frame (and in the full-screen layer's header area), never under the iframe, and its buttons do nothing for about half a second after it
     appears (a click aimed at the page must not land on an Allow that just appeared).
5. The page cannot send the retry itself: the route needs the user's session cookie, which an opaque-origin frame does
   not have. As a second wall the route takes only a JSON body whose `Origin` is this site's own, and a connector the
   conversation holds a stored page of (recorded on the server).
6. **Rate limit** (also for page-only tools; 60 a minute and a burst of 5, so an autosave every few seconds fits): per conversation and user, on the server (and a lower one in
   the browser for kindness). An answer past it is an error the page sees.
7. A call has the same timeout as a model's, no elicitation (an `input_required` is an error: there is no turn to park),
   and is logged (connector, tool, user; never arguments or results) with `source: "app"`.

Anything a page returns to the _model_ is not in this version: there is no `ui/update-model-context`, and a page
message is a draft, so page content reaches the model only by a user sending it. The tool's own result, the text the model
already reads, is unchanged and still marked as outside data (`untrusted.ts`).

### 3a. Full screen, and when a card starts

- **Full screen is a layer, not a move.** Moving an iframe in the DOM reloads it (state lost, and a second load closes the bridge). So the card stays where it is and its element becomes `position: fixed; inset: 0; z-index: 50`, with a slim header (connector, "can contact" line, a close button), safe-area padding, background scroll locked and focus moved to the close button (back on close). What traps a fixed layer inside the chat column is lifted while it is open (`:root[data-app-fullscreen]` in `main.css`): the column's `z-index: -1` stacking context, its `@container` containment and the scroller's fade `mask-image` (which also clips it). The same holds in Safari/WebKit: stacking contexts, `contain` and masks trap or clip fixed descendants there too.
- **The view is the result**, not call detail: it shows without opening the tool row, and also when a run of rows is folded into the "Called N tools" summary (`ToolAppView`, rendered by the summary itself). A card starts its iframe and bridge when it comes within a screen of the viewport and keeps running after (unmounting would reload the page). **Nothing starts before the card has a real size** (ResizeObserver, width and height above zero): a page handed its document while hidden or unlaid (a folded row, `display: none`, an unlaid frame at the default 300 px) can draw at zero or default size and never redraw, which is the blank card seen in an installed Safari app. The host context carries `containerDimensions` (the card's width, and the height limit inline or the frame's size in full screen) at the handshake, and again through `host-context-changed` when the card resizes (debounced) and on every display-mode change.

### 4. What is stored (the snapshot)

- The HTML is read **once**, when the tool result arrives, with the connector's credential, through the pooled MCP client
  (`resources/read`), and stored in the conversation's file store (content-addressed by sha256, deduped, so repeated
  calls to the same app store it once; the same retention period as other produced files). The message keeps a small
  reference, not the HTML: `{connector, server, tool, uri, sha256, size, csp, prefersBorder}`.
- **Stored pages have their own caps and are not the user's files.** They do not count toward the conversation's deliverable limits (file count and bytes); they are kept up to 50 per conversation (oldest first dropped) and 3 versions of one connector's one address (the connector and address are recorded on the row). No file route serves them (the download, preview and share routes refuse them) and file lists leave them out; the only reader is the card's own route.
- A reload renders from the stored copy with the stored tool input and result, **without the connector being reachable**.
  The stored copy is fetched through an access-controlled route that checks apps are still allowed for the connector.
  Past the retention period the card falls back to the text result.
- Only the exact `ui://` URI that a tool of the same connector names in `_meta.ui.resourceUri` is ever read: never another URI or scheme.
- Validation before anything is stored: scheme `ui://`; MIME exactly `text/html;profile=mcp-app` (parameters
  normalised); a `text` or a base64 `blob` that decodes as UTF-8; size at most **2 MiB** (a larger page is not rendered
  and the text result stands); a read time-out. A failure never fails the tool call: the model's result is unaffected.
- The page's **content is not a prompt**: it never reaches the model, only the tool's text result does, as before.

### 5. Control

- **Capability.** The client advertises `extensions["io.modelcontextprotocol/ui"] = { mimeTypes: ["text/html;profile=mcp-app"] }`
  on session connections (not on health probes). Servers may then offer UI-enabled variants.
- **Tools hidden from the model.** A tool with `_meta.ui.visibility` that does not include `"model"` is not offered to the
  model; it stays callable from its page.
- **Per-connector switch (`appsAllowedFor(connectorRef)`).** An administrator can block apps per connector. Default:
  allowed. When blocked nothing is rendered (not fetched, not stored, and calls from an already stored page are
  refused); the text result stands.
- **Users** can still collapse a page; a page never auto-expands to fullscreen.

### 5a. Diagnostics

An installed web app has no console, so a card reports what goes wrong in its page. `buildMcpAppSrcdoc` puts a small inline script (allowed by the page's `script-src 'unsafe-inline'`) right after the CSP meta: it listens for `error` (capture, so failed script/link/image loads count), `unhandledrejection` and `securitypolicyviolation`, and posts `{ cereaDiag: { kind, message, source, line } }` to the parent (about 300 characters each, 20 per page, deduplicated). The card believes only messages whose `event.source` is its own frame, adds the page's `error`/`warning` log messages, and shows "Show details" (list, Copy, Reload view). The first five are posted once per card to `POST /conversation/<id>/mcp-app/diag`, which logs `[mcp-app] the page reported errors` with the connector key and the page's `ui://` address, never page content or user data (rate limited, size capped).

### 6. Not supported yet

`ui/update-model-context`, `ui/download-file`, `pip`, app-registered tools (`tools/list` from the page, host to page
`tools/call`), `sampling/createMessage`, `resources/read` from the page, camera, microphone and location,
`_meta.ui.domain`, partial tool input streaming (`tool-input-partial`), and rendering in public share links (the
shared page shows the text result). Sub-agent turns show the card of the call that made the page like any other.

## Consequences

- The page can do nothing that the user has not seen the effect of or agreed to: it cannot act (the gate), speak for the
  user (a suggestion only), navigate (confirm), or load from undeclared hosts (CSP).
- Network exfiltration to **declared** connect domains is possible by design (that is what the declaration is for), so
  they are shown, and an administrator can block a connector's apps.
- Opaque origin breaks pages that need storage. That is accepted for the first version; a dedicated apps origin
  (`apps.<host>`, single iframe with response CSP headers, as the spec's own recommendation) is the follow-up if such
  pages matter.
- **Accepted risks.** WebRTC (STUN) and DNS prefetch are not governed by `connect-src`, so a page can leak a little
  to the network (an address, a lookup) without a declared domain; `dns-prefetch` hints are not blocked. Accepted for a page the
  user chose to open from a connector they enabled, and an administrator can block the connector's apps.
- **A future nonce-based `script-src` in Cerea's own CSP would break `srcdoc` apps** (the frame inherits the embedder's
  policy): if Cerea moves to nonces, apps need the dedicated origin above first.
- One more dependency: `@modelcontextprotocol/ext-apps` 2.1.0. Its peer range wants zod 4.2; Cerea is on zod 3.25, whose
  `zod/v4` subpath the bridge imports, so `package.json` carries an `overrides` entry for it.
