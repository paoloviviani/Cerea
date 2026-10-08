# Changelog

All notable changes to this deployment kit are documented here. The
convention: newest first, one section per release, dated, with the pins it
shipped. Since the kit moved into the Cerea repository (see Unreleased), a
release is a Cerea tag `vX.Y.Z` and this file lives at `kit/CHANGELOG.md`.

## v0.6.3 — 2026-10-08

Pins: Cerea `0.6.3`, Pystino `0.3.2`, Authelia 4.39.22.

- Fixed: after a model used tools, its final answer could show twice in the chat, and
  reloading did not help. The saved text was always right (exports were unaffected); the
  page now shows the answer once.

## v0.6.2 — 2026-10-08

Pins: Cerea `0.6.2`, Pystino `0.3.2`, Authelia 4.39.22.

- **Scheduled runs know they are scheduled.** Each scheduled prompt now starts with one line
  naming the schedule, its timetable, when it last ran and which coordination tools it was
  granted, e.g. `[Scheduled run of "Nightly", every day at 02:00 (Europe/Rome); previous run
  3 h ago; coordination: session_list, session_read, session_send]`, followed by your prompt
  unchanged.
- galopin's built-in delegation skill gains a "When you run on a schedule" section: nobody
  is watching live, look at other sessions before acting, do not repeat a message already
  sent, reuse an existing session before starting a new one, and end with a short summary.
  Update galopin on your machines to get it (re-run the install line, then
  `systemctl --user restart galopin`).

## v0.6.1 — 2026-10-08

Pins: Cerea `0.6.1`, Pystino `0.3.2`, Authelia 4.39.22.

- **Schedules can coordinate other sessions.** A schedule has two new options, both off by
  default: "Can find, read and message other sessions" and "Can start new sessions". With
  them a run can look at what other sessions on the machine are doing and steer them
  without stopping at an approval card. The machine's own limits still apply: a session in
  another workspace, a long chain of agent messages, and anything the machine caps at Ask
  still ask in the Needs-you inbox.
- New agent tool `session_read`: an agent can read the recent messages of another session
  on its machine (text only), gated like `session_send`; it is a new row in the pairing
  dialog's limits.
- **Update galopin on your machines** to use these: re-run the install line from the
  pairing dialog, then `systemctl --user restart galopin` (or restart `galopin run`). An
  older galopin keeps working; schedules then run without the grant and say so.

## v0.6.0 — 2026-10-08

Pins: Cerea `0.6.0`, Pystino `0.3.2`, Authelia 4.39.22.

