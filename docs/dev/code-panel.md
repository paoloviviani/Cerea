# The /code panel and agent sessions

## The chat drives agent sessions (ADR 0106)

The chat can start, prompt and read coding sessions on the user's own machines; the decision record
is `docs/adr/0106-chat-drives-agent-sessions.md` in the ai-stack repository, the operator view is
"Driving agents from the chat" in `docs/code-panel.md`. Where it lives:

- `src/lib/server/textGeneration/builtinTools/agentSessionTools.ts`: the four builtins
  (`agent_sessions`, `agent_start`, `agent_send`, `agent_read`) and `runAgentSessionTool`, the one body
  behind both the tool's `execute` and the approval click (`mcp/resumeElicitation.ts`, which re-runs
  an approved `agent_start`/`agent_send` as the person). Enablement is `agentSessionsFor`, resolved in
  `runMcpFlow`. Approval gating of the two acting tools is in `toolInvocation.ts`; `agent_read` is in
  `EXTERNAL_BUILTIN_TOOLS` (`untrusted.ts`).
- `src/lib/server/code/agentSessions.ts`: the session-starting code **shared** with the scheduled
  executor (`scheduleAgentExecutor.ts`): create/reuse, mode/model, the permission word, the prompt.
  Change it there so the two cannot drift.
- `src/lib/server/projectAgentProfiles.ts` and `routes/api/v2/projects/[id]/agent-profile`: a user's own
  default target per project (`projectAgentProfiles`, unique on project and user), registered in
  `userKeyedCollections.ts` and deleted with the project.
- The shapes both sides share: `src/lib/types/AgentSession.ts` and `MessageAgentSessionUpdate`.
- Rules to keep: only the caller's own devices (any other id reads as not existing); the 7-day
  sign-in refusal; `agent_send` never changes a session's permission word; every start and send
  writes an audit row with the conversation id.

## The /code Agents panel

`agent/PROTOCOL.md` is the wire protocol, binding for both this app and the Go
agent, `galopin`, which lives in this repository as `agent/`. Coding agents run on
**the person's own machine**, supervised by one binary that dials **out** to
this deployment over WSS with its own OIDC credential — no relay in between,
nothing capability-bearing at rest in Cerea. `docs/code-panel.md`
is the operator guide and `docs/agent-machines.md` the user's getting-started page and
`docs/agent-machines-reference.md` the user's reference (it also
covers building, installing and running `galopin` itself); what matters when
changing the code:

- **`CODE_AGENTS_ENABLED` must be exactly `"true"`.** Off hides the
  Chats/Agents switch, 404s `/code` in `+page.server.ts`, and refuses the
  pairing endpoints as a backstop.
- **The machine link is a raw WebSocket upgrade, not a SvelteKit route.**
  `server.js` (production) and `vite.config.ts`'s dev plugin both forward
  `GET /api/v2/code/machine` upgrades to a function the app registers on
  `globalThis[Symbol.for("cerea.machineUpgrade")]` from `initServer()`
  (`src/lib/server/code/machineServer.ts`). It never reaches
  `hooks/handle.ts` at all.
- **The bearer is validated locally, never via userinfo.**
  `src/lib/server/code/machineAuth.ts`: JWKS from the issuer's discovery doc
  (cached), `iss`/`aud`/`azp`/`exp` checked, `sub` mapped to a Cerea user the
  same way the login callback does. No user → the upgrade is refused with a
  plain HTTP 403 before it completes.
- **The registry (`src/lib/server/code/machines.ts`) is a plain in-process
  `Map`, lost on restart.** `MachineLink` is cheap to construct for any
  device id — every method looks the live connection up at call time, so a
  link for an offline machine rejects instantly (`unavailable`), never hangs. Pairing happens on first `hello` (a `pending` row); a browser
  confirm flips it to `paired` and pushes a `status` frame down the socket —
  a fresh human approval of every new machine. Revoke tombstones the row
  (`status: "revoked"`) rather than deleting it, so a reconnect under the
  same `machineId` is refused.
- **The browser never reaches the machine directly.** Every call goes to
  Cerea, through `MachineLink`. `routes/api/v2/code/[...path]/+server.ts` is
  the forwarder, and its allowlist maps each permitted browser path to
  exactly one typed op (spec §6). Timeline streams, pairing hooks and
  anything beyond one backend's sessions are deliberately absent; read that
  file's header before adding anything.
