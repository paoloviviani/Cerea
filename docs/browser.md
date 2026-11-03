# The headless browser (web fetch)

!!! info "For operators"

    Turning on the headless browser for web fetch is a deployment change.

When someone asks Cerea to read a page at a URL, the chat fetches it. By
default it fetches directly over HTTPS (`FETCH_BACKEND=direct`). That returns
nothing useful for the growing share of pages that are empty until
JavaScript has run. With the **headless browser** turned on, the chat renders
the page in a real browser and reads what a person would see.

## PDFs, documents and long pages

With either backend, a URL that is a PDF, Word, Excel, PowerPoint or epub file
is not read as text: it is fetched as a file and read with the same document
reader an attached file uses, as the person asking, so it is metered and
access-checked the same way. If the reader cannot read it, the assistant is
told why. Long pages and documents arrive in chunks of about 24,000 characters;
the assistant reads on by calling `web_fetch` again with an `offset`. The text
is kept for the turn, so reading on does not fetch or extract again, and a
read-on call does not count toward the per-turn limit of 20 fetches.

## How a page is read

With the headless browser turned on, a page is read in two steps:

1. **Directly first.** The chat fetches the page over HTTPS, through the same
   address checks and document handling as the direct backend. The result is
   used when it is a real page: at least about 600 characters of readable text,
   not made of cookie-notice wording, not a known consent redirect (such as
   `consent.google.com` or `consent.yahoo.com`) and not an empty JavaScript
   shell. The test looks at all the readable text of the page, not only the
   part Readability picks as the article, so a homepage made of headlines
   counts.
2. **The browser as the fallback.** When the direct result is thin, is a
   notice or a shell, or the fetch fails outright (a 403 from a bot wall, a
   timeout), the page is rendered. If the renderer is down, a thin direct
   result is returned rather than nothing.

With `FETCH_BACKEND=direct`, nothing changes: there is no browser step.

### Refused addresses, feeds and feed links

These apply to every fetch backend.

