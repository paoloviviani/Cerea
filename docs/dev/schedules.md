# Scheduled actions: the framework and the executor contract

A schedule is a row someone owns that says "at these times, do this". **The core
is kind-agnostic** (`src/lib/server/schedules/`); two kinds exist, `"agent"` and
`"chat"`, each **one executor file plus its registration**. The pieces:

- `recurrence.ts`: presets (every N hours, daily, weekdays, weekly) and a cron
  expression, validated and iterated with **croner** (MIT, no dependencies;
  wall-clock times in an IANA zone, DST: a skipped time runs once at the first
  instant that exists, a repeated one once at the first). The **15-minute floor**
  is enforced here only: a cron expression is sampled and refused if any two of its
  next 400 occurrences are closer, and a seconds field is refused. "Every N hours"
  counts elapsed hours from `anchorAt`, not clock hours.
- `scheduler.ts`: the loop (30s, started in `hooks/init.ts` like the sweepers).
  `claimDue` takes one due row with a single `findOneAndUpdate` whose filter pins
  the `nextRunAt` it read and a free lease, and whose update **advances
  `nextRunAt` first** and sets the lease; two instances cannot both win. Lateness
  past 2 minutes is downtime: one catch-up if under half the interval late (cap
  1h), else a `missed-downtime` row. Three consecutive `failed` runs disable the
  schedule (the core counts, executors do not). `runNow` takes the same lease.
- `store.ts`: owner-scoped CRUD. Another person's id is a 404, never a 403. The
  per-user cap (`CHAT_SCHEDULES_MAX_PER_USER`, 20) is settled after the insert, so
  racing creates cannot exceed it. `limits.ts` holds the kill switch
  (`CHAT_SCHEDULES_ENABLED`, on unless exactly `false`).
- Two collections: `schedules` and `scheduleRuns` (a row per occurrence
  _considered_, fired or not: the audit record, TTL 90 days). Both are in
  `identity/userKeyedCollections.ts` (erased with the account, moved on a merge).

**The executor contract** (header of `executors.ts`, the source of truth):

```ts
registerExecutor({
  kind: "agent",
  available?: () => boolean,          // false: the core leaves its rows alone
  validateTarget(target, { userId }), // -> { ok, target } | { ok: false, error }; check what the CALLER owns
  describeTarget(target, { userId }), // -> short label for a list; cheap, never throws
  run({ schedule, scheduledFor, trigger, previousRun, now }), // -> { status, detail?, result?, disable? }
});
```

Optional hooks `precondition(userId)` (a reason the person cannot have a schedule of the kind
running yet, checked on create-enabled and on switch-on) and `afterDelete(schedule)` let a kind
that runs with no signed-in session depend on something of the person's (chat: the background
grant); the agent executor sets none.

`target` is opaque to the core. `run` returns what happened (`sent`,
`skipped-still-running` after looking at `previousRun`'s output, `missed-offline`,
`failed`) and `disable` switches the schedule off with a reason. The core never
imports an executor; `hooks/init.ts` imports the executor files for their
registration.

