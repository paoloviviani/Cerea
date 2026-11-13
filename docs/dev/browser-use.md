# Browser use: the `browse` tool (ADR 0116)

Code: `src/lib/server/browser/` (the contract, the loop, the policy), `builtinTools/browseTool.ts`
(the chat's tool), `components/chat/BrowseCard.svelte`. Off unless `CHAT_BROWSER_ENABLED` is
exactly `true`; user docs in `docs/browser-use.md`. What is not obvious:

- **The runtime is a machine's `cerea-browser` MCP server**, reached through the local-connector
  path (`mcpRuntimeCall`). `isBrowserRuntimeServer` keeps it out of the connector list, the
  settings machine view and `resolveLocalSelection`. `browseMachinesFor` finds machines that are
  online with a `ready` runtime; `browse` is offered only then.
- **The contract is `contract.ts`.** `extract` is model-free (tables, lists, text); mapping onto an
  `output_schema` is one extra model call in the loop. A grant is `{index, id, digest, exp, sig}`:
  `digest` is `actionDigest` (kind, ref, value, page URL without fragment, element name; test
  vectors in `classifier.spec.ts`) and `sig` an HMAC under a per-device key (`grants.ts`, sealed on
  the device row, fetched by the runtime with the machine call `browser.key`, PROTOCOL.md 10.7).
  Change the digest, the signature or the key call and the runtime package together.
- **One task per machine** is a lease on the device row (`lease.ts`), renewed while running.
  Browse asks also list in the Needs-you inbox (`/api/v2/browse/approvals`) and push on the
  `permission` event. Downloads are kept only when the grant that produced them is one the task
  issued (M1); sites are compared by `tldts` with private domains, hosts in one normal form.
- **Classify, then decide** (`classifier.ts`, `policy.ts`): read and input run, commit asks even under
  always-allow, a deny-listed site refuses everything, an allow-listed one lets commits through, and
  an unattended run refuses commits. Unknown elements are commits (fail closed). A batch is cut
  into runs at every action that can change the page, and the element map is refreshed between.
- **An approval waits in process.** The sub-agent loop cannot be parked, so `approvals.ts` writes a
  plain `mcpElicitations` row (no `pending`, so the answer endpoint has nothing to resume), emits
  the chat's own approval card with a `browse` payload, and polls the row like a 2025-era MCP
  prompt (`awaitAnswer`). The loop's wall clock excludes the wait. A restart mid-wait ends the task.
- **Downloads** are written as conversation attachments first (`writeAttachment`: where the privacy
  pipelines read a document and mark a withheld one), then stored as deliverables so the document
  tools and the sandbox see them. A withheld file is never stored as a deliverable.
- **Which computer (`machineChoice.ts`) and Open browser (`open.ts`, C109).** Rules, never the
  model: the conversation's computer (`Conversation.browserDeviceId`, else the device holding its
  kept page), then the user's default (`CodeDevice.browserDefault`, one per user, cleared when the
  device is revoked), then the only ready computer, else a "Which computer?" question
  (`computerAsk.ts`: an `mcpElicitations` row, `server: browse_computer`, rendered by the generic
  `ElicitationForm` and listed in the Needs-you inbox by `/api/v2/browse/approvals`). A remembered
  computer that is not ready is "<name> is offline", never a fallback. `machine` is only a hint,
  used when it is the exact name of a ready computer, the user's latest message names it as a whole
  word, and nothing above decides (never unattended). `open` is a
  runtime tool (contract + `browser-runtime/`, synced both ways): it opens a page of its own and
  returns a resume token; `openBrowserPage` ties it to a conversation through `kept.ts` (so the
  next browse resumes it with no `use_tab`), takes the machine's lease ("busy" while a task runs)
  and checks the deny list. Endpoints: `/api/v2/browser/{open,computers,default}`.
- **A task that adopted a tab stays on it** (`loop.ts`): a cross-site move is denied unless the goal
  names the site, `use_tab` on an adopted tab is answered without asking, and a tab with no title
  is named by its host. The runtime drops a page after a failed action only when it stays silent
  for 8 s, never for a stale ref (that made later steps start "from about:blank").
- `browse` is in `EXTERNAL_BUILTIN_TOOLS` and not in `SUBAGENT_BUILTIN_TOOLS`. Its card is a
  `MessageBrowseUpdate`, replaced by `uuid` like a sub-agent's.