- **The SSE bridge is cursored on the machine's own `epoch`/`seq`**
  (`agents/[id]/stream/+server.ts`), not an invented replay counter — an
  epoch change (the machine's process restarted) sends a `reset` frame down
  the _same_ update channel `consumeAgentUpdates.ts` already parses, and the
  connection's listeners migrate across a machine reconnect
  (`machines.ts`'s `onHello`) rather than going silently stale.
- **The bridge ends its history replay with a `historyDone` frame**
  (snapshot + seam, before the live tail), and, just before it, a
  `historyMeta` frame when the snapshot was paged (below). Both are
  Cerea-internal — no machine ever sends them, PROTOCOL.md does not know them —
  and the agent view gates its
  first paint on it (`ChatMessageColumn`'s `historyPending`): the transcript
  folds behind a loading skeleton with the turns unmounted, then mounts once
  and lands at the bottom before paint. Folding into the rendered list was
  the real cost of opening a long session (1,000 messages: ~2 minutes to
  first content, measured); the gate also makes the landing independent of
  whatever the reader did while waiting, because a skeleton cannot scroll.
- **A long session arrives as its newest page, and older pages load on
  scroll.** When the machine advertises `historyPaging`, the bridge asks
  `session.sync` for only the newest 40 messages (`SNAPSHOT_PAGE_LIMIT` in
  `agents/[id]/stream/+server.ts`) and sends `{type:"historyMeta", hasMore,
before?}` ahead of `historyDone`; without the capability (an older galopin,
  or an ACP backend) the snapshot is whole and no frame is sent, so nothing
  pages. `AgentView.svelte` keeps `historyHasMore`/`historyBefore` from it and,
  when the reader scrolls within about a screen of the top, fetches
  `GET v1/agents/:id/history?before=&limit=` (the forwarder's `session.history`
  route, pages of 40, converted by the same per-message code as the snapshot)
  and prepends the page through the column's anchored prepend, so the visible
  message does not move. One fetch at a time; one started before a rebuild
  (rollback, new epoch) is discarded. The head of the list says "Loading
  earlier messages…", "Couldn't load earlier messages. Retry" or "Start of the
  session".
- **Recent sessions reopen from an in-memory cache, then refresh.**
  `stores/agentTranscriptCache.ts` keeps the last 8 sessions (newest 400
  messages each, plain snapshots, memory only, never localStorage) saved on
  leaving a session and at `historyDone`. A hit renders at once with no
  skeleton, folds the fresh replay into a separate `$state` array
  (`staging`), and swaps it in at `historyDone` through the column's
  `replaceWithAnchor` (the very array the fold keeps appending to). Until the
  swap the copy is display-only: no paging, retry/edit or fork, and a
  permission card refuses to answer. A rollback/undo, a new epoch, deleting
  or archiving the session, and sign-out invalidate it.
- **A provider retry is shown, not hidden.** opencode's `retry` status
  (PROTOCOL.md §7: `retry {attempt, message, next?}`, also `Transcript.retry`
  in a snapshot) becomes a running turn carrying `retry` (`machineTimeline.ts`
  `statusToTurnState`), and `RetryNotice.svelte` renders "Retrying — <provider
  message> (attempt N, next try in S s)" under the transcript while the turn
  runs, so a rate limit does not read as a hang. A galopin without the field
  shows a plain running turn.
- **Tool-output images are references, never bytes on the stream.** A tool
  part lists `attachments` (`sha256`, `mime`, `size`); `machineTimeline.ts`
  maps them to `{type:"image", url}` blocks pointing at the forwarder's
  `v1/agents/:id/attachments/:sha256` route, which calls `session.attachment`
  and judges the bytes itself (`server/code/toolImages.ts`: magic numbers, not
  the claimed mime; ≤50 megapixels; ≤8 MiB; must hash to the sha). Nothing is
  persisted in Cerea. SVG is never inline.
- **The panel owns mutations, the pane owns display.** `CodeNavTree.svelte` has
  every dialog and every write; `CodePanel`/`AgentView` render whatever
  `?device=&ws=&agent=` names, and a new address remounts the view. Removals
  confirm, then redraw from the machine's answer — never an optimistic
  splice, because the machine owns the listings. The paired-device list
  itself is one shared poll (`$lib/stores/codeDeviceList.svelte.ts`) — do not
  reintroduce a second one alongside it.
- **The machines and sessions list outlives the tree (stale-while-revalidate).**
  The device list (`codeDeviceList`) and each device's workspaces and sessions
  (`stores/codeTreeCache.svelte.ts`) are module state, so returning to `/code`
  draws the last list in the first frame, with no loading state. Entering the
  panel re-reads only what is older than the 8 s poll interval
  (`CODE_LIST_STALE_MS` / `CODE_CACHE_STALE_MS`); focus and app-resume re-read at once; the 8 s poll
  runs while the panel is open. Every read folds in place
  (`utils/reconcileById.ts`: unchanged rows keep their objects, so keyed rows
  do not re-render). A failed tree read keeps the rows and flags the device
  "Offline." above them. The cache is per person: `NavFooter`'s sign-out calls
  `clearCodePanelCache()` beside the drafts, `bindCodeCacheOwner(user.id)`
  empties it on an account switch, and a stale sign-in drops it.
- **The sidebar's Projects tree outlives the branch (stale-while-revalidate).**
  `ProjectsBranch` unmounts whenever the Agents view is shown, so its projects,
  per-folder chats and open/closed state live in
  `stores/projectsTreeCache.svelte.ts`, not in component state. Returning to
  Chats draws them in the first frame with no loading row; a read runs only
  when older than 8 s (`PROJECTS_CACHE_STALE_MS`) and folds in place
  (`utils/reconcileById.ts`). A failed read keeps the rows. Only the caller's
  own chats are in it (the endpoints list nothing else). `NavFooter`'s sign-out
  calls `clearProjectsCache()`; `bindProjectsCacheOwner` empties it on an
  account switch and never binds on the server.
- **The agent view is the chat's own machinery.** `ChatMessageColumn`,
  `ChatInput`, the approval card, the shared side pane. That is what makes
  live updates arrive by construction; a bespoke stack here would be a second
  thing to keep working.