- **Scheduled actions for agents.** In the /code panel, **Schedules** (or "Schedule this…" in
  a session's menu) sends a prompt to a coding session on one of your machines on a
  timetable: every N hours, daily, weekdays, weekly, or a cron expression, in your timezone,
  at most every 15 minutes. You pick the machine, the workspace (or create one) and a new
  session each run or one existing session, plus the agent mode, model and Deny/Ask/Allow.
  The machine pays with its own credential, as for any session. Each run is recorded:
  sent, skipped (the previous run is still going), missed (machine offline, or Cerea was
  down; at most one catch-up), or failed; three failures in a row switch it off, and so
  does revoking the machine. On Ask a run waits for your approvals in the Needs-you inbox.
- New settings: `CHAT_SCHEDULES_ENABLED` (on unless `false`) and
  `CHAT_SCHEDULES_MAX_PER_USER` (20).

## v0.5.2 — 2026-10-08

Pins: Cerea `0.5.2`, Pystino `0.3.2`, Authelia 4.39.22.

- The Workspace, Settings and Administration pages no longer have a description line
  under their title; Administration keeps its link to the Pystino console.

## v0.5.1 — 2026-10-07

Pins: Cerea `0.5.1`, Pystino `0.3.2`, Authelia 4.39.22.

- **A wider sidebar on desktop** (300px instead of 260px), so chat titles and /code
  sessions with subagents read better at the larger text size.
- **Clicking "Projects"** in the sidebar opens the list of projects; **clicking "Chats"**
  opens a new full-screen list of every chat, with a search on titles (case- and
  accent-insensitive). The small arrow next to each still expands and collapses it.
- The conversations index gains the title (rebuilt once at first start; the old
  index is dropped after the new one is built).

## v0.5.0 — 2026-10-07

Pins: Cerea `0.5.0`, Pystino `0.3.2`, Authelia 4.39.22.

- **Customize models** (a new Workspace tab): a **global system prompt** for every chat,
  and **custom models**: a name, a base model and a system prompt of your own, private
  to you, listed in the model picker next to the base models. They inherit everything
  from the base (vision, tools, reasoning, effort); requests always go to the base.
  Prompt order: global, then the custom model's, then the project's.
- **The per-model system prompt is gone.** Prompts saved per model are dropped at
  startup and never applied again; a conversation keeps the prompt it was created with.
- Agents: the Allow selector no longer claims new subagents ask on their first turn
  (they follow the session's setting since 0.3.10).
- A Development guide (`CONTRIBUTING.md`, and a page on the docs site), and a pass over
  every docs page.

- **The kit now lives in the Cerea repository**, in `kit/`, with its history. One Cerea
  tag `vX.Y.Z` is the kit's version, and `stable` (a branch of the Cerea repository, moved
  to a release only after its fresh-install test passes) is what operators follow; never
  `main`. The `cerea-deploy` repository is frozen at v0.4.8.
- **`kit/get-kit.sh`** installs the kit as a shallow, sparse checkout of just `kit/`
  (needs only `git` and `sh`): `curl -fsSL https://raw.githubusercontent.com/paoloviviani/Cerea/stable/kit/get-kit.sh | sh`.
  You work in `cerea/kit`. `--upgrade` moves a checkout to a newer release and keeps `.env`,
  `compose.override.yaml`, `proxy.d/*.caddy`, `first-sign-in.txt` and backups.
- **Moving from a `cerea-deploy` clone:** `get-kit.sh --from /path/to/cerea-deploy --dir /path/to/cerea`
  copies your operator files and pins the compose project name, so the same volumes
  are reused and no data is lost; then `docker compose down` (no `-v`) in the old
  directory and `docker compose up -d --wait` in the new `kit/`. See "Moving from a
  `cerea-deploy` install" in the README.
- `tools/diagnose`'s report names the "deploy kit release" instead of "cerea-deploy describe".

## v0.4.8 — 2026-10-07

Pins: Cerea `0.4.8`, Pystino `0.3.2`, Authelia 4.39.22.

- **Palettes:** Settings → Appearance offers an accent colour (Blue, Violet, Teal,
  Green, Rose, Orange) and a background tone (Gray, Slate, Stone), saved on the
  account and applied before the page draws. Every combination keeps text and
  buttons at 4.5:1 contrast or better, in light and dark.
- Project chats no longer show up under Chats after switching a chat's model
  (or another in-app list refresh).

## v0.4.7 — 2026-10-07

Pins: Cerea `0.4.7`, Pystino `0.3.2`, Authelia 4.39.22.

- Cerea 0.4.7: the image ships only runtime dependencies, 1.75 GB instead of
  2.15 GB on disk. No behaviour change.

## v0.4.6 — 2026-10-07

Pins: Cerea `0.4.6`, Pystino `0.3.2`, Authelia 4.39.22.

- Cerea 0.4.6: your messages are right-aligned in a light blue bubble (deep navy in
  dark mode), so your turns and the replies are easy to tell apart when scrolling.

## v0.4.5 — 2026-10-06

Pins: Cerea `0.4.5`, Pystino `0.3.2`, Authelia 4.39.22.

- **Look:** Inter replaces Roboto in the chat and the console, and every text size
  is 1px larger (chat text 16px, menus and sidebar 13–15px). Chat replies are
  denser (line height 1.5) and the reply bubble is slimmer, so a phone line gains
  about 30px.
- **Reasons are optional everywhere:** resetting a quota, merging users, the sign-in
  policy, the redaction engine and break-glass no longer require one. A reason you
  give is still stored in the audit log. `./configure --break-glass --reason` is
  optional too.

## v0.4.4 — 2026-10-06

Pins: Cerea `0.4.4`, Pystino `0.3.1`, Authelia 4.39.22.

- **Quota counters match the spend again** (Pystino 0.3.1). A gateway restart
  after the first quota rule was created could add the month's ledger total on
  top of the counter, so the quota showed more than was spent. A rebuild now
  replaces the counter with the ledger. Console → Quotas → **Quota health**
  shows counter against ledger per rule, and **Reconcile** corrects an existing
  gap (press it once after updating if yours differs).
- **`tools/diagnose`** writes one report (`diagnose-<date>.txt`, secrets,
  tokens and emails masked) to send when something goes wrong; see "Reporting
  a problem" in the README.
- **A final answer after a tool is no longer shown twice** (Cerea 0.4.4): for
  reasoning models the answer could be appended a second time.

## v0.4.3 — 2026-10-06

Pins: Cerea `0.4.3`, Pystino `0.3.0`, Authelia 4.39.22.

- Cerea 0.4.3: a project chat's title appears in the sidebar as soon as the
  first answer names it (it used to need a reload); the sidebar shows the
  pixel mark alone, larger and bolder, a little further from the edge.

## v0.4.2 — 2026-10-06

Pins: Cerea `0.4.2`, Pystino `0.3.0`, Authelia 4.39.22.

- Cerea 0.4.2: the project page is two columns on a desktop and no longer
  scrolls sideways; the project row's menu says Settings.

## v0.4.1 — 2026-10-06

Pins: Cerea `0.4.1`, Pystino `0.3.0`, Authelia 4.39.22.

- **Projects are a page** (`/projects/<id>`, `/projects/new`) instead of an
  overlay: the sidebar's ⋯ has Project settings and Delete. On the page:
  standing instructions, context documents, project memory, knowledge bases
  (attachable and detachable at any time), the project's chats (each removable
  from the project), sharing, and every option the overlay had.
