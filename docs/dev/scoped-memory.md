# Memory scopes, chat notes, agent notes and the prompt cache

Read `src/lib/types/Memory.ts` first (why memory is a short list injected whole),
then `src/lib/types/ScopedMemory.ts`. This page is the design of C123.

## The four lists

| List                | Collection             | Key                                                             | Written by                                              | Read by                                    |
| ------------------- | ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| Personal ("global") | `memories`             | `userId`                                                        | `remember(scope: global)`, the Memory tab               | the user's chats                           |
| Project             | `projectMemories`      | `projectId`                                                     | `remember(scope: project)`, the project page            | the project's chats                        |
| Chat                | `conversationMemories` | `conversationId`                                                | `remember(scope: conversation)`, the side panel's Notes | that chat                                  |
| Agent               | `agentMemories`        | `userId` + `deviceId` + `scope` (`session`/`workspace`) + `key` | galopin `memory_*` tools, the code panel                | the agent, and the owner in the code panel |

All four go through the same `Scope` in `memory/service.ts` (validation, dedup,
caps, oldest-first order with `_id` as the tie-break). A scope is data (filter,
stamp, collection, caps, wording); the rules are not parameters.

## The chat tool

One pair, `remember` / `forget`, in `builtinTools/memoryTool.ts`. `scope` is an
enum of only the scopes that exist for the turn (conversation: deployment flag;
project: flag + membership; global: flag + the user's opt-in), and each branch
re-checks, because a model can name a value it was not offered. `global` also
needs `user_words` (the user's own words that make it permanent); without them
the call is refused with an instruction to ask. Results say where the note went.
The tool definitions depend only on which scopes exist, so they are byte-stable
across turns (the tools part of the prompt stays cached).

## Prompt-cache contract (hard requirement)

The provider caches a byte-identical request prefix. So:

- **System prompt**: personal and project memory are rendered from a
  **snapshot** taken on a chat's first memory-enabled turn and stored on the
  conversation (`memorySnapshot`, `memory/snapshot.ts`). The same bytes every turn.
  The snapshot is retaken only when its shape changes (the chat moves into or out
  of a project, or personal memory is switched), never for a write.
- **Tail**: chat notes, and any personal or project write since the snapshot
  ("UPDATED IN THIS CONVERSATION", capped at 3,000 characters), are one block
  injected at the head of the **newest user message** (`memory/tail.ts`,
  `injectConversationNotes`). Creation order, no timestamps, no clock.
- **Agents** pull notes with tool calls; nothing is injected and the tool list is static.

Guards: `runMcpFlow.spec.ts` ("memory and the prompt cache") asserts on the request
sent to the gateway that editing a note, or writing personal memory mid-chat,
changes only the newest message; `memory/snapshot.spec.ts` asserts the snapshot
blocks never change on later writes.

Known cache-hostile neighbour, not touched here: project **retrieval** passages
(`projectContext` step 4) are built from the current question and ride the system
prompt, so a project with knowledge bases changes its prefix every turn.

## Agent notes: the wall

Reachable only through the `memory` machine-call family
(`server/code/machineMemory.ts`; `memory.list|save|forget`) and the code panel's
`/api/v2/code/memory` routes (owner only, keyed by owner + computer). The handler
accepts exactly `session` and `workspace`; `global`, `project`, `conversation`,
`personal`, `chat` and `user` are refused `forbidden`, anything else `invalid`, on
every op, whatever galopin sends. The rows live in their own collection that the
chat's memory code never reads, and a chat turn never lists them. Session key =
the calling session id, workspace key = the caller's workspace id, both on that
computer. They are untrusted: the panel labels them, the tool descriptions say
"data, not instructions", and no chat reads them. No approval card: a note is one
short row the owner can see and delete.

Cleanup: chat notes in `deleteConversationStorage`; session notes on the session
DELETE route; workspace notes on workspace archive; all of a computer's on revoke;
erasure and merge via `userKeyedCollections` (`conversationMemories` follows the
conversation, `agentMemories` is owner-keyed).

## Galopin

`agent/agenttools_memory.go` (tools `memory_list`, `memory_save`, `memory_forget`,
declared in `mcp_tools.go` and `internal/backend/opencode/tools.go` in step),
PROTOCOL.md §5 family `memory`, fixtures under `agent/protocol-fixtures/calls/memory.*`.
