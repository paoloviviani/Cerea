# The `/code` panel: deploying it

The Agents panel drives **coding agents running on people's own machines** from
the chat's sidebar. Nothing about it runs model inference here, and nothing
about it stores code here: the agent is opencode on somebody's laptop, driven
by a paseo daemon, reached through a relay this deployment hosts (ADR 0085).

This page is for whoever deploys it. The person sitting in front of the panel
wants [Agent machines](agent-machines.md) instead.

## What actually gets deployed

One container and one Caddy route.

| Piece      | Where                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| the relay  | `deploy/compose/docker-compose.code-relay.yml`, compose profile `code-relay`                                              |
| its source | `deploy/code-relay/fetch.sh` clones a **pinned commit** into `deploy/code-relay/paseo-relay/`; the image builds from that |
| its route  | `deploy/caddy/conf.d-code-relay/20-relay.caddy` — `handle /ws*` → `relay:4000`                                            |
| the flags  | `CODE_AGENTS_ENABLED=true`, `CODE_RELAY_URL=relay:4000` in the deployment's `deploy/.env`                                 |

All four live in **this** checkout even though the compose invocation is
assembled from Pystino's `deploy/` directory: the only things that connect to
this relay are Cerea and the users' daemons, so the overlay belongs with its
consumer. Paths into this checkout ride `$CHAT_REPO`.

## Turning it on

Through the installer, which is the supported path:

```bash
./installer/install.sh --components code-panel=on
```

`code-panel=on|off` is the component switch. It is deliberately **not** a
`--set` key: `CODE_AGENTS_ENABLED` and `CODE_RELAY_URL` are derived from it, and
letting `--set` write them would leave the compose profile set and the flags
disagreeing about whether a relay exists.

Turning it on for an existing deployment is a resume:

```bash
./installer/install.sh --phase2 --components code-panel=on
```

The resume re-derives `COMPOSE_PROFILES`, persists the change to `deploy/.env`
(so the compose children read the same shape the process does), fetches the
pinned relay source, and re-asserts the edge route.

By hand, the overlay goes on the end of the set and brings its own profile:

```bash
$CHAT_REPO/deploy/code-relay/fetch.sh
docker compose --env-file <pystino>/deploy/.env \
  -f <pystino>/deploy/compose/docker-compose.yml \
  -f <pystino>/deploy/compose/docker-compose.proxy.yml \
  -f <pystino>/deploy/compose/docker-compose.chat.yml \
  -f $CHAT_REPO/deploy/compose/docker-compose.code-relay.yml \
  --profile chat --profile code-relay up -d --build
```

## The two flags, and why they are two

`CODE_AGENTS_ENABLED` is the **surface**: off (including unset) hides the
Chats/Agents switch at the foot of the sidebar, makes `/code` answer 404, and
makes the pairing endpoints refuse as a backstop. It is off unless explicitly
`"true"` — unlike knowledge or memory, this one needs a relay deployed beside
the chat, and a route that only errors without one is worse than no route.

`CODE_RELAY_URL` is the **rendezvous**: `host:port` over the compose network,
always the service name (`relay:4000`), never the public origin. Cerea dials it
as an end-to-end-encrypted paseo client, one connection per paired device.

It is deployment configuration on purpose. A pairing offer carries its own
relay field and Cerea **ignores it**: if the offer could name the rendezvous, a
crafted offer would point this server at a relay somebody else controls.

There is no `CODE_DAEMON_URL` and no `RELAY_PORT`. Both belonged to earlier
shapes — a daemon addressed directly by URL, and a relay on a published port —
and a deployment carrying either is describing a topology that no longer
exists. The installer strips `RELAY_PORT` out of `deploy/.env` when it finds
it.

## No published port: the relay rides `/ws`

The relay has to be reachable from _outside_ the compose network — the whole
point is daemons on laptops behind NAT — and it still publishes nothing. It
lives at the `/ws` subpath of the origin Caddy already serves.