- **Context documents:** files whose text goes into every prompt of the
  project, in full. Individual files only (no folders), extracted once at
  upload; 100,000 characters per project, with a warning above 50,000.
- A project's prompt is built in five levels, in this order: instructions,
  documents, project memory (in full), knowledge bases, past chats (searched).

## v0.4.0 — 2026-10-06

Pins: Cerea `0.4.0`, Pystino `0.3.0`, Authelia 4.39.22.

- **Project memory.** Notes kept per project, shared by everyone who can see
  it, added to that project's chats only (after personal memory). Members add,
  edit and delete them in the project's Memory section; the model has
  `remember_for_project` / `forget_for_project`. A deleted account's notes
  stay, shown as "deleted user". Follows `CHAT_MEMORY_ENABLED`.
- **Web search is chosen in Admin → Web search**, from the gateway's search
  backends (`WEB_SEARCH_MODEL` overrides it). With no backend set up, the
  web search switches are disabled and say so instead of doing nothing.
  Pystino 0.3.0: `/v1/search` accepts the chosen backend when the caller is
  granted it.
- **Code sandbox:** a file that could not be copied to `/mnt/data` shows as
  "not available" with the reason, and runs wait for copies in flight.

## v0.3.18 — 2026-10-06

Pins: Cerea `0.3.11`, Pystino `0.2.6`, Authelia 4.39.22.

- Cerea 0.3.11: a message retried, edited or resent after a stop keeps its
  attachments' extracted text. It used to carry the file by reference only, and
  the model was told no text could be read "and the reason was not recorded"
  while the text was stored under the earlier message.

## v0.3.17 — 2026-10-05

Pins: Cerea `0.3.10`, Pystino `0.2.6`, Authelia 4.39.22.

- Cerea 0.3.10: a subagent follows its session's Allow from its first turn
  (galopin answers the ask the session's rules allow; the machine's limit still
  asks, e.g. `bash=ask` by default). An ask that has already gone settles as
  "Already answered" instead of an opencode 404. In the agent view, approval
  rows never split the reply's text, a long subagent name no longer runs off a
  phone screen, and "A subagent is still running in the background" clears when
  it finishes. **Update galopin on each machine:** re-run the install line from
  the pairing dialog (`curl -fsSL <origin>/chat/galopin/install.sh | sh`) and
  restart `galopin run`; no re-enroll.

