# The `/code` panel: operating it

!!! info "For operators"

    Deploying and running the Agents panel; people using it want [Agent machines](agent-machines.md).

The Agents panel drives **coding agents running on people's own machines**
from the chat's sidebar. The agent (opencode, or any ACP agent) runs on the
person's machine under **galopin**, a single binary built from this
repository's `agent/`. galopin dials **out** to the deployment over WSS and
authenticates with its own OIDC credential. The deployment runs no model and
stores no code for it.

This page is for operators. The person using the panel wants
[Agent machines](agent-machines.md) instead.

## What gets deployed

Nothing extra. The machine link is one WebSocket endpoint
(`GET /api/v2/code/machine`), served by the chat process itself. There is no
relay, no extra container and no extra port. The chat also serves the galopin
binaries and their checksums at `<base>/galopin/`, with an installer at
`<base>/galopin/install.sh`.

## Turning it on

In cerea-deploy: `./configure --agents` at install time, or
`./configure --set CODE_AGENTS_ENABLED=true` on an existing install, then
`docker compose up -d`.

| Variable                 | What                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `CODE_AGENTS_ENABLED`    | `true` shows the Agents switch and serves `/code`; anything else hides it and `/code` answers 404 |
| `CODE_TERMINAL_ENABLED`  | `true` allows browser terminals on machines that also allow them (below); off by default          |
| `CODE_MACHINE_ISSUER`    | the issuer a machine's token must come from; defaults to the chat's own (`OPENID_PROVIDER_URL`)   |
| `CODE_MACHINE_AUDIENCE`  | the audience a machine's token must carry; default `pystino-api`                                  |
| `CODE_MACHINE_CLIENT_ID` | the client a machine's token must be issued to; default `opencode-enrollment`                     |

The last three only need setting when machine tokens come from somewhere
unusual; cerea-deploy's defaults match its bundled Authelia.

## Setting up a machine

On the machine, with `<origin>` the deployment's origin:

```sh
curl -fsSL <origin>/chat/galopin/install.sh | sh
galopin enroll --issuer <origin>/authelia --gateway <origin> --cerea <origin>/chat \
  [--allow-terminal] [--allow-auto-accept] [--workspace-root PATH] …
galopin run
```

The installer checks the binary against the deployment's `SHA256SUMS` and
refuses a mismatch. The machine then appears in the panel as **pending**
until its owner confirms it.

## Two vetoes: the machine's and the deployment's

The machine's owner decides at enroll time what the machine allows. These
flags are stored on the machine, and the chat can never loosen them over the
link:

| Flag                                         | Default              | Allows                                                |
| -------------------------------------------- | -------------------- | ----------------------------------------------------- |
| `--allow-terminal`                           | denied               | a real shell from the browser                         |
| `--max-terminals N`                          | 8                    | concurrent terminals                                  |
| `--allow-auto-accept`                        | denied               | running the model's commands without asking each time |
| `--workspace-root PATH`                      | unrestricted         | workspaces only under this path (repeatable)          |
| `--allow-free-models`                        | denied               | models from providers other than the gateway's        |
| `--allow-opencode-provider`                  | denied               | opencode's built-in providers next to the gateway's   |
| `--no-files`                                 | read-only browsing   | no file explorer at all                               |
| `--file-deny GLOB`, `--no-default-file-deny` | built-in secret list | what the explorer redacts                             |

The owner can tighten them later without re-enrolling (`galopin policy set
--no-terminal`, for example); loosening needs a new enrollment.

**The terminal needs both vetoes lifted.** The machine must be enrolled with
`--allow-terminal`, and the deployment must set `CODE_TERMINAL_ENABLED=true`.
Opening a terminal also requires a sign-in to Cerea within the last 12 hours.
An open terminal is an ordinary shell running as the machine's owner:
**anyone who controls that person's Cerea session can run commands on the
machine**, with no model and no permission rule in between. Enable it only
where that is acceptable. Both sides record terminal opens and closes, never
their content.

## How machines are trusted

- **Tokens are checked locally.** A machine's access token is verified
  against the issuer's keys (JWKS): the issuer, the audience, the authorised
  client and the expiry must all match, and ID tokens are refused. The
  token's subject must belong to someone who has signed in to this chat; if
  not, the connection is refused.
- **A person confirms each machine.** The first connection creates a
  _pending_ device. Nothing is sent to it until its owner clicks **Confirm**
  in the panel. **Reject** and **Revoke** tombstone the device: that machine
  id is refused from then on, its connection is closed, and galopin revokes
  its own refresh token and exits.
- **The browser never talks to a machine.** Every browser request goes to
  the chat, which maps each allowed path onto exactly one machine operation,
  after checking that the device belongs to the caller.

## What the chat stores

- **Pairing records** (the `codeDevices` collection): a name, the machine id,
  the token subject and issuer it last used, the capabilities and policy it
  reported, and its credential health. None of it can reach a machine; only
  a live connection can, and those are held in memory.
- **Files attached** to agent messages, in the chat's attachment store, so
  they still show after a reload. They are deleted when the device is.

Everything else (workspaces, sessions, transcripts, the code) stays on the
machine. That includes **images a tool produced** (a browser tool's
screenshot, an image the agent read): the panel fetches each from the machine
whenever it is shown, and the chat keeps no copy.

