# The headless browser

`deploy/compose/docker-compose.playwright.yml` adds one service: a Playwright
`run-server` with Chromium, Firefox and WebKit behind it, speaking Playwright's
own WebSocket protocol on port 3000 of the compose network.

**It has a consumer now.** `FETCH_BACKEND=playwright` points the chat's fetch
seam at it (`src/lib/server/fetching/playwright.ts`, reaching
`PLAYWRIGHT_WS_ENDPOINT`, default `ws://playwright:3000/`); `direct` is the
default and plain HTTPS. The `enterprise` profile selects this overlay, the
others do not. It was deployed ahead of its consumer, which is why much of what
follows is written as an argument for deploying it at all.

## What it is for

**Fetching a URL somebody named.** That is a different operation from searching,
and conflating the two is the mistake to avoid here: if you are given a plain
URL you do not search for it, you fetch it. This is the fancy `curl` that does
the fetching — and it has to be a browser rather than an HTTP client because a
growing share of the web is an empty `<div>` until JavaScript has run, and an
HTTP client returns that empty div with no error to say so.

The chat already has the user-facing half of this: a "fetch a URL" affordance in
the composer that today reaches whatever the app could manage on its own. A
renderer behind it is what makes the answer the page a person actually sees.

It is _also_ useful to web search — a search backend that returns links and
snippets needs something to turn a result into readable text, and most search
backends can return page content themselves while Linkup cannot. But that is a
second consumer, not the reason this exists. Fetch stands on its own.

The reason it is deployed here rather than bought is the reason this deployment
exists at all. Handing the rendering to a hosted scraping API would add a third
party that sees every page this deployment reads on a user's behalf, and the
pages are often more revealing than a query would be. Rendering in-process would
be worse still: a browser in the gateway's container is a browser sharing an
address space with the ledger.

So: deployed ahead of its consumer, so that the consumer is a client of
something that already exists, and so that the isolation argument below was
settled before anything depended on the answer.

## Why it is not published, and never can be

`run-server` is **remote code execution as a feature, with no authentication of
any kind**. Playwright offers no token, no password and no TLS on this endpoint.
Whoever can open a WebSocket to it can navigate anywhere, execute arbitrary
JavaScript in a real browser, read this container's filesystem through `file://`
and reach every other service on the compose network from _inside_ the trust
boundary — PostgreSQL, Valkey, the gateway's own port.

That is why the overlay has no `ports:` and why the comment beside the omission
is longer than the service definition. CLAUDE.md's fourth ground rule permits
exactly one published port, the proxy's, and this service is not a candidate for
an exception: Caddy could terminate TLS in front of it but has no credential to
check, so a reverse proxy in front of `run-server` publishes the same hole over
https.

`--host 0.0.0.0` in the command is not a contradiction. It binds every interface
_inside the container_, which is what another compose service needs in order to
reach it at all; a container binding `127.0.0.1` is reachable only by itself.
The two lines have to be read together, and `scripts/test_public_tls_live.py`
now lists 3000 among the ports that must be refused on a routable address — a
skip today, because nothing publishes it, and a failing check the moment
somebody does.

Reaching it from the host to debug is a deliberate and temporary act:

```bash
docker compose --env-file deploy/.env \
  -f deploy/compose/docker-compose.playwright.yml \
  run --rm --publish 127.0.0.1:3000:3000 playwright
```

## The version pin

The overlay pins **1.61.1**, and `PLAYWRIGHT_VERSION` feeds both the image tag
and the `npx` argument so the browser binaries and the driver cannot drift apart.

The pin is not taste. Measured on 2026-09-11 against real servers on this host:
Playwright's WebSocket handshake compares client and server **at minor
granularity** and refuses a mismatch outright. A Python 1.62.0 client against a
1.61.1 server got

```
BrowserType.connect: WebSocket error: ws://…:3000/ 428 Precondition Required
  Playwright version mismatch:
    - server version: v1.61
    - client version: v1.62
```

and no browser at all. Patch versions are not compared.

So the server can only be as new as the version the _consumer_ can also
install — and this was first pinned to 1.62.1 on the assumption that the
consumer would be the Python gateway. It is not: fetching a URL somebody named
belongs to the chat, and the consumer is this repository's Node client. 1.62.1
would have been refused by the only thing that calls it.

1.61.1 keeps the other door open as well: PyPI carries 1.61.x, so a future
Python consumer can still pair with this server, where a 1.62 server could not
have paired with the chat.

This repository's own `package.json` pins `playwright` at **1.61.1 exactly**,
not a caret range — a caret against this protocol is a silent outage waiting
for an unrelated `npm install`. **A consumer of this service pins with `==`, and
moves when the overlay moves.** Changing `PLAYWRIGHT_VERSION` without changing
the consumer's pin is a 428, not a degraded render.

## Cost, and why it is opt-in

Measured on `130.192.84.103` (14 GB, 5 cores) with the pinned image:

|                                                                                                                  |                                                 |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| image on disk                                                                                                    | **3.52 GB** — three browser engines plus ffmpeg |
| idle, no client connected                                                                                        | **187 MiB**, 20 processes                       |
| one client rendering three real pages (wikipedia.org, the _Turin_ article at 98 K of text, news.ycombinator.com) | peak **367 MiB**                                |
| settled after the client disconnected                                                                            | 218 MiB                                         |

That is per _connected client_, not a ceiling: a browser is unbounded by design
and a second concurrent render adds another Chromium. Against the base stack's
footprint this is not free, and on the 3 GB `130.192.84.52` host — where
CLAUDE.md already warns that the stack plus a `pnpm test` will swap — a 3.52 GB
image and a browser that grows with the page is the wrong default.

So the overlay is **opt-in and stays opt-in**, like `smoke` and `proxy`: named
on the `docker compose` line when it is wanted, absent otherwise. What selects
it is the component choice, not the fact that a consumer now exists —
`--components fetch=playwright` in the installer (the `enterprise` profile's
default), which sets `FETCH_BACKEND=playwright` and adds the overlay together.
Choosing one without the other is the failure this pairing prevents: a backend
with no renderer behind it, or 3.5 GB of browser nothing dials.

## Two things in the file that look like details and are not

**`shm_size: 1gb`.** Chromium's renderers share memory through `/dev/shm`, and
Docker's default 64 MB is small enough that a heavy page kills the tab with
SIGBUS — surfaced as a crashed target with no explanation. Playwright's own
advice is `--ipc=host`, which fixes it by sharing the host's IPC namespace; a
bigger `/dev/shm` fixes the same failure without giving a browser that reach.

**`user: pwuser`.** A browser is the process in this stack most likely to be
running somebody else's code. The image provides the unprivileged account for
exactly this reason and the service uses it.

There is also a cold-start dependency worth knowing: the `mcr.microsoft.com`
image carries the browsers but **not** the `playwright` npm package — `npm ls -g`
lists only corepack, npm and yarn — so the container fetches the driver from the
npm registry on every start. A registry outage is a failed start rather than a
degraded service. The alternative is our own image layer on top of a 3.5 GB
base: a build to maintain, for a failure mode that only bites a deployment
restarting during an npm outage. Revisit if that stops being true.
