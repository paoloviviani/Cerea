# MAINTAINING.md: how to keep this project going

This is the handoff guide for whoever works on Cerea next: a person, or a
coding agent running in Cerea's own /code panel through galopin. It is written
so a careful but less experienced model can follow it step by step. It says
what the project is, the rules that are not negotiable, how a change is made,
verified and released, and the traps that have already cost time.

`AGENTS.md` is the detailed reference (architecture, subsystems, conventions).
Read this file first, then the `AGENTS.md` section for the area you touch.

## 1. What this is

Three repositories, one product. All are owned by Paolo Viviani (the owner).

| Repository             | What                                                                                                                                                                         | Released as                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Cerea** (this one)   | The chat app (SvelteKit, a fork of huggingface/chat-ui), the `/code` panel for coding agents, **galopin** (the Go machine agent, `agent/`), and the **deploy kit** (`kit/`). | Tag `vX.Y.Z`: image `ghcr.io/paoloviviani/cerea:X.Y.Z`, the kit at that tag, the `stable` branch, a GitHub release. |
| **Pystino**            | The model gateway: OpenAI-compatible `/v1`, accounting, quotas, redaction, OIDC sign-in, admin console. Cerea talks to it only over `/v1`.                                   | Tag `vX.Y.Z`: images `pystino-gateway`, … The kit pins one Pystino version.                                         |
| **ai-stack** (private) | Decision records (ADRs, `docs/adr/NNNN-*.md`, numbered across all repos), reports, roadmap. No code.                                                                         | Not released.                                                                                                       |

Code and docs cite ADRs by number ("ADR 0093"). If you cannot read ai-stack,
the number is still the reference; ask the owner for the text when a decision
matters.

How it runs for an operator: `kit/get-kit.sh` fetches the kit at the tag
`stable` points to; `./configure` writes `.env`; `docker compose up -d` runs
Caddy (proxy), Authelia (sign-in), the Pystino gateway, Mongo, the chat and
helpers. Upgrades: `sh kit/get-kit.sh --upgrade`, then
`docker compose pull && docker compose up -d --wait` in `kit/`. A coding
machine runs galopin (`galopin run`, usually as a systemd user unit), which
drives `opencode` and connects to Cerea over WSS.

## 2. Rules that are not negotiable

1. **No AI attribution in commits.** No `Co-Authored-By: Claude` (or any AI)
   trailer, no session links, and never `--author`. A `commit-msg` hook
   rejects them; do not bypass it. The commit identity is the owner's git
   config.
2. **Licences.** All first-party code is Apache-2.0. Describe the policy as
   "OSI-approved licences". Dependencies: permissive is fine; MPL unmodified is
   fine; GPL/AGPL only as a separate process; anything non-OSI needs the
   owner's approval. Never mention a previous licence of the project or a
   former employer in code, docs or commit messages.
3. **Visibility is the owner's call.** Never make a repository, package or
   image public, or private, without being asked.
4. **Operators follow `stable` or a tag, never `main`.** `stable` moves only
   after the fresh-kit test passes (section 5).
5. **`main` stays clean.** Work on a branch; merge with `--no-ff` and a real
   message. Never push a commit whose subject starts with `WIP` to `main`.
6. **New features are the owner's decision.** Fix bugs freely; propose
   features with a recommendation and wait for a yes. When the owner chooses
   between options, do what was chosen, not a variant.
7. **Report the truth.** A test that failed is reported with its output. A
   step that did not run is "not run", never "passed". "Done" means verified.
8. **Never act on the owner's live deployment.** It is on another machine. You
   publish releases; the owner upgrades.
9. `paoloviviani/cerea-deploy` is **archived** (the kit moved into `kit/` at
   v0.5.0). Never push there.

## 3. Where things are

