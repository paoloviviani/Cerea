# The headless browser (web fetch)

When someone asks Cerea to read a page at a URL, the chat fetches it. By
default it fetches directly over HTTPS (`FETCH_BACKEND=direct`). That returns
nothing useful for the growing share of pages that are empty until
JavaScript has run. With the **headless browser** turned on, the chat renders
the page in a real browser and reads what a person would see.

## Turning it on

In cerea-deploy, add the `fetch` profile. The `enterprise` preset includes it;
for another preset run `./configure --set COMPOSE_PROFILES=…,fetch
FETCH_BACKEND=playwright`, then `docker compose up -d`.

That runs one more service, a Playwright `run-server` (Chromium, Firefox and
WebKit) on port 3000 of the compose network. The chat reaches it at
`PLAYWRIGHT_WS_ENDPOINT` (`ws://playwright:3000/`), which `./configure` sets
while the profile is on and removes when it is off.

The admin screen **Admin → Fetch** shows which backend is selected and whether
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
compose network from inside it: PostgreSQL, Valkey, the gateway. A reverse
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
Playwright version mismatch`), not degraded. Both are pinned to **1.61.1**:
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

## Details in the service definition

- **`shm_size: 1gb`:** Chromium shares memory through `/dev/shm`, and Docker's
  64 MB default makes heavy pages crash their tab with `SIGBUS`.
- **`user: pwuser`:** the browser is the process most likely to run someone
  else's code, so it runs unprivileged.
- **The driver is fetched from npm at start:** the image carries the browsers
  but not the `playwright` npm package, so a registry outage makes the service
  fail to start.