## What the panel does

An affordance shows only when the session's backend reports the capability,
and the machine's policy can still refuse it.

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

### Tool images (the `toolImages` capability)

When a tool call produces an image, its card shows it under "Output". The
machine lists the image on the tool part (a sha256, a type and a size) and
keeps the bytes: galopin holds up to 64 MiB of recent tool images, and for
opencode an older one is re-read from opencode's own history. A person's
browser asks the chat for the image, the chat asks the machine, and the answer
is cached in the browser only.

- **Only PNG, JPEG, GIF and WebP are shown, inline as images.** SVG is never
  displayed inline, whatever the machine calls it.
- **The chat does not take the machine's word for the type.** It checks the
  file's own header, refuses anything over 8 MiB or past about 50 megapixels
  (a tiny file can decompress to gigabytes), and refuses bytes that do not
  match the checksum the tool part listed. Seeing a broken image usually
  means the machine no longer has it: an ACP agent keeps images in memory
  only, so a galopin restart loses them.
- Up to 8 images are shown per tool call. An image the agent saved as a file
  is the file explorer's, not this.

### Slash commands (the `commands` capability)

The machine lists each workspace's slash commands (`backend.commands`):
name, description, where the definition lives (the agent's own `init`/
`review` are `builtin`; a name only the workspace list reports is
`project` — repository code), whether its template expands shell, the
exact snippets it would run (at most ten, each truncated), the `@path`
files it reads, and a hash of the template. **The template itself never
crosses the link** — the snippets and the hash are what a person confirms
against.

`session.command` runs one behind the machine's gates, each refused before
anything runs and each audited in the machine's own `audit.log` as
`command {name, origin, shell, decision}` — never the arguments, never the
expanded text:

- unknown name → `not_found` (the list is re-read at run time, never
  trusted from an old menu);
- the panel's confirmation carried a `templateHash` that no longer matches
  → `conflict` (the definition changed since it was reviewed);
- `commandShell: denied` (the default) and the template expands shell — or
  its shell behaviour is unknown (MCP prompts, ACP commands) → `forbidden`;
- an `@path` ref matching `fileDeny` → `forbidden`;
- a command pinned to a non-gateway model with `allowFreeModels` denied →
  `forbidden` (the same gate `session.setModel` applies);
- a command naming a more permissive agent while the session sits in a
  more restrictive mode → the session's mode is sent instead and the
  command's agent ignored; a `subtask` command in that spot is refused
  outright (it would run unsupervised in the other agent).

The capability is probed, never versioned: opencode advertises `commands`
only when its own `GET /doc` lists the operation (cached per process,
re-probed on restart). Cerea maps a 404 to "panel commands only".

The panel's first run of a project or shell-expanding command opens a
confirmation sheet (snippets, file refs, "running a project command is
running repository code"), remembered per device in `localStorage` keyed
by the template hash; a later run whose hash differs answers the 409 above
and the sheet re-asks.

A machine can run an ACP agent instead of opencode (`galopin run --backend acp
--acp-command "<agent>"`): Gemini CLI, Claude Code or Codex through their ACP
adapters, or `opencode acp`. Those report fewer capabilities (no usage,
compaction or subagents), and the panel hides the matching controls.

## When it does not work

| Symptom                                                | Where to look                                                                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no Agents switch in the sidebar                        | `CODE_AGENTS_ENABLED` is not exactly `"true"`, or the person is not signed in                                                                                                                                                |
| `/code` answers 404                                    | same flag; the route gates on it independently of the sidebar                                                                                                                                                                |
| a machine never appears, even `pending`                | its bearer is failing local validation — check `CODE_MACHINE_ISSUER`/`CODE_MACHINE_AUDIENCE`/`CODE_MACHINE_CLIENT_ID` match what the enrollment minted, and that the machine's `sub` has signed into this chat at least once |
| a machine appears `pending` forever                    | nobody has clicked Confirm in the Agents panel yet                                                                                                                                                                           |
| every call to a paired machine answers "not connected" | the machine's process is not running, or its WSS dial to this origin is failing (check its own logs)                                                                                                                         |
| a machine that was working now gets `4401` closes      | its access token stopped renewing — re-run its enrollment                                                                                                                                                                    |
| a terminal will not open                               | the deployment lacks `CODE_TERMINAL_ENABLED=true`, the machine was not enrolled with `--allow-terminal`, or the person's last sign-in is older than 12 hours                                                                 |

## For developers

The wire protocol between the chat and galopin is `agent/PROTOCOL.md`.

### Attachments: what a surface uploads, keeps and renders

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

#### 1. Upload before you send

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

#### 2. Keep the `MessageFile` references

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

#### 3. Render them

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

#### The composer pieces

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

#### Cleanup

`DELETE /api/v2/code/devices?id=` deletes every file under `code:<deviceId>:`
after it tombstones the row (`deleteCodeDeviceAttachments`). Deleting one
session's files is `deleteAttachments(key)`. Nothing calls that yet, so call
it when your backend deletes a session. The deletions match on
`metadata.conversation`, never on the filename, and a prefix must end at a
`:`, so `code:abc:` never matches `code:abcdef:…`.