| You are changing…                                          | Look at                                                                                                                                                         | Docs to update                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Chat streaming, final answers, message content             | `src/lib/server/textGeneration/`, `src/lib/server/generation/applyUpdate.ts`, `src/lib/utils/mergeFinalAnswer.ts`, `src/lib/components/chat/ChatMessage.svelte` | `docs/chat.md`                                                              |
| Models, custom models, global prompt                       | `src/lib/server/models.ts`, AGENTS.md "Models"                                                                                                                  | `docs/chat.md`, `docs/configuration.md`                                     |
| Projects, knowledge, attachments                           | AGENTS.md "Projects and knowledge bases"                                                                                                                        | `docs/knowledge.md`                                                         |
| Look and feel (fonts, colours, density)                    | `src/styles/tokens.css`, `src/styles/main.css`, palettes (`scripts/generate-palettes.mjs`)                                                                      | screenshots (section 4)                                                     |
| The /code panel (browser side)                             | `src/lib/components/code/`, `src/routes/code/`, `src/lib/server/code/`                                                                                          | `docs/code-panel.md`                                                        |
| The machine link, ops, events                              | `src/lib/server/code/machines.ts` (Cerea), `agent/PROTOCOL.md` (the contract), `agent/*.go`                                                                     | `agent/PROTOCOL.md` first, then `agent/README.md`, `docs/agent-machines.md` |
| galopin permissions (Deny/Ask/Allow, ceiling, agent tools) | `agent/internal/permrules/`, `agent/permissions.go`, `agent/agenttools*.go`                                                                                     | `agent/README.md`, `docs/agent-machines.md`                                 |
| Scheduled actions                                          | `src/lib/server/schedules/`, `src/lib/server/code/scheduleAgentExecutor.ts`, `src/lib/server/code/machineCalls.ts`                                              | `docs/code-panel.md`, AGENTS.md "Scheduled actions"                         |
| The deploy kit                                             | `kit/` (`configure`, `compose.yaml`, `get-kit.sh`, `tools/pin`)                                                                                                 | `kit/README.md`, `docs/deploy*.md`, `kit/CHANGELOG.md`                      |
| Release machinery                                          | `scripts/release/`, `.github/workflows/`                                                                                                                        | AGENTS.md "Releasing"                                                       |

Workflows: `ci.yml` (lint, check, tests, e2e on every push/PR), `kit.yml`
(kit tests, shellcheck), `opencode.yml` (galopin against real opencode, pinned
and latest), `images.yml` (run by hand on a tag; publishes the image),
`contract.yml` (Cerea against a pinned Pystino), `docs.yml`.

## 4. Making a change, step by step

1. **Branch** from up-to-date `main`: `git switch -c fix/<short-name>`.
2. **Read before writing.** Find the code path with `grep`; read the
   AGENTS.md section for it. Look for an existing helper before writing one.
3. **Change the smallest thing that fixes it.** No drive-by refactors. Match
   the surrounding style and comment density.
4. **Write the test that fails without your change**, then make it pass. Check
   it really fails on the old code (temporarily revert your fix, run it, put
   the fix back). A test that passes either way proves nothing.
5. **Run the checks** (AGENTS.md "Verifying a change" has the full list):
   - `npm run check` and `npm run lint` (ignore a generated `site/` directory:
     it is a docs build output, not source);
   - the specs next to what you changed: `npx vitest run --project=server <files>`;
   - Svelte component tests are the `client` project and are NOT part of
     `npm run test`; run them in the Playwright image (AGENTS.md has the
     command);
   - e2e for UI flows: `npx playwright test tests/<file>.spec.ts --project=chromium`;
   - galopin: `cd agent && go vet ./... && go test ./...`, and the
     real-opencode tests when you touch permissions, tools or the backend.
6. **UI changes get screenshots** at 1440 and 390 wide (and dark mode if
   colours changed). Look at every one before saying it is fine.
7. **Docs in the same change.** Behaviour visible to users goes in `docs/`; a
   contract change goes in `agent/PROTOCOL.md`; a non-obvious design decision
   goes in AGENTS.md. Build the docs with `--strict`.
8. **Commit** with a message that says _why_ (the bug, the rejected
   alternative), not a list of files.
9. **Merge**: `git switch main && git pull --ff-only && git merge --no-ff <branch>`,
   push, and wait for CI on `main` to go green before releasing.

### Changing the machine protocol (Cerea ↔ galopin)

Old galopins stay in the field for a long time, and the owner updates machines
by hand. So:

- Every new op, frame or field is **optional and advertised**: galopin adds a
  capability to its `hello` (backend `capabilities`), Cerea adds a feature to
  its `welcome`. The other side treats "absent" as "not supported" and shows a
  clear message ("update galopin on this machine") instead of failing.
- **Cerea's `hello` schema drops unknown keys.** A new capability must be added
  to that zod schema too, or Cerea never sees it.
- An unknown op is answered `unsupported`; unknown frames are ignored. Test
  both directions: new Cerea with old galopin, and the reverse.
- The release note must say whether machines need the galopin update (re-run
  the install line from the pairing dialog, then
  `systemctl --user restart galopin`).

### Bumping opencode

