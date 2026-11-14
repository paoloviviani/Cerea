# Memory scopes, chat notes and the prompt cache

Read `src/lib/types/Memory.ts` first (why memory is a short list injected whole),
then `src/lib/types/ScopedMemory.ts`. This page is the design of C123.

## The three lists

| List                | Collection             | Key              | Written by                                              | Read by             |
| ------------------- | ---------------------- | ---------------- | ------------------------------------------------------- | ------------------- |
| Personal ("global") | `memories`             | `userId`         | `remember(scope: global)`, the Memory tab               | the user's chats    |
| Project             | `projectMemories`      | `projectId`      | `remember(scope: project)`, the project page            | the project's chats |
| Chat                | `conversationMemories` | `conversationId` | `remember(scope: conversation)`, the side panel's Notes | that chat           |

All three go through the same `Scope` in `memory/service.ts` (validation, dedup,
caps, oldest-first order with `_id` as the tie-break). A scope is data (filter,
stamp, collection, caps, wording); the rules are not parameters.

## The chat tool

One pair, `remember` / `forget`, in `builtinTools/memoryTool.ts`. `scope` is an
enum of only the scopes that exist for the turn (conversation: deployment flag;
project: flag + membership; global: flag + the user's opt-in), and each branch
re-checks, because a model can name a value it was not offered. `global` also
needs `user_words`: a quote of at least two words (about ten characters) from the user's newest message that
holds a permanence marker (always, every chat, from now on, about me, sempre, in ogni chat, d'ora in poi,
su di me, and so on, English and Italian); otherwise the call is refused with an instruction to ask. Results say where the note went.
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
- **Replay, not move, and only when changed.** Each user message stores the block it was sent with
  (`Message.memoryBlock`, `memory/blocks.ts`) and later turns replay it unchanged, so the request up to
  the end of the previous turn is byte-identical. The newest message gets a fresh block only when it
  differs from the last block on the path; unchanged notes ride one message and later ones carry none.
  If that carrier has more than `reemitSpanFor(contextLength)` characters of history after it (a quarter
  of the default 400,000-character budget, less on a small window), the block is sent again on the newest
  message before the history budget can trim it away. The decision is stored with the message, so a replay
  reproduces it. The block is computed once per turn in `textGenerationWithoutTitle` and applied to both
  the tool flow and the tool-free fallback.
- **Deletes and edits take effect.** Deleting, editing or `forget`ting a personal fact or project note unsets
  `memorySnapshot` and the stored blocks on the conversations that hold it; deleting or editing a chat
  note drops that chat's stored blocks; moving a chat into or out of a project clears its snapshot and blocks; switching personal memory off does the same for the user's
  chats. One cache miss, then the next turn rebuilds. A removed row that still shows up in a
  diff is reported without its words. `memorySnapshot` and `memoryBlock` stay out of the export.
- **Agents** have no Cerea memory tools; project context for agents is planned (ADR 0118).

Guards: `runMcpFlow.spec.ts` ("memory and the prompt cache") asserts on the request
sent to the gateway that editing a note, or writing personal memory mid-chat,
changes only the newest message; `memory/snapshot.spec.ts` asserts the snapshot
blocks never change on later writes.

Known cache-hostile neighbour, not touched here: project **retrieval** passages
(`projectContext` step 4) are built from the current question and ride the system
prompt, so a project with knowledge bases changes its prefix every turn.

Cleanup: chat notes in `deleteConversationStorage`; erasure and merge via
`userKeyedCollections` (`conversationMemories` follows the conversation).

## Agents

Agents have no Cerea memory tools, no machine-call family for memory and no
Notes pane. Project context for agents is planned in ADR 0118 and is not built.
