# The plan tool and sub-agents

Both are builtin tools (`textGeneration/builtinTools/`), offered to any chat whose
turn has tool calling on (`toolsEnabled`).

- **`update_plan`** (`planTool.ts`) persists `Conversation.plan` with a targeted
  `$set`, emits a `Plan` update, and `runMcpFlow` tail-injects the stored plan on
  the last user message each turn (`injectPlanState`) while the tool is offered.
  `ChatMessage` renders one `PlanCard` per message.
- **`delegate`** and **`research`** (`delegateTool.ts`) run `runNestedAgent`
  (`nestedAgent.ts`) on a fresh message array and return only the final answer
  (plus the pages it read, when its answer does not cite them). They are nested
  agent builtins: static definitions, bound to the turn's request plumbing in
  `runMcpFlow` (same `OpenAI` client, same `Authorization`/bill-to headers, so a
  sub-agent is billed to the person like the turn). `CHAT_DELEGATION` (admin
  screen `/admin/delegation`, `delegation.ts`) turns both off; the caller passes
  `delegation` to `getEnabledBuiltinTools` only when it is on.
  - Tools: web search/fetch/structured fetch plus the turn's MCP tools
    (`SUBAGENT_BUILTIN_TOOLS`); never `execute_code` (a parked browser call),
    `delegate`/`research` (depth one), the plan tool or the writers. `research`
    is the same loop with a fixed prompt and the three web tools.
  - Model: `model` is validated against `visibleModels(locals)` (what the person
    may use: tool-capable, not the router, never `custom:`), resolved by the
    caller; another model gets its own id and caps, none of the main model's
    sampling.
  - **Approvals are not relayed.** The approval card works by parking the turn
    and resuming it (`toolApproval.ts`, `resumeElicitation.ts`); a sub-agent is
    an in-memory loop inside one tool call and cannot be parked. So its MCP calls
    pass `createSubAgentApprovalGuard`: allowed under `always-allow` or when the
    conversation already approved `server:tool`, otherwise refused with a message
    the model reads, shown as "refused" on the card and named in the result so the
    main model can make the call itself (which asks the person). `web_fetch` and
    `web_fetch_structured` gate themselves in `execute`. Do not give a sub-agent a
    way to open an approval prompt without first persisting its loop.
  - Limits: 25 rounds, a cumulative token budget, an eight-minute deadline (the
    run then answers with what it has), three at once per turn (one counter for
    both tools), Stop through the turn's abort signal. The per-turn fetch caps live
    in the shared `web_fetch` instance, so they hold across sub-agents.
  - UI: a `SubAgent` update (re-sent whole, replaced by `uuid` in
    `applyUpdateToMessage` and `consumeMessageUpdates`) drives `SubAgentCard`;
    the card takes the answer or error from the call's own Tool result. The two
    replace-by-uuid copies must stay in step, like the final-answer merge.