**The agent executor** (`server/code/scheduleAgentExecutor.ts`) uses `MachineLink`
ops: the panel's own (`session.create`, `session.setMode`/`setModel`,
`session.setPermissionMode`, `session.prompt`) and, for the two coordination
options, galopin's `session.grantCoordination`. Its target is `{ deviceId,
workspaceId, sessionMode: "new" | "existing", sessionId?, modeId?, modelId?,
permissionMode, canMessage?, canSpawn?, labels }`; the device must be the
caller's own, paired. Things that bite:

- a session a schedule starts is titled `<name> · YYYY-MM-DD HH:mm`; the tree
  marks it with a clock by matching that tail (`isScheduledTitle`), not by a wire
  field;
- the permission word is set **before** the prompt, and for "always this session"
  it is set on that session and stays; the machine's ceiling caps it as everywhere;
- **coordination is a grant, not a rule.** `session_list`/`session_read`/
  `session_send`/`session_spawn` are what a grant names (a session on Allow
  also spawns and sends without one when the ceiling and the machine's rules
  leave the tool alone, but never reads), and no op writes a
  rule (`session.setRules` is retired). The two options (`canMessage`: list,
  read, send; `canSpawn`: spawn; both off by default, `utils/coordination.ts`
  maps them) become one `session.grantCoordination` after the session exists
  and **before the prompt**; galopin composes it as allows beneath the ceiling,
  so a capped key still asks and another workspace still asks. A machine that
  cannot take it (`backends[].capabilities.coordinationGrant` absent in its
  hello, `policy.agentTools: "denied"`, or the op answering `unsupported`) runs
  the prompt without it and the run row says why; any other error fails the run
  before the prompt. A pinned session whose options are off has its grant
  cleared (`keys: []`) on a machine that supports it, so "off" means off. The
  editor and the executor read `utils/coordination.ts` for the wording, so the
  warning and the run row cannot disagree;
- **agents make schedules too**: `server/code/machineCalls.ts` answers the
  machine's `call` frames (`schedule.context|list|create|update|delete`) as the
  device's owner, through `createSchedule`/`updateSchedule` and this executor's
  `validateTarget`, with the agent's own refusals on top (mode no looser and
  coordination no wider than the caller's, 5 running agent-made schedules per
  machine, 10 changes per machine per hour with pause/delete exempt, this
  machine's schedules only). Its `agentMode` is the target's `modeId`
  (default `build`, not bounded by the caller). `createdBy` is passed by the caller of
  `createSchedule`, never read from a body; the welcome advertises
  `features.machineCalls`. Specs: `machineCalls.spec.ts`, and `FakeMachine.call()`
  sends a `call` from tests;
- **every scheduled prompt starts with one header line**
  (`schedules/runHeader.ts`): `[Scheduled run of "<name>", <timetable>
(<timezone>); previous run <ago | none>; coordination: <keys | none>]`, a
  blank line, then the prompt as written. It is not stored on the schedule.
  galopin's `delegation` skill (`agent/internal/backend/opencode/skill.go`) has
  a "When you run on a schedule" and a "Scheduling work" section that read it;
  change the header and the skill together;
  **The chat executor** (`schedules/chatScheduleExecutor.ts`; spec beside it). Target
  `{ mode: "continue" | "new", conversationId?, model?, projectId?, billingGroupId?, labels }`;
  "new" copies model and project from the chat it was made from and then does not
  hang on it. Things that bite:

- **A run is the conversation route's own turn**: it builds a request and calls
  `routes/conversation/[id]` `POST` (and `routes/conversation` `POST` for a new chat) with a
  `locals` whose `token` is the schedule's unsealed key and `scheduledRun: true`; do
  not write a second pipeline. `locals.scheduledRun` is what the pipeline reads: the
  prompt says Python cannot run (`preprompt.executionAvailable`), `getEnabledBuiltinTools`
  drops every `mayPark` tool (the sandbox, questions) and the `schedule` tool, and
  `executeToolCalls({ toolApproval.unattended })` refuses what would open an approval card
  in the sub-agent's words. Anything new that parks the turn must set `mayPark`.
- **The run returns once the turn ends or after `chatRunConfig.earlyWindowMs` (25 s)**,
  so a long turn is not held against the 2-minute lease. A gateway refusal is fast, so it
  lands in the window; one that ends later is announced (unread mark
  `Conversation.scheduledUnread`, push) and, if it failed, is settled by the core (`settled`). The unread mark is cleared by `GET /api/v2/conversations/[id]`.
- **Unattended.** `locals.scheduledRun = { permissionMode }`; `executeToolCalls({ toolApproval.unattended })`
  refuses whatever would open a card, and an Ask run is given manual policy and no grants first.
- **The background grant** (`schedules/grants.ts`, collection `scheduleGrants`): one sealed OIDC
  refresh token per person, written by `updateUser` on every login (which then strips the
  session's own copy: IdPs rotate refresh tokens, so every holder would go stale). Everything
  that needs an access token (a browser session in `auth.ts` `findUser`, a scheduled run)
  calls `accessTokenFor`, which serialises per person with a DB lock, writes the rotated token
  guarded on the one it replaced, and caches the access token. Any OAuth error response from the token
  endpoint (or a changed subject) drops the grant and switches the person's chat schedules off;
  logout keeps it; erase and merge drop it (IdP revocation best effort); the settings "Stop"
  (`/api/v2/user/schedule-grant`) and deleting the last chat schedule only clear `scheduleUse`, because the
  grant is the sessions' refresh credential (dropping it would sign everyone out within the hour);
  a login or turning a chat schedule on sets it back. No refresh token
  or no `CHAT_SECRET_KEY` leaves the session path exactly as before. `grants.ts` loads `auth.ts`
  lazily (and `auth.ts` loads it lazily): they reach each other through the identity code.
- **Asking for `offline_access`** (`auth.ts` `loginScopes`, `OfflineMode`): Authelia cannot remember a consent
  that includes it, so the first sign-in on a browser asks, then the `hfChat-bgAccess` cookie says "settled" and
  later sign-ins skip it; the callback asks once more (`/login?offline=1`) when the person has no grant. An
  `invalid_scope` for it retries without and remembers per process; `OPENID_OFFLINE_ACCESS=off` disables it.
- **Permission mode** (`schedules/permission.ts`): `ask` | `allow` in the target, never looser than
  the user's approval setting (checked on create, edit and again at run); `approvalStateFor`
  gives an Ask run manual policy and nothing pre-approved.
- **A run that returns `sent` early** carries `outcome.settled`; the core rewrites the run
  to `failed` and counts it when the late result fails. At most `chatRunConfig.maxConcurrent`
  scheduled turns run in a process; more are skipped.
- **The `schedule` tool** (`builtinTools/scheduleTool.ts`) never creates anything itself.
  `toolInvocation` gates it on the approval card whatever the policy and whatever was
  granted (`alwaysConfirm`; a proposal `parseScheduleToolArgs` refuses never opens a card),
  and only the click runs `createScheduleFromApproval` from `mcp/resumeElicitation.ts`,
  with the approving request's token. `ToolApprovalCard` draws it from the args; no
  "for the conversation" button.
- **Access**: `requireSchedulesAccess` (`schedules/api.ts`) lets every signed-in user in;
  agent schedules also need the /code panel for them (`agents`), and the routes answer 404
  for the other kind. The page is `/schedules`, the same `SchedulesPanel` as `/code?view=schedules`;
  the editor's chat half is in `ScheduleEditor.svelte` (`kind`).

- API: `/api/v2/code/schedules` (+ `/[id]`, `/[id]/run`, `/[id]/runs`, `/preview`).
  It is under `/api/v2/code/`, so the 7-day sign-in guard covers it by prefix;
  `stale-guard.spec.ts` lists every route file and fails on a new one.