galopin pins one opencode release (`agent/packaging/opencode-version`).
`opencode.yml` runs the whole real-opencode suite against the pin and against
the latest release and reports when latest passes. Follow `agent/README.md`
("opencode releases") to bump: change the pin, run the suite, update the docs that name
the version (also Pystino's `docs/coding-agents.md`).

## 5. Releasing

Small, frequent releases; every release gets a changelog entry and a GitHub
release. Version: patch for fixes, minor for features.

1. On `main`, write the release commit:
   - `npm version X.Y.Z --no-git-tag-version`;
   - `python3 kit/tools/pin --cerea X.Y.Z` (and `--pystino P.Q.R` if the
     gateway changed), then `python3 kit/tools/pin --check`;
   - a `## vX.Y.Z — YYYY-MM-DD` entry at the top of `kit/CHANGELOG.md`, with
     the pins line, written for operators: what changed for them, and whether
     machines need the galopin update;
   - commit "Release vX.Y.Z", push.
2. Run `scripts/release/release.sh X.Y.Z`. It checks the release commit,
   waits for CI, tags, builds the image, checks it pulls without a login, runs
   the fresh-kit test (`scripts/release/fresh-kit-check.sh`), moves `stable`
   and creates the GitHub release. It stops at the first failure and says
   which step. A release is done only when it prints `released vX.Y.Z`.
3. Tell the owner: the version, what changed in a few lines, the upgrade
   commands, and whether machines need the galopin update.

The fresh-kit test needs Docker, `uv`, `gh`, and ports 80/443 free on the
machine that runs it.

Pystino is released from its own repository (tag, then its `images` workflow);
afterwards pin it in the kit with `kit/tools/pin --pystino` and release Cerea.

## 6. Traps that have already cost time

- **Two copies that must stay in sync.** Final-answer merging exists in
  `src/lib/server/generation/applyUpdate.ts` (stored content) and
  `src/lib/utils/mergeFinalAnswer.ts` (client), and `ChatMessage.svelte`
  renders with the latter's `finalAnswerAddition`. A fix in one place only
  shows the answer twice somewhere else (it happened twice). Same for
  `src/styles/tokens.css`, mirrored byte-identical from Pystino's
  `packages/ui/src/tokens.css`.
- **Whitespace and Unicode.** Streamed text and a provider's final text differ
  in line endings, NFC/NFD and inserted paragraph breaks; compare normalized
  forms, never raw bytes.
- **Layout tests are pixel-sensitive.** A font-size or line-height change
  breaks centring and row-height tests; fix the component (`leading-*`,
  `min-h-*`), do not loosen the test.
- **`mongodb-memory-server` crashes with SIGILL** on CPUs without AVX. Point
  tests at a real Mongo: `TEST_MONGODB_URL=mongodb://localhost:<port>` and
  `--no-file-parallelism` (tests share the database).
- **Docker builds from a git worktree fail** (`.git` points outside the build
  context). Build from a normal clone.
- **Files written by containers are root-owned** and later break `npm ci` or
  builds with `EACCES`: give them back with
  `docker run --rm -v "$PWD":/x alpine chown -R "$(id -u):$(id -g)" /x/<dir>`.
- **Shell scripts:** CI uses shellcheck v0.9.0; run that exact version
  (`docker run --rm -v "$PWD":/mnt -w /mnt koalaman/shellcheck:v0.9.0 <files>`).
  In scripts, check every step explicitly; `set -e` does not stop on a failure
  inside `a && b` or a pipeline.
- **GitHub sometimes answers 500** on push or workflow dispatch. Retry; the
  release script already does, and falls back to the API for the tag.
- **Long-running commands:** wait on them inside your turn. Do not end your
  turn "to wait": nothing wakes you when a background command finishes.
- **Killing processes:** kill only PIDs you started. `pkill -f <pattern>` can
  match your own shell or another agent's server.
- **The `client` test project can fail to load a file under load** ("Failed to
  fetch dynamically imported module"). Rerun that file alone before treating
  it as a failure.

## 7. Open items (as of v0.7.0, 2026-10-08)

- Five e2e tests fail on one development machine but pass in CI:
  `code-device-revoke` (2), `code-machine-p0`, `code-machine-parity` (line 693) and `code-tree-reactivity` (line 95). Not yet explained; start by
  running them alone against a fresh build.
- Offered to the owner, not decided: a drag-to-resize sidebar; running each
  scheduled run in its own git worktree (galopin already has
  `workspace.create {worktree}` and `workspace.archive {removeWorktree}`).
- Deferred: scheduled actions for **chat** (not agents). The schedules
  framework is kind-agnostic (`src/lib/server/schedules/executors.ts`); the
  open question is which gateway credential a chat run uses when nobody is
  signed in.
- Pystino's own open items are listed at the end of its `AGENTS.md`.

## 8. How the owner likes to work

- Plain, short reports: what changed, what was verified (with numbers), what
  is left. No hedging, no filler.
- For a choice, give two to four options and a recommendation; for UI, show
  screenshots (desktop and phone) before building when the look is the
  question.
- Releases are small and frequent, each with a GitHub release, and the owner
  upgrades with `get-kit.sh --upgrade` and `docker compose pull`.
- The owner reads the docs site: keep `docs/` accurate in the same change.