## v0.3.16 — 2026-10-05

Pins: Cerea `0.3.9`, Pystino `0.2.6`, Authelia 4.39.22.

- Cerea 0.3.9: a chat's attachments are available to code runs at
  `/mnt/data/<name>`, with their extracted text beside them as `<name>.md`
  (20 MB per file, 100 MB in total), and the model is told where. Code that
  opened an upload used to find nothing.

## v0.3.15 — 2026-10-05

Pins: Cerea `0.3.8`, Pystino `0.2.6`, Authelia 4.39.22.

- `./configure --terminal` turns on the browser terminal for agent machines
  (`CODE_TERMINAL_ENABLED`, off unless set; it needs `--agents`). A fresh
  install had no way to ask for it, so the terminal entry never showed. On an
  existing install: `./configure --terminal`, then `docker compose up -d`.
- Cerea 0.3.8: the pairing dialog says when the deployment has the terminal
  off; an agent follow-up that fails to send keeps its draft; the connector
  list no longer flips to "Could not load connectors" when two refreshes cross;
  account erasure also removes a run's file records.

## v0.3.14 — 2026-10-05

Pins: Cerea `0.3.7`, Pystino `0.2.6`, Authelia 4.39.22.

- Cerea 0.3.7: the Knowledge screen stores the embedding model it shows. With
  none stored it pre-selected the first one, and Save stored nothing, so
  knowledge kept reporting "no embedding model". After updating, open admin
  Knowledge and press Save once.

## v0.3.13 — 2026-10-05

Pins: Cerea `0.3.6`, Pystino `0.2.6`, Authelia 4.39.22.

- **Documents.** Old Word `.doc` files are read, even saved as `.docx`; Word,
  Excel and PowerPoint always go to the local reader; a PDF whose OCR model
  fails (a rate limit, say) is read by the local reader; the chat says why a
  file could not be read instead of "no readable text".
- **Scanned PDFs.** Pages without text become images, stored with the
  conversation and sent to models that read images (`CHAT_PDF_IMAGE_PAGES`,
  default 20, 0 turns it off).
- **The `homelab` preset runs the local document reader** (the new
  `documents` profile), so Office files are read there too. Re-run
  `./configure` on a homelab install to pick it up.
- **Knowledge bases index again.** They counted as ready only with a stored
  flag the Knowledge screen never set; now the embedding model decides. The
  extractor change no longer asks for a reason, and the setting says it covers
  chat uploads too.
- **Storage.** Deleting a conversation deletes its shared copies; deleting a
  project returns its chats to the list; "delete all" includes project chats;
  a daily sweep removes orphaned files after 24h. The gateway clears stored
  reply text after `GATEWAY_TRANSCRIPT_RETENTION_HOURS` (default 24).
- **Chat.** The current date and time in your timezone in every prompt, and a
  marker on a message sent after a long gap; long user messages fold behind
  "Show more"; the mobile terminal key bar is always shown and stays above the
  keyboard.
- **Identity.** The console can remove a previous identity provider nobody
  signed in through (README, Switching the identity provider).

## v0.3.12 — 2026-10-05

Pins: Cerea `0.3.5`, Pystino `0.2.5`, Authelia 4.39.22.

- Cerea 0.3.5: the model pill lists every model when there are ten or fewer,
  with no "More models" entry; beyond ten, the short list of recent picks and
  "More models" stay.

## v0.3.11 — 2026-10-05

Pins: Cerea `0.3.4`, Pystino `0.2.5`, Authelia 4.39.22.

- External IdPs that reject an unknown scope (Infomaniak answers `invalid_scope`
  to `groups`) can sign in: `./configure` asks the issuer's discovery which
  scopes it offers and writes `OIDC_SCOPES` (the chat) and `OIDC_SCOPES_JSON`
  (the gateway, which was hardcoded). `./configure --check` warns about a scope
  the issuer does not list; `--oidc-scopes` sets them by hand. The bundled
  Authelia is unchanged.