**The path is forced by the client, not chosen.** Every paseo client — the
daemon, and Cerea through the SDK — builds its relay URL as
`<scheme>://<host>:<port>/ws` from a `host:port` endpoint, with the path
hardcoded. A nested prefix like `/relay/ws` is unreachable because nothing can
generate it. Nothing else in the stack serves `/ws`, and the match is
exact-prefix, so `/wsanything` never collides.

How the route arrives depends on the exposure shape:

| Exposure                            | How                                                                                                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy` (Caddy terminates TLS here) | the overlay mounts `20-relay.caddy` into the proxy's `conf.d`. Nothing else to do — without the overlay the glob matches only the committed placeholder, so a deployment without it is byte-for-byte unchanged                                    |
| `edge` (TLS terminated upstream)    | `Caddyfile.netbird` has no `conf.d` import, so the installer inserts a `(relay-routes)` snippet above the sites and adds `import relay-routes` beside every `import origin-routes`. Same mechanism as the bundled IdP routes, with its own marker |

**Restart the proxy after an edge append.** Caddy reads `Caddyfile.netbird` at
start, and the file is bind-mounted — so changing its contents does not change
any container's compose config, and `up -d` will not recreate the proxy to pick
it up. On a stack that was already running, follow the append with
`docker compose ... restart proxy`, or `/ws` keeps 404ing on a deployment that
otherwise came up clean. A fresh install does not hit this: the append happens
before the first bring-up.

## The trust bundle, on the edge shape

If this deployment runs a bundled IdP (ADR 0084), the installer maintains
`deploy/tls/caddy-root.crt` — the CA bundle the gateway and the chat are
pointed at. **It must hold the public roots _plus_ Caddy's local root**, in
that order, not the local root alone.

A bundle containing only the Caddy root is exactly the shape that makes
internal fetches work and every public-TLS call fail with
`CERTIFICATE_VERIFY_FAILED` — found live as "chat login fine, upstream
provider dead". The installer builds it that way (public roots from the Caddy
image, then the live proxy root, de-duplicated) and re-asserts it _after_ the
last bring-up, because a `up` that recreates the proxy on a fresh
`caddy-data` volume mints a **new** root behind the old bundle's back.

Both consumers read the bundle at process start, so a rebundle is followed by
a restart of the gateway and the chat. This is not specific to the `/code`
panel, but a deployment that first meets it while adding the relay will meet it
as "pairing cannot reach the identity provider".

## The image is built from source, and pinned

There is no published relay image. `deploy/code-relay/fetch.sh` clones
`getpaseo/paseo-relay` and checks out one verified commit; re-running it is a
no-op when that commit is already checked out, which is what lets the installer
call it on every run without leaving a dirty tree.

The pin is also how protocol churn is managed: the project warns that its
internal protocol may change without notice. Re-verify on upgrade, and never
float to a branch. Cerea pins the SDK to match — `PASEO_SDK_VERSION` in
`src/lib/server/codeDaemon.ts` — and refuses a daemon whose reported version
differs in the minor rather than guessing at message shapes.

## What Cerea stores, and what it does not

Cerea persists **pairing records**, in the `codeDevices` collection: a
name, the daemon's `serverId` (the relay's route key, stored as `daemonId`),
its Curve25519 public key, and an owner. It also keeps the **files a person
attaches** to an agent message, in chat's own attachment store (next
section), so they still render after a reload. Everything else that is live —
workspaces, sessions, transcripts, the code itself — stays on the agent's
machine.

That is why revoking a device is a row deletion plus its attachments, and
nothing more: without the pairing, the machine is unreachable from here, and
nothing could authorize reading those files again.

Every row is scoped to one person (`userId`, or `sessionId` for an anonymous
session), and every `/code` endpoint filters on that scope. The relay is
identity-blind — it bridges WebSocket sessions and never sees a token, a
password or plaintext content — so Cerea has to broker pairing itself.

## Attachments: what a surface uploads, keeps and renders

The images and files a person sends an agent live in **chat's attachment
store**: the same GridFS bucket (`files`), the same writer, the same limits
and the same once-at-upload document extraction as a chat message. There is
no second store. Only the owner tag differs. A chat file is tagged with its
conversation id; an agent file is tagged with an **owner key**:

```
code:<deviceId>:<sessionId>
```

`deviceId` is the `codeDevices` row (24 hex characters). `sessionId` is
whatever id your backend gives the session, `[A-Za-z0-9_.:~-]{1,200}`, and
nothing interprets it. The store itself (`src/lib/server/files/attachmentStore.ts`)
is surface-agnostic: any key of the form `<surface>:<rest>` works. A
conversation id never contains a colon, so an owner key can never reach a
chat's files, and chat's routes can never reach an owner-keyed file.

Nothing here depends on the agent transport. The contract is only the key and
a `messageId` that you choose.

### 1. Upload before you send

Pick a `messageId` for the outgoing message (for example the client message
id you will hand the agent), then upload its files:

```
POST /api/v2/code/attachments/<urlencoded key>
multipart/form-data: messageId=<id>, files=<File> (repeat, at most 10)
→ superjson { files: MessageFile[] }
```

The rules:

- **Limits.** 10 MB per file (`MAX_ATTACHMENT_BYTES`, chat's limit), which
  answers 413. The declared type must match `AGENT_ATTACHMENT_MIME_ALLOWLIST`
  (chat's text and document lists, png/jpeg/gif/webp, and chat's long-paste
  type `application/vnd.chatui.clipboard`, which a transport should treat as
  `text/plain`). Anything else answers 400.
- **Documents.** PDFs and office files are extracted once, at upload, through
  the gateway and billed to the caller, exactly as in chat. The returned
  `MessageFile.extracted.value` is the sha of the markdown.
- **Ownership.** The key's device must be one of the **caller's paired**
  devices. Somebody else's device, or one that does not exist, answers 404;
  a pending device answers 409; a malformed key answers 400.

From the browser, `uploadComposerFiles(endpoint, messageId, files)` in
`$lib/utils/composerFiles` does this and throws the server's message on
refusal.

### 2. Keep the `MessageFile` references

Each `MessageFile` is `{type: "hash", value: <sha256>, mime, name,
extracted?}`, the same shape as a chat message's `files`. Put them on the
user message you render. After a reload you can get them back from either
side:

- **Server** (for example your bridge, when it replays a user frame):
  `findAttachments(key, messageId)` from `attachmentStore.ts`. It returns the
  same `MessageFile[]`, in upload order, with extracted text folded in.
- **Browser**: `GET /api/v2/code/attachments/<key>?messageId=<id>`, which
  returns superjson `{ files: MessageFile[] }`.

To hand bytes to the agent, the server calls `readAttachment(sha, key)`,
which returns the base64 value and the sniffed mime.

### 3. Render them

`ChatMessageColumn` and `ChatMessage` take an optional `fileBaseUrl`, which
`UploadedFile` uses for user files as `<fileBaseUrl>/<sha>`. Pass:

```ts
fileBaseUrl = `${base}/api/v2/code/attachments/${encodeURIComponent(key)}`;
```

That route (`GET …/<key>/<sha256>`) makes the same device check, then serves
the bytes with chat's headers: `Content-Disposition: attachment` and a
sandbox CSP. An `<img>` still displays it; opening it in a tab downloads it.
Leave the prop unset on chat. Chat's page-relative
`/conversation/<id>/output/<sha>` is the default and has not changed.

### The composer pieces (M2a)

Chat's attachment affordances are reusable pieces, and each takes your own
MIME allowlist:

- **picking**: `ChatInput`, with `mimeTypes` set and a bindable `files`. An
  empty `mimeTypes` hides the button, which is what `AgentComposer` does
  today;
- **pasting**: `pastedAttachments(clipboardData, {mimeTypes, directPaste})`,
  which turns a long paste into a clipboard chip and filters pasted files;
- **dropping**: `FileDrag` (`$lib/utils/fileDrag.svelte`) on
  `<svelte:window ondragenter ondragleave>`, plus `FileDropzone` with
  `bind:onDrag={drag.active}`;
- **chips**: `ComposerFileChips`, with a bindable `files`.

`ChatWindow` wires the same pieces for chat.

### Cleanup

`DELETE /api/v2/code/devices?id=` deletes every file under `code:<deviceId>:`
after it deletes the row (`deleteCodeDeviceAttachments`). Deleting one
session's files is `deleteAttachments(key)`. Nothing calls that yet, so call
it when your backend deletes a session. The deletions match on
`metadata.conversation`, never on the filename, and a prefix must end at a
`:`, so `code:abc:` never matches `code:abcdef:…`.

## The pairing paths

Two, and the second is the fallback for the first.

**Machine self-pairing** — `POST /api/v2/code/enroll/machine`. The setup script
on the agent machine calls it with the access token its enrollment minted at
the deployment's identity provider. That route is bearer-only and exempt from
the generic bearer handling in the hook: there is no session cookie on a
headless box. Cerea validates the token by calling userinfo (an expired,
revoked or forged bearer fails there, and the claims come from the issuer
rather than from the caller), maps `sub` → `hfUserId` exactly as the login
callback does, then probes the daemon through the relay before writing
anything. Re-running it updates the row in place — one machine is one row.

A token that identifies somebody this chat has never seen answers **404, not
401**: the credential is fine, the account is what is missing. Log into the
chat once first.

**Manual paste** — `POST /api/v2/code/enroll` with `start` then `claim`. The
panel names the machine and gets a single-use code; the person runs `paseo
daemon pair` on the machine and pastes the printed link into the dialog. The
pending row expires after fifteen minutes.

Both paths end at the same proof: Cerea connects to the daemon through **this
deployment's** relay and completes the encrypted handshake. A daemon that
answers with a different `serverId` than the offer claimed is refused outright
— that is not the machine the offer described, and no row may be written for
it.

## What the browser may ask the daemon to do

Never directly: the browser talks to Cerea, Cerea talks to the relay. The
forwarder (`src/routes/api/v2/code/[...path]/+server.ts`) maps each allowed
browser path onto exactly one typed SDK call, and every call carries
`?device=`, whose row is checked against the caller before anything dials.

Deliberately **not** offered, and why:

- **timeline streams** — the SSE bridge at `agents/[id]/stream` owns the
  subscription, and a browser-direct stream would bypass the pairing scope it
  enforces;
- **pairing hooks on the daemon** — Cerea brokers pairing itself, because the
  relay cannot tell whose daemon is whose;
- **terminals, worktree management, checkout operations, daemon config** — the
  panel drives agents, not machines.

## When it does not work

| Symptom                                                       | Where to look                                                                                                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no Agents switch in the sidebar                               | `CODE_AGENTS_ENABLED` is not exactly `"true"`, or the person is not signed in                                                                                                     |
| `/code` answers 404                                           | same flag; the route gates on it independently of the sidebar                                                                                                                     |
| the panel loads, every device reads as unreachable            | the relay container, or `CODE_RELAY_URL`. Cerea's 502 says "could not be reached through the relay"                                                                               |
| pairing fails at the handshake                                | the daemon is not running, or it is dialling a different relay than this deployment's. The daemon's configured endpoint and `<PUBLIC_ORIGIN>/ws` must be the same relay           |
| `/ws` 404s from outside                                       | the Caddy route. On `edge`, check for the `# installer: relay /ws route` marker in `Caddyfile.netbird` — and restart the proxy if it is there but was appended to a running stack |
| a device pairs, then every call 502s with a version complaint | SDK/daemon minor skew. Match `PASEO_SDK_VERSION`; the refusal is deliberate                                                                                                       |

The relay's own health is a liveness probe on `/health` (not `/ready`, which
also reports drain state and would restart a draining relay).
