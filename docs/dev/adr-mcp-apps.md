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

- **One sandboxed iframe, rendered from `srcdoc`, with `sandbox="allow-scripts allow-forms ..."` and no
  `allow-same-origin`.** The page gets an opaque origin: it cannot read Cerea's cookies, storage, DOM or session, and it
  cannot make a credentialed request to Cerea. This is the sink that HTML artifacts already use (`PREVIEW_SANDBOX`,
  `previewSrcdoc.ts`; `artifactTool.ts` noted that the `ui://` slice would share it). No popups, no downloads, no
  modals, no top navigation.
- **Deviation from the spec text, on purpose.** The spec asks for `allow-same-origin` plus a *different* origin served
  by a host-controlled server with CSP response headers (single or double iframe). Cerea has one origin per deployment
  and no second domain to rely on. An opaque origin gives the same isolation (a unique origin the host cannot be
  confused with) without a domain. The cost: the page has no origin-bound storage (`localStorage`, cookies, IndexedDB
  throw or are empty) and cannot be used as an OAuth redirect target, and a resource's `_meta.ui.domain` is ignored.
  Pages written for the common examples do not need any of these. The `postMessage` channel is the official
  `PostMessageTransport`, which accepts messages only from that one iframe's window.
- The page is **never** loaded from the connector's URL, only from the HTML Cerea read itself.

### 2. What the page may load (CSP)

- The CSP comes from the resource's own declaration (`_meta.ui.csp`: `connectDomains`, `resourceDomains`,
  `frameDomains`, `baseUriDomains`), read from the `resources/read` content item, falling back to the `resources/list`
  entry. It is injected as a `<meta http-equiv="Content-Security-Policy">` that comes **first** in the document, in front
  of anything the page contains (the page's markup is concatenated after it, so a script cannot run before the policy).
- **Strict default** when nothing is declared: the spec's restrictive default (`default-src 'none'`, inline script and
  style, `data:` images and media, `connect-src 'none'`, `object-src 'none'`), plus `form-action 'none'`.
- Declared domains are **validated**, not pasted: only `https:` and `wss:` origins (and `http://localhost` is *not*
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

| Page request | Cerea |
| --- | --- |
| `tools/call` | Server-side, **through the approval gate**, same connector only, only tools whose `_meta.ui.visibility` includes `"app"` (default both). See below. |
| `ui/message` | Allowed, **conservatively**: the text becomes a *draft in the composer*, labelled as coming from the page. The user reads it and sends it, or clears it. It is never sent as a user turn on the page's say-so. Text only; length-capped. |
| `ui/open-link` | `http`/`https` only, after a **confirmation dialog** that shows the full address and the connector's name. Opened with `noopener,noreferrer`. |
| `ui/request-display-mode` | `inline` and `fullscreen` (a fixed overlay in the same page; Escape or a button closes it). `pip` is declined. |
| `ui/notifications/size-changed` | Height follows the page, capped. |
| `notifications/message` (logging) | Accepted, kept in the browser console at debug level. Not shown. |
| `ui/update-model-context`, `ui/download-file`, `resources/*`, `tools/list`, `sampling/*`, `prompts/*` | **Not supported yet**, refused. |

**Page-initiated tool calls (the one real risk).** The page is untrusted, and a call it starts acts with the
connector's credential. So:

1. The call is made by the **server** (`POST /conversation/<id>/mcp-app/call`), with the connector's own credential for
   that user, resolved by the same resolver a turn uses (ADR 0104), never a credential or address the browser or the
   page supplies. The connector must be on for this user and apps must be allowed for it (`appsAllowedFor`).
2. The tool must belong to **that connector** and be visible to apps. The page names no server.
3. **The gate is the model's gate, unchanged** (ADR 0075): under *Allow* (`always-allow`) a call runs; under *Ask*
   (`manual`) a call runs only if the conversation already holds a grant for `connector:tool`, **otherwise the server
   answers "approval required"** and runs nothing. The browser then shows Cerea's own approval card, *worded as the page's
   request*, "The page from <connector> wants to call <tool>", with the arguments, and **Allow this one call / Allow
   this tool for the rest of the conversation / Deny**. Only that click (Cerea's own UI, in the top document, which a
   page cannot reach) sends the retry with the approval; "for the conversation" records the same
   `conv.approvedTools` grant a model call would. A grant given to the model's call covers the page's call and the other
   way round, since both are `connector:tool`.
4. The page cannot send the retry itself: the route needs the user's session cookie, which an opaque-origin frame does
   not have, and the route is not CORS-enabled.
5. **Rate limit**: per conversation and user, a small burst and a per-minute ceiling, on the server (and a lower one in
   the browser for kindness). An answer past it is an error the page sees.
6. A call has the same timeout as a model's, no elicitation (an `input_required` is an error: there is no turn to park),
   and is logged (connector, tool, user; never arguments or results) with `source: "app"`.

Anything a page returns to the *model* is not in this version: there is no `ui/update-model-context`, and a page
message is a draft, so page content reaches the model only by a user sending it. The tool's own result, the text the model
already reads, is unchanged and still marked as outside data (`untrusted.ts`).

### 4. What is stored (the snapshot)

- The HTML is read **once**, when the tool result arrives, with the connector's credential, through the pooled MCP client
  (`resources/read`), and stored in the conversation's file store (content-addressed by sha256, deduped, so repeated
  calls to the same app store it once; the same retention as other produced files). The message keeps a small
  reference, not the HTML: `{connector, server, tool, uri, sha256, size, csp, prefersBorder}`.
- A reload renders from the stored copy with the stored tool input and result, **without the connector being reachable**.
  The stored copy is fetched through an access-controlled route that checks apps are still allowed for the connector.
  Past the retention period the card falls back to the text result.
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

### 6. Not supported yet

`ui/update-model-context`, `ui/download-file`, `pip`, app-registered tools (`tools/list` from the page, host to page
`tools/call`), `sampling/createMessage`, `resources/read` from the page, camera, microphone and location,
`_meta.ui.domain`, partial tool input streaming (`tool-input-partial`), and rendering in public share links (the
shared page shows the text result). Sub-agent turns show the card of the call that made the page like any other.

## Consequences

- The page can do nothing that the user has not seen the effect of or agreed to: it cannot act (the gate), speak for the
  user (draft only), navigate (confirm), or load from undeclared hosts (CSP).
- Network exfiltration to **declared** connect domains is possible by design (that is what the declaration is for), so
  they are shown, and an administrator can block a connector's apps.
- Opaque origin breaks pages that need storage. That is accepted for the first version; a dedicated apps origin
  (`apps.<host>`, single iframe with response CSP headers, as the spec's own recommendation) is the follow-up if such
  pages matter.
- One more dependency: `@modelcontextprotocol/ext-apps` 2.1.0. Its peer range wants zod 4.2; Cerea is on zod 3.25, whose
  `zod/v4` subpath the bridge imports, so `package.json` carries an `overrides` entry for it.