- Cerea 0.3.4: galopin enrollment asks only for the scopes the identity provider advertises, and refuses an enrollment that got no refresh token.

## v0.3.10 — 2026-10-04

Pins: Cerea `0.3.3`, Pystino `0.2.5`, Authelia 4.39.22.

- Relicensed to Apache-2.0. The licence file is now `LICENSE`;
  earlier releases keep the licence they were published under.
- Pystino 0.2.5 is the same code as 0.2.4 under Apache-2.0, its comments made organisation-neutral.

## v0.3.9 — 2026-10-04

Pins: Cerea `0.3.3`, Pystino `0.2.4`, Authelia 4.39.22.

### Gateway and console (Pystino 0.2.4)
- The console's "How it works" link (Configure opencode) opens the
  published documentation on GitHub Pages.
- Pystino's release manifest now names the Cerea release it was tested
  with (0.3.3) and pins every upstream image by digest; its release checks
  and full-stack CI run green on public images.
- Proven again from a fresh copy of the kit with an empty Docker login:
  configure, pull, up, sign in.

## v0.3.8 — 2026-10-04

Pins: Cerea `0.3.3`, Pystino `0.2.3` (published images), Authelia 4.39.22.

### Deployment
- **Public images.** The repositories are public, and the images are
  published on the GitHub Container Registry: `ghcr.io/paoloviviani/cerea`,
  `pystino-gateway` and `pystino-redaction`. `compose.yaml` now pins release
  versions (`0.3.3`, `0.2.3`) instead of commit tags, and `docker compose
  pull` needs no login. Proven on a fresh copy of the kit with an empty
  Docker login: configure, pull, up, sign in.
- Building the images yourself (`dev/build.sh`) is now only for development
  or unreleased commits. The README's "while the project is private" notes
  are gone.
- Documentation is published on GitHub Pages:
  https://paoloviviani.github.io/Cerea/ and
  https://paoloviviani.github.io/Pystino/.

## v0.3.7 — 2026-10-04

Pins unchanged from v0.3.6. Opt-in; nothing changes until you add the override.

