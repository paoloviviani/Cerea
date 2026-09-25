# The `/code` panel: deploying it

The Agents panel drives **coding agents running on people's own machines**
from the chat's sidebar. Nothing about it runs model inference here, and
nothing about it stores code here: the agent is `opencode`, supervised by a
one-binary agent (`galopin`, this repository's `agent/`) on the person's own
machine, which dials **out** to this deployment over WSS and authenticates
with its own OIDC enrollment credential — no relay, no daemon, no paseo (see
`agent/PROTOCOL.md` for the wire protocol).

This page is for whoever deploys it. The person sitting in front of the panel
wants [Agent machines](agent-machines.md) instead.

## What actually gets deployed

Nothing extra. The machine link is one WebSocket endpoint
(`GET /api/v2/code/machine`) served by this same chat process — `server.js`
upgrades it below SvelteKit's request handling (`src/lib/server/code/machineServer.ts`).
There is no relay container, no pinned external image, and no published port
beyond the one this deployment already exposes.

## Turning it on

At install time, `./configure --agents` in cerea-deploy. On an existing
deployment, run `./configure --set CODE_AGENTS_ENABLED=true` and then
`docker compose up -d`. The stack side is described in cerea-deploy's README.
Machines are
set up with `galopin enroll` and `galopin run` (this repository's
`docs/agent-machines.md`). There is no relay and nothing else to deploy.

The chat reads:

| Var                      | What                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODE_AGENTS_ENABLED`    | `"true"` to show the sidebar switch and serve `/code`; off (including unset) 404s the route and hides pairing, since a route that only errors without a machine is worse than none                                  |
| `CODE_MACHINE_AUDIENCE`  | the `aud` a machine's bearer must carry; defaults to `pystino-api`                                                                                                                                                  |
| `CODE_MACHINE_CLIENT_ID` | the `azp`/`client_id` a machine's bearer must carry; defaults to `opencode-enrollment`                                                                                                                              |
| `CODE_MACHINE_ISSUER`    | the OIDC issuer a machine's bearer must be signed by; defaults to `OPENID_PROVIDER_URL`, so a normal deployment sets nothing extra here — separate only for a test harness pointing machine tokens at a mock issuer |

## Local JWT validation, not userinfo (review C1)

A machine's bearer is validated **locally** against the issuer's own JWKS
(`src/lib/server/code/machineAuth.ts`): `iss` exact match (trailing slash
normalized), `aud` contains `CODE_MACHINE_AUDIENCE`, `azp`/`client_id` equals
`CODE_MACHINE_CLIENT_ID`, `exp` in the future, and the token must not be an ID
token. Userinfo is never called — it proves nothing about audience or
authorized party, which is exactly the hole the old `enroll/machine` endpoint
had.

The token's `sub` maps to an existing Cerea user the same way the OIDC login
callback does (`hfUserId`). No user → the WebSocket upgrade is refused with a
plain HTTP 403 before it ever completes.

## What Cerea stores, and what it does not

Cerea persists **pairing records only**, in the `codeDevices` collection: a
name, the machine's own id (`machineId`, from `X-Pystino-Machine-Id`), the
OIDC `sub`/`iss` it last connected with, the backends and policy it reported
in `hello`, and its last-known credential health. Nothing here is a bearer
capability — the only thing that can reach a machine is a live socket held in
an in-process registry (`src/lib/server/code/machines.ts`), lost on restart, and a
Mongo dump of the collection yields names and ids only (review C4).

That is why revoking a machine tombstones the row (`status: "revoked"`)
rather than deleting it: a reconnect under the same `machineId` is refused
from then on, and the live socket (if any) is closed with WebSocket code
`4403`. Its stored attachments (next sections) are deleted with it.

Besides the pairing rows, Cerea keeps the **files a person attaches** to an agent
message, in chat's own attachment store, so they still render after a reload.
Everything else that is live (workspaces, sessions, transcripts, the code itself)
stays on the machine.

## Pairing: connect, then confirm

A machine with a valid bearer and an unrecognized `machineId` creates a
`pending` row on its first `hello` frame — the socket stays open, but nothing
is forwarded to it. The panel lists pending machines with **Confirm/Reject**;
Confirm is the fresh human approval that a phished device-code grant alone
never reaches (review C2), and pushes a `status: "paired"` frame down the
socket. Reject is the same tombstoning action as revoking a paired machine.

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
after it tombstones the row (`deleteCodeDeviceAttachments`). Deleting one
session's files is `deleteAttachments(key)`. Nothing calls that yet, so call
it when your backend deletes a session. The deletions match on
`metadata.conversation`, never on the filename, and a prefix must end at a
`:`, so `code:abc:` never matches `code:abcdef:…`.

## What the panel does

Every feature below is one or more typed machine ops (`agent/PROTOCOL.md` §6). An affordance shows only when the session's backend advertised the capability in its `hello`, and the machine's own policy (`policy.json`, set by `galopin enroll` flags, never writable over the link) is a veto the panel cannot override.

| Feature                  | What the person sees                                                                | How it works                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modes and models         | pills in the composer                                                               | Live lists (`backend.modes` / `backend.models`). Non-gateway models (anything outside `pystino/*`) are hidden unless the machine was enrolled with `--allow-free-models`. The agent filters them and reports how many it hid; Cerea filters again and answers 403 to a disallowed set or create (`src/lib/server/code/modelPolicy.ts`).                                         |
| Auto-accept              | an "Auto-accept" toggle                                                             | `session.setAutoAccept`. Offered only when the machine's policy says `autoAccept: allowed` (`enroll --allow-auto-accept`); the agent refuses it otherwise, whatever the panel sends.                                                                                                                                                                                            |
| Permissions              | chat's approval card                                                                | `permission.asked` becomes the card; Allow once / Deny become `permission.reply` once / reject.                                                                                                                                                                                                                                                                                 |
| Questions                | the SAME card chat's own `ask_user_question` uses, lifted to the composer           | `question.asked`/`question.resolved` (opencode's built-in "question" tool, the `questions` capability), each `Question` normalized to one `select` field via `AskQuestion.svelte`'s `onanswer` prop; `POST v1/agents/:id/questions/:requestId` translates accept/decline into `question.reply` answer/reject. Not offered when the backend's capability is false (ACP: always). |
| Stop                     | chat's stop button                                                                  | `session.cancel`; an abort ends the turn normally, it is not shown as a failure.                                                                                                                                                                                                                                                                                                |
| Usage and context        | a ring in the composer (`ContextMeter.svelte`)                                      | The `usage` side channel: a percentage when the model's context window is known, otherwise a token count; "Compact now" calls `session.compact`. No cost is shown: Pystino's own ledger is the spend authority.                                                                                                                                                                 |
| Changes                  | the Changes side pane                                                               | `session.diff`, which asks git for the workspace's uncommitted changes (untracked files included, capped) rather than trusting a backend's own diff, which misses files a shell command wrote.                                                                                                                                                                                  |
| Subagents                | a card at the task call that spawned it, expandable into the child's own transcript | `session.children`, each child carrying `parentToolCallId`; children are not listed as sessions of their own.                                                                                                                                                                                                                                                                   |
| Images and files         | the chat's attach picker, chips and rendering                                       | See "Attachments" above. Offered when the backend advertises `files` or `images`.                                                                                                                                                                                                                                                                                               |
| Forks                    | "Fork from here" on a finished assistant message                                    | `POST v1/agents/:id/handoff`: a new session (same machine or another of the person's paired machines, any allowed mode/model), prompted with the person's text plus, optionally, the conversation up to that turn as a `chat-history.md` attachment. The new session is titled `Fork: …` (older forks: `Handoff: …`) and says where it came from.                               |
| Retry and rollback       | ↻ on an answer, or editing a prompt (when the machine reports `revert`)             | `POST v1/agents/:id/revert {messageId}` rolls the session back to before that prompt (opencode `POST /session/:id/revert`), then the prompt (or the edited text) is sent again. The confirmation says whether files come back: opencode restores them from its snapshots in a git repository only. `POST v1/agents/:id/unrevert` undoes it before the next prompt.              |
| Workspaces and worktrees | path autocomplete in "Add workspace"; "New worktree…" on a git workspace            | `workspace.suggest` (inside the machine's `workspaceRoots`, or `$HOME` with none) and `workspace.create {worktree}` (`git worktree add`, branch and base of the person's choosing); archiving a worktree workspace can also remove the worktree.                                                                                                                                |

A machine can run a backend other than opencode: `galopin run --backend acp --acp-command "<agent>"` drives any ACP agent (opencode's own `opencode acp`, Gemini CLI, Claude Code or Codex through their ACP adapters, Pi through `pi-acp`). Such a backend reports fewer capabilities (no usage, compaction or subagents), and the panel hides those affordances.

## What the browser may ask the machine to do

Never directly: the browser talks to Cerea, Cerea talks to the machine
registry. The forwarder (`src/routes/api/v2/code/[...path]/+server.ts`) maps
each allowed browser path onto exactly one typed op (spec §6), and every call
carries `?device=`, whose row is checked against the caller before anything
is sent. An offline machine answers instantly from the registry — never a
hang (review R1).

Deliberately **not** offered, and why:

- **timeline streams** — the SSE bridge at `agents/[id]/stream` owns the
  subscription and calls `session.sync`/events directly;
- **pairing hooks on the machine** — pairing happens on connect
  (`machines.ts`), confirm/reject/revoke live in `devices/+server.ts`;
- **anything beyond one backend's sessions** (workspace roots outside the
  machine's own policy, raw backend config) — the panel drives sessions, not
  machines, and the machine's own policy is a veto the panel cannot override.

## When it does not work

| Symptom                                                | Where to look                                                                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no Agents switch in the sidebar                        | `CODE_AGENTS_ENABLED` is not exactly `"true"`, or the person is not signed in                                                                                                                                                |
| `/code` answers 404                                    | same flag; the route gates on it independently of the sidebar                                                                                                                                                                |
| a machine never appears, even `pending`                | its bearer is failing local validation — check `CODE_MACHINE_ISSUER`/`CODE_MACHINE_AUDIENCE`/`CODE_MACHINE_CLIENT_ID` match what the enrollment minted, and that the machine's `sub` has signed into this chat at least once |
| a machine appears `pending` forever                    | nobody has clicked Confirm in the Agents panel yet                                                                                                                                                                           |
| every call to a paired machine answers "not connected" | the machine's process is not running, or its WSS dial to this origin is failing (check its own logs)                                                                                                                         |
| a machine that was working now gets `4401` closes      | its access token stopped renewing — re-run its enrollment                                                                                                                                                                    |
