# Models and their capabilities

## Where a model's capabilities come from

**The gateway advertises them and this app must read its shape.** Each card on
`GET /v1/models` carries flat `input_modalities`, `output_modalities` and
`supported_features` — an open set of strings on purpose, because
the reference provider documents it as "current values include json_mode,
reasoning and tools" and a boolean per feature would need a migration whenever
a provider adds one. So `models.ts` matches by membership, not by field.

It was reading **HuggingFace's router shape instead** — `architecture
.input_modalities` and `providers[].supports_tools` — which a gateway never
sends. Every model therefore came back with no tools, no vision and no
reasoning, and the capability switches for them had nothing to show. Nothing
errored and nothing logged; the only symptom was four absent switches. Both
shapes are read now, gateway first, because the standalone mode runs against
any OpenAI-compatible endpoint, some of which send only the nested one.

Two consequences worth knowing:

- **a model's row can legitimately declare nothing.** `benchmark-live` was
  created by a live-benchmark script (`benchmark_live.py`, not in this
  repository) through `/api/admin/models` with the three fields omitted, so it
  advertised nothing while its upstream declares `tools` and `json_mode`. The
  script sets them now. An operator sets them for
  any model through the console's `CapabilityPicker`;
- **the switches are not gated on advertised support.** The advertised value is
  the default and the switch overrides it — the same judgement the gateway
  makes about its own catalogue: a claim rather than a contract,
  editable by somebody who has found out otherwise. Gating them is how all four
  came to be invisible. Where switch and catalogue disagree, the row says what
  the gateway said.

`scripts/test_nav_live.py` asserts the crossing: a model the _gateway_ says
does tools must be reported by the _chat_ as doing tools. That is the only
place the mismatch was ever visible.

## Models: one manager, custom models, and no per-model page

`ModelsManager` is the **only** place catalogue models are managed. It lists all
of them (and the person's custom models, marked) with a search, and opens one to
set it as the default or change its settings — reasoning, tools, images and
artifacts. **There is no per-model system prompt**: it was removed, its stored
values dropped without migration (see below). `routes/settings/(nav)/[...model]`
is **gone**; everything that pointed at it now opens the manager.

The manager is the Models tab of the **workspace** (`/workspace`), the page
that hosts models, **Custom models**, memory, knowledge bases, skills and
memory as tabs. The address is the way in from anywhere: `/workspace?tab=models`
for the list, `/workspace?tab=models&id=<id>` straight onto one model's
settings, `/workspace?tab=custom[&id=custom:<id>]` for Custom models. The
affordances that open it — a routed message's model, the models list's gear —
navigate to that address (the composer's model name opens the per-chat
`ModelPicker`, which is a different thing). The `modelsOverlay` store this once
needed is deleted; an address needs no store.

Two things worth knowing:

- **"Default" is what a _new_ chat starts on.** An open conversation keeps the
  model it was started with, so the button says "Set as default" and the pill
  says "Default", not "Active";
- **There is no inference-provider choice.** Every call goes to the gateway,
  and which upstream serves a model is the gateway's decision (ADR 0032).

### Custom models: the global prompt and custom models

Two things a person writes, both on the **Custom models** tab
(`components/models/CustomModelsManager.svelte`):

- **`Settings.globalSystemPrompt`**: one prompt for every _chat_ turn. Chat only:
  the /code panel never reaches the pipeline that applies it, and title
  generation is a separate internal completion that does not.
- **Custom models** (`customModels` collection, `types/CustomModel.ts`,
  `server/customModels.ts`, routes `api/v2/custom-models`): a name (unique per
  owner, case-insensitively), a **base** (a catalogue model the caller can see,
  never another custom model), a system prompt and an optional description.
  **Private**, owner-keyed exactly like `settings` (`userId`, or `sessionId` for
  an anonymous session, via `authCondition`); another person's id is a 404.
  Erased with the account and renamed-not-dropped on a merge
  (`identity/userKeyedCollections.ts`, which has a spec guarding the roster).

**The id scheme is `custom:<24-hex ObjectId>`** (`utils/customModelId.ts`).
`conversation.model` holds it, so a conversation stays on its custom model,
and it is also the id in the picker and in `settings.activeModel` (a custom
model can be the default). **It never leaves Cerea.** One function turns it into
a model a turn can run on: `resolveConversationModel` (`server/customModels.ts`).
Every place that used to do `models.find(m => m.id === conv.model)` goes through
it — the turn route, the parked-turn and tool-approval sweepers, the
view-prompt route — and the upstream request, the capability gates, the metrics
and the per-model settings (`reasoningEffortOverrides`, tools, images,
artifacts: all keyed by the **base** id) see only the base. A custom model that is
gone, or whose base left the catalogue, **falls back to the deployment default**
instead of failing the turn (a deleted one's conversations are moved to its base
when it is deleted, so that is the safety net).

**The client sees custom models as ordinary catalogue entries.** `+layout.ts`
loads `GET /api/v2/custom-models` beside the catalogue and appends
`customModelEntries()` (`utils/customModelEntries.ts`) to `data.models`: each
copy of its base's entry with a new id, name and `customBase`, so vision, tools,
reasoning and effort gating carry over with no second code path. They go
**after** the catalogue so `models[0]` stays the deployment default. A setting
keyed by model id is read with `settingsModelId(model)` (the base's), never
`model.id`. The /code panel never sees them: it lists the machine's own models,
and `allowsModel` refuses a `custom:` id even for a machine that allows free
models.

**One function composes the prompt**: `composeUserPrompt` (`textGeneration/preprompt.ts`,
called by `resolvePreprompt`, fed by `textGeneration/userPrompts.ts`): **the
administrator's instructions** (`server/adminInstructions.ts`: config keys
`ADMIN_INSTRUCTIONS` / `ADMIN_INSTRUCTIONS_VISIBLE`, edited at `/admin/instructions`,
read from the config's in-memory copy so a turn adds no query, a saved empty value winning over the env default via `getSaved`; sent as a labelled, closed block, first in the system prompt even on tool turns (`runMcpFlow` puts it ahead of the tool contract); also put first in
every sub-agent's system prompt in `runNestedAgent`; never the /code panel,
galopin or titles; Settings gets the text only while visible, and no field at
all otherwise), then **global,
then the custom model's, then the conversation's stored prompt**; empty parts are
skipped; `preprompt.spec.ts` asserts the order. What `resolvePreprompt` and the
turn append after it (the artifacts and execution contracts, skills, memory, then
the project's context, whose own order `projectContext` keeps) reads below.

**Per-model prompts are gone, and stale ones are neutralised three ways.** The
settings API no longer reads or writes `customPrompts` / `customPromptsEnabled`
(an old client posting them is ignored: the schema strips unknown keys);
`POST /conversation` ignores a body `preprompt` (a stale tab could otherwise
smuggle one back in; a conversation's prompt is the model's own, or an imported
share's); and `dropPerModelPrompts` — run once at boot from
`Database.initDatabase`, idempotent, not a `Migration` routine because that list
is empty and routines run in a transaction — `$unset`s what is stored.
Conversations that already stored one keep it: it is that conversation's own
system message now.