### Deployment
- **Restic backups, as an override.** `tools/backup/` ships a `backup`
  service for `compose.override.yaml`: on a cron schedule it takes `.env`, a
  `pg_dumpall`, a `mongodump` and the two Authelia volumes in one pass (over
  the stack's network: no Docker socket, read-only mounts, the dumps in RAM)
  and stores them as one encrypted restic snapshot, on any restic backend or
  through rclone, configured by `RESTIC_*` variables in `.env`. Retention,
  `restic init` on first use, a periodic `restic check`, a healthcheck, and
  a `restore` command. README: "Example: backups with restic".
- **README, Backup and restore:** the manual backup tarred the Authelia
  volumes under `c/` and `d/` while the restore expected `authelia-config/`
  and `authelia-data/`; the backup now writes what the restore reads. Volume
  names take the project name (`P=`).

## v0.3.6 — 2026-10-04

Pins unchanged from v0.3.5. Documentation and `.gitignore` only; no restart
needed.

### Deployment
- **Your own services go in `compose.override.yaml`**, which Compose merges
  automatically and git now ignores, so `git pull` and `./configure` never
  touch it. The README's new "Adding your own services" section says which
  file belongs to whom, with a worked example: a NetBird client in the
  stack, the proxy in its network namespace, and no port published on the
  host. Proven on a throwaway stack with a stand-in for the NetBird client,
  through to a full sign-in.

## v0.3.5 — 2026-10-04

Pins: Cerea `sha-77d49f6` (unchanged, v0.3.3), Pystino `sha-39c4d51` (Pystino
v0.2.3), Authelia 4.39.22.

### Console and docs
- **"Configure opencode with Pystino"**: the console's Overview shows the
  opencode one-liner, filled in with this deployment's own address, next to
  the API keys, and again right after a key is minted. The docs home lists
  it first under "Where to go next".
- The documentation sites on `/docs/cerea/` and `/docs/pystino/` are
  rebuilt with every release (they had not been since 2026-09-29).

## v0.3.4 — 2026-10-04

Pins: Cerea `sha-77d49f6` (unchanged, v0.3.3), Pystino `sha-38a7b0f` (Pystino
v0.2.2), Authelia 4.39.22.

### Gateway
- **opencode without Cerea**: `curl -fsSL https://<your-host>/opencode/install.sh | bash`
  points a plain opencode at the gateway with an API key minted in the
  console. It merges into your global opencode config (other providers
  and settings kept, a backup written), lists the gateway's chat models
  with their limits, image input and reasoning levels, never takes the key
  on the command line, and can keep it out of the file entirely
  (`--key-in-env`). `--install-opencode` installs the tested opencode
  release (1.18.34). The gateway serves the script itself, so it always
  matches the gateway it points at.

## v0.3.3 — 2026-10-04

Pins: Cerea `sha-77d49f6` (Cerea v0.3.3), Pystino `sha-5f9a870`, Authelia
4.39.22.

### Agent machines (/code)
- **opencode is pinned to 1.18.34** (was 1.18.32). The release testing
  pipeline ran galopin's full real-opencode suite (421 tests) green on it.
  The pairing dialog's "Install opencode" line now installs 1.18.34;
  machines keep whatever opencode they have until that line is run again.

## v0.3.2 — 2026-10-04

Pins: Cerea `sha-ae67826` (Cerea v0.3.2), Pystino `sha-5f9a870`, Authelia
4.39.22.

### Agent machines (/code)
- **The agent composer's pills match chat's**: one shared style for both
  composers, so they cannot drift apart again. On a phone the Deny / Ask /
  Allow selector becomes three compact icons, like chat's toggles, and the
  whole row fits at 360px (before, "Allow" was cut off). Blue now means the
  active choice in both.
- **opencode releases are tested automatically.** The full real-opencode
  suite now runs in CI on the pinned release (on every galopin change and
  weekly) and daily on opencode's newest release, opening an issue when a
  release breaks galopin or is ready to adopt. The pinned version lives in
  one file, `agent/packaging/opencode-version`.

## v0.3.1 — 2026-10-04

Pins: Cerea `sha-ecacd73` (Cerea v0.3.1), Pystino `sha-5f9a870`, Authelia
4.39.22.

### Agent machines (/code)
- **An agent's thinking shows as a collapsible Thinking block**, the same
  as in chat, while it streams and after a reload. Before, it was printed
  as part of the answer while streaming and vanished on reload.
- **The pairing dialog's "Install opencode" line pins the opencode release
  galopin is tested against** (`--version 1.18.32`) instead of installing
  the newest one. Machines that already installed a newer opencode keep
  it until that line is run again.

## v0.3.0 — 2026-10-04

Pins: Cerea `sha-5069d60` (Cerea v0.3.0), Pystino `sha-5f9a870`, Authelia
4.39.22. Shipped in place on the live deployment: backed up, pinned, built,
sign-in checked.

### Upgrade: re-run the install and enroll lines on each agent machine
The Pair-a-machine dialog prints them. Re-enrolling gives the machine the
new galopin and the new defaults below, and fixes "The daemon lists no
models" (see the agent-machines section). Afterwards a stray `opencode.json`
left in the folder you enrolled from can be deleted. A machine that is not
re-enrolled keeps working with its old settings.

### Agent machines (/code)
- **Deny / Ask / Allow** replaces auto-accept: one setting per session in
  the composer, starting on Ask, including on machines enrolled earlier,
  with no re-enroll needed. "Always allow" on a card now means this session
  only, and can be removed.
- **Under Deny the model is told why** commands, edits, web access and
  subagents are unavailable (as a system instruction for the turn), so it
  says what it would run instead of reaching for other tools.
- **The Permissions line speaks plainly**: one row per capability (edit
  files, run commands, use the web, read files, work outside the project,
  ask questions…) with the answer that actually applies, a note where the
  machine's limit holds it down, and your "Always allow" grants with
  Remove. The raw opencode rules sit behind a troubleshooting toggle.
- **Pairing dialog**:
  - the machine's limit is three pills for all tools at once, with
    per-tool rows under Advanced;
  - terminals, slash commands that run shell, and background subagents
    are **on by default** (`--no-terminal`, `--no-command-shell` and
    `--no-background-subagents` turn them off);
  - two plain checkboxes replace the free-form rules: work outside the
    project folder, and read secret files, without asking;
  - the command prints one step and one flag per line.
- **The model list is no longer empty**: `enroll` writes `opencode.json`
  next to its credentials and records where, and `run` uses it. Before,
  the file landed in whatever folder you enrolled from and `run` never
  found it.
- Retry no longer brings back the turn it rolled back. An expanded
  Permissions panel scrolls instead of covering the composer.
- All of /code needs a sign-in within the last 7 days; the machine's own
  link is unaffected.

### Look
- The send button carries the accent colour, the composer is a raised
  card, the active chat is marked in the sidebar, and assistant replies
  have a visible edge.
- Faint text in dark mode reaches 4.5:1 contrast, in the chat and the
  console.

### Deployment
- **The bundled Authelia works on an IP address** (with `--tls internal`),
  with or without a port. Only single-word names such as `myserver` are
  refused, because Authelia itself rejects them. For an IP, `./configure`
  writes `DEFAULT_SNI_DIRECTIVE` so Caddy serves its certificate to
  browsers, which send no server name to an IP.
- The README explains how agent machines trust a `--tls internal`
  certificate, and suggests `<ip-with-dashes>.sslip.io` for anyone who
  prefers a name.

## v0.2.1 — 2026-10-02

UX follow-ups on top of v0.2.0. Pins: Cerea `sha-3e562ce9`,
Pystino `sha-0a03823` (unchanged, stays v0.2.0).

- A failed fresh send puts its text back in the composer for
  editing; retries, elicitation resumes and aborts never restore
  (their content lives in the thread with its retry).
- Signing out in a second tab clears this tab's matching draft;
  newer typing in this tab survives the event.
- MCP health checks and tool listings reuse pooled connections
  instead of a cold handshake every time (per-credential keys, so a
  check never borrows another caller's connection).
- The orphan sweep removes document rows whose base is gone,
  through `deleteDerived` like everything else.

## v0.2.0 — 2026-10-02

The first published release of the code. Pins: Cerea `sha-11327fc9`,
Pystino `sha-0a03823`, Authelia 4.39.22. Everything below shipped
in-place on the live deployment first, each wave backed up, pinned,
and live-checked before the next.

### Chat
- Composer drafts persist per conversation, and per device and agent
  in the /code panel (this device only; cleared on sign-out). A
  `?prompt=` link replaces a home-screen draft.
- The person's own messages render at full text contrast (they were
  the dimmest text on the page).

### Knowledge and projects
- Document ingestion is asynchronous: uploads return immediately and
  the document list follows the progress. A failed row shows its
  reason; a restart interrupts pending ingests, which read as failed —
  re-upload the file or press Reindex.
- One deletion path (`deleteDerived`) for everything derived from a
  source — conversation, document, base, erasure — plus a daily orphan
  sweep as the backstop.
- Memory lifecycle: a conversation deleted while its first indexing
  is in flight no longer resurrects its transcript; orphaned passages
  are never served by search; deleting a message clears the project
  transcript, which rebuilds on the next turn.
- The base's Delete button sits in the header beside Reindex.

### /code panel (agent machines)
- **Needs-you inbox**: every pending approval and question across
  machines, answerable inline at the top of /code with the same cards;
  answers anywhere make the ask vanish everywhere.
- **Background subagents**, opt-in per machine
  (`--allow-background-subagents`, denied by default, fail-closed):
  parent markers for running and completed background tasks, a
  still-running banner while the parent reads idle, and honest
  follow-up vs automatic labels.
- Enrollment and policy: the install one-liner prints the installed
  path; an **Install opencode** checkbox; a repo's own opencode
  config is **ignored by default** (`--allow-project-config` opts in)
  so a cloned repository cannot redirect the gateway or smuggle
  commands, agents or MCP servers; opencode's own providers stay off
  (`--allow-opencode-provider`).
- The terminal step-up window is 7 days (was 12 hours): opening a
  terminal requires a sign-in within the last 7 days.

### Known issues
- MongoDB 4.4 (the reference host CPU has no AVX; 5.0+ needs it) —
  the database port is not published.
- Two pre-existing WebKit scroll-anchoring test failures (Safari-only,
  reproduced on a clean tree).

## v0.1.0 — 2026-09-29 (tagged, not announced)

The first release: one stack, four components, tagged together. The kit
pins the images by sha; the component repos are tagged `v0.1.0` at exactly
the pinned commits.

**What shipped in this cycle** (the deployment's first two weeks of
in-place waves, each one backed up, pinned and live-checked):

### Identity and accounts
- OIDC-only sign-in, one identity provider for the console and the chat;
  a bundled Authelia operated from the Pystino console (Users page: add,
  create sign-in for users with no login, reset, disable, enable, delete);
  account link-by-email (off by default, never for administrators);
  merge and erasure; break-glass recovery; the last-admin guard serialized
  by a transaction advisory lock; an append-only identity audit trail;
  machine credentials for agent enrollment (long-lived refresh tokens,
  revoked on revalidation; a disabled account ends its machines' access
  within about a minute).
- The Users page fixes: renamed User sync, hidden for bundled/disabled
  rows, the Create-sign-in duplicate bug, row actions in the edit panel.

### The `/code` panel (agent machines)
- Pairing: the install one-liner prints the binary by its installed path;
  checkboxes for **Install opencode**, **Allow terminal** and **Allow
  auto-accept**; the machine policy table (files read-only with redaction
  defaults, terminals behind a veto, commandShell default denied,
  tighten-only changes); revoking a device confirms first.
- Native opencode **slash commands** through galopin: the `/` menu with
  panel, project, machine, skill and MCP groups; the machine-side gates
  (template expanded and scanned machine-side, the template never crossing
  the wire, first-run confirmation per (device, command, templateHash),
  plan-mode escalation refused, content-proven origins) — nine security
  review rounds' worth of hardening, all proven by live integration tests
  against opencode 1.18.32.
- **Images**: matplotlib figures captured automatically from chat code
  runs; the /code explorer renders raster images; agent tool-output images
  (screenshots included) render inline in the tool card, judged by their
  bytes in Cerea, nothing persisted server-side; oversized SSE lines skip
  and resync instead of killing the event stream.
- opencode models discovered at enroll carry their image capabilities
  (attachment + modalities) so vision models accept image reads.

### The chat
- Artifacts: inline file-artifact cards, versioned by content, the library
  panel; in-browser Python (Pyodide) with automatic package resolution and
  office libraries; knowledge bases and projects (pgvector retrieval that
  never fails a turn); MCP connectors with per-call approvals; web search
  through the deployment's backends, metered per person.

### The gateway (Pystino)
- Accounting, quotas and per-caller model access; the console; redaction;
  the identity section above; the Postgres-backed concurrency behaviors
  (last-admin advisory lock, merge `FOR UPDATE`, erasure `SKIP LOCKED`,
  append-only triggers) verified against a real Postgres in this cycle.
- A backup + **restore rehearsal performed end to end** (this cycle): the
  four parts restored into a scratch stack, provider credentials decrypted
  with the same secrets, a full sign-in completed against the restored
  identity provider.

### Operations and documentation
- The in-place deploy discipline (backup → pin → build → up → probes),
  the runbook in this README.
- Documentation sites for both Cerea and Pystino (mkdocs, strict builds),
  served at `/docs/cerea/` and `/docs/pystino/` by the stack's proxy, and
  publishable to GitHub Pages by workflow.

### Pins at the tag
- Pystino `sha-0a03823`, Cerea `sha-80b28f4` — exactly what this deployment
  runs. (The component repos' tips have moved past the pins by
  documentation-and-test commits only: the docs workflows, the docs voice
  pass, and the Postgres test fixture — none of it ships in the images.)