- **One retry with the slash toggled.** When an address answers 403, 404 or
  410, the chat tries it once more with the path's trailing slash toggled
  (`/feed/` and `/feed`), never on a bare site address and never more than one
  extra request. The toggled address goes through the same address checks. When
  it answers, the result says which address did ("Fetched
  https://example.org/feed — https://example.org/feed/ answered 403."). An
  address the user approved covers its toggled spelling too.
- **A failure says what to try.** A 403 reads "the site refused this address",
  a 404 or 410 reads "no page at this address", each with a short next step
  instead of more guessing, and says when the slash variant was tried.
- **RSS, Atom and RDF feeds come back as a list**: the feed title and link, then
  one line per item with its date, title, link and up to about 200 characters of
  plain-text summary, at most 100 items. A feed is never sent to the browser.
  XML that is not a well-formed feed is returned as delivered.
- **Feed links on pages.** When a page's head advertises a feed
  (`<link rel="alternate" type="application/rss+xml">` or Atom), the result ends
  with the absolute address of up to three, so the assistant can use the exact
  address.

### The `render` option

When the renderer is selected and answering, `web_fetch` takes an optional
`render: true`. It skips the direct attempt and reads the page in the browser.
The assistant is told to use it when a page looks incomplete, is a JavaScript
shell, or is a consent or cookie notice. Without the renderer the option is not
offered and the tool descriptions do not mention rendering. A forced render is
kept apart from a direct read in the turn's cache and is never answered from
the stored direct text.

## Cookie notices

A fresh browser has no consent cookie, so many sites put a notice in front of
the page. Before the text is read, the renderer does the following, in at most
about five seconds, and a failure at any point never fails the fetch:

- **Reject first, with autoconsent.** DuckDuckGo's
  [autoconsent](https://github.com/duckduckgo/autoconsent) (MPL-2.0, used
  unmodified, pinned to an exact version) is injected into every frame with
  Playwright's `addInitScript`, and its messages are answered through
  `exposeBinding`. These are ordinary protocol calls, so it works over the
  remote connection to the `run-server` container: no browser extension is
  involved. It is set to opt out (reject), not accept, and its cosmetic
  "hide the banner" rules are off, so hiding is never the only action. Its
  rules cover the common consent platforms (iubenda, OneTrust, Cookiebot,
  Didomi, Sourcepoint and many site-specific ones).
- **Google and YouTube.** The `SOCS` cookie with the value `CAE=` is set on the
  context before navigating to `.google.*` and `.youtube.com`. It is the
  "rejected" state of Google's consent cookie (`CAI=` is "accepted"); the
  legacy `CONSENT` cookie has no reject value, so it is not set.
- **Overlays that remain.** A fixed or sticky layer with a very high `z-index`
  that carries consent wording is removed, as is a fixed consent iframe, and a
  scroll lock on the page is released. A layer that contains an `<article>` or
  `<main>`, or a long text, is never removed.

What is **not** handled: a notice no rule knows and that hides its content
behind the click (an overlay is removed, but a page that only builds its article
after the click stays empty), sites that need an account or a subscription, and
CAPTCHAs. A generic "click any button called Reject" step was considered and
left out; it can be added if a common case turns out to need it.

When the final text still looks like a consent notice or a "pay or accept"
wall, the assistant is not given it as the article. It is told that the page
showed a wall that could not be passed, is shown the first few hundred
characters, and is told its options: try `render: true` if that was not tried
and is offered, search for another source, or ask the user to paste the text.

The debug log line `fetch_consent_step` says what acted (the autoconsent rule,
an overlay removal, or nothing).

## Turning it on

In the deploy kit, add the `fetch` profile. The `enterprise` preset includes it;
for another preset run `./configure --fetch`, then `docker compose up -d`
(`./configure --no-fetch` removes it again).

That runs one more service, a Playwright `launch-server` (one Chromium) on port 3000 of the compose network. The chat reaches it at
`PLAYWRIGHT_WS_ENDPOINT` (`ws://playwright:3000/`), which `./configure` sets
while the profile is on and removes when it is off.

The admin screen **Admin → Web → Fetching** shows which backend is selected and whether
the renderer answers:

| Status         | Meaning                                                                                 |
| -------------- | --------------------------------------------------------------------------------------- |
| Reachable      | the renderer answers; `playwright` works                                                |
| Unreachable: … | an address is set but nothing answers there (still starting, stopped, or wrong address) |
| Not configured | no address is set: the `fetch` profile is off                                           |

You can select `playwright` before the service is up; the tool that uses it
is only offered to the model while the renderer answers.

## Never publish it

`run-server` has **no authentication of any kind**: no token, no password, no
TLS. Anyone who can open a WebSocket to it can drive a real browser, read the
container's files through `file://`, and reach every other service on the
compose network from inside it: PostgreSQL, Valkey, the gateway (which is why
it now sits on a network of its own, below). A reverse
proxy in front does not help, because there is no credential for it to check.

So the service has no `ports:`, and must never get one. (`--host 0.0.0.0` in
its command binds inside the container only, which is what the chat needs to
reach it.) To debug from the host, publish it on loopback, temporarily:

```bash
docker compose run --rm --publish 127.0.0.1:3000:3000 playwright
```

## Version pin

The server and the chat's Playwright client must agree on the **minor**
version: a mismatch is refused outright (`428 Precondition Required …
Playwright version mismatch`), not degraded. Both are pinned to **1.64.1**:
`PLAYWRIGHT_VERSION` feeds the image tag and the `npx` argument in the
compose file, and the chat's `package.json` pins `playwright` exactly. Change
them together.

## Cost

|               |                                                             |
| ------------- | ----------------------------------------------------------- |
| Image on disk | about 3.5 GB (three browser engines and ffmpeg)             |
| Idle          | about 190 MiB                                               |
| Rendering     | about 180 MiB more per concurrent page, released afterwards |

That is why it is opt-in: on a small host the image and a browser that grows
with the page are the wrong default.

## How it is boxed in

The browser opens pages a model was pointed at, with JavaScript on, so it is
treated as the part of the stack most likely to meet hostile code. The chat's
URL check only filters what the page asks for through Playwright; a compromised
browser's own code does not go through it. So the box does not rely on it:

- **Its own network.** The service is on the `fetch` network, shared with the
  chat and nothing else, and not on `default`. It cannot resolve or reach
  PostgreSQL, Valkey, the gateway, Authelia or MongoDB. The network is not
  `internal`, because fetching public pages needs the internet.
- **Chromium's sandbox is on, enforced by the server.** Playwright starts
  Chromium with `--no-sandbox` unless told otherwise, and `run-server` leaves
  that to each client (honouring a client's `chromiumSandbox` needs `--unsafe`,
  which also lets it set `args` and `executablePath`). So the service runs
  `launch-server` with `kit/playwright-server.json`: one Chromium, launched at
  start with `chromiumSandbox: true`, that clients connect to. A connecting
  client cannot launch a browser or change those options, so a client that asks
  for no sandbox, or says nothing, still gets the sandboxed one. The sandbox
  needs user namespaces, which Docker's default seccomp profile blocks; the
  service uses Playwright's own profile (`kit/seccomp/playwright.json`, with its
  source and licence in `kit/seccomp/NOTICE.md`) rather than extra capabilities.
  The server's path stays `/`, so `PLAYWRIGHT_WS_ENDPOINT` is unchanged. All
  concurrent fetches share that one browser, each in its own context.
- **A read-only filesystem, no capabilities, no privilege escalation,** scratch
  space in tmpfs (including the npm cache the start-up `npx` writes), and
  memory (`PLAYWRIGHT_MEM_LIMIT`), CPU (`PLAYWRIGHT_CPUS`) and process limits.

Bump `kit/seccomp/playwright.json` together with the Playwright version.

## Details in the service definition

- **`shm_size: 1gb`:** Chromium shares memory through `/dev/shm`, and Docker's
  64 MB default makes heavy pages crash their tab with `SIGBUS`.
- **`user: pwuser`:** the browser is the process most likely to run someone
  else's code, so it runs unprivileged.
- **The driver is fetched from npm at start:** the image carries the browsers
  but not the `playwright` npm package, so a registry outage makes the service
  fail to start.
