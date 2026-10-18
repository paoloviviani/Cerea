# Changelog

All notable changes to this deployment kit are documented here. The
convention: newest first, one section per release, dated, with the pins it
shipped. Since the kit moved into the Cerea repository (see Unreleased), a
release is a Cerea tag `vX.Y.Z` and this file lives at `kit/CHANGELOG.md`.

## v0.15.8 — 2026-10-18

Pins: Cerea `0.15.8`, Pystino `0.9.4`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **A price typed at import can include cache rates** (Pystino 0.9.4). In
  **Models → Discover**, the manual price for a chat or embedding model now
  takes optional **cache read** and **cache write** rates per million tokens.
  Left empty, cached tokens are billed at the input rate, as before. This
  matters for providers that report cached tokens without publishing
  prices: Entrim, for example, reports `cached_tokens` on its chat models.
- `gateway seed` (a setup and development command) no longer creates the
  default provider without its upstream key.

## v0.15.7 — 2026-10-18

Pins: Cerea `0.15.7`, Pystino `0.9.3`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **Models with no published price can be imported with a price typed in
  the dialog** (Pystino 0.9.3). In the console, **Models → Discover** now
  offers price fields for each unpriced row it lists (input and output per
  million tokens, or per page for OCR). An "apply to all ticked" control
  helps with a provider that charges one rate for many models. The price is
  recorded in the model's price history as entered by hand. A price the
  provider publishes, or one from the community file, always wins over a
  typed one, and the result says so.
- **The console is ready for translation.** Every console text now comes
  from a message catalogue instead of being written into the screens.
  English is still the only language and looks exactly as before. Dates and
  numbers still follow your browser's locale.
- The release check now starts the chat against a model with no display
  name, so a startup failure like 0.15.5's blocks a release.

## v0.15.6 — 2026-10-17

Pins: Cerea `0.15.6`, Pystino `0.9.2`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **Fixes 0.15.5's boot loop: the chat restarted endlessly.** The gateway
  lists a model with no display name as `display_name: null`, and 0.15.5's
  catalogue refused the whole list over it, so the chat could not start on
  any deployment with an unnamed chat model. A missing, null or blank display
  name now just falls back to the model's id. If you pinned back to 0.15.4,
  remove the pin (or set `CEREA_VERSION=0.15.6`) and update.

## v0.15.5 — 2026-10-17

Pins: Cerea `0.15.5`, Pystino `0.9.2`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **Models can have a friendly name.** In the console, a model's page has a
  **Display name** field next to the name callers send (Pystino 0.9.2). The
  models list shows the display name first, with the id beneath it when they
  differ. The chat's model picker shows the display name and falls back to
  the id. The id itself doesn't change, so existing conversations, custom
  models and API clients are unaffected. A rename reaches the chat at the
  catalogue's next refresh.

## v0.15.4 — 2026-10-17

Pins: Cerea `0.15.4`, Pystino `0.9.1`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **The app recovers on its own instead of needing a reload.**
  - An open agent chat whose connection dropped (a server restart, a deploy,
    a network change, a laptop waking up) now reconnects by itself instead of
    staying dead until the page was reloaded.
  - Coming back to the tab or the installed app, or getting the network back,
    refreshes what is on screen at once.
  - A sign-in that lapsed while the page was open now leads to the sign-in
    page instead of a frozen machine list.
- **A reload button in the sidebar footer** (the circular arrow next to the
  theme switch and sign-out), the only way to refresh the installed app. When
  a new version is deployed, a small banner offers to reload.
- **Invited people stop showing as "Invited" once they sign in** (Pystino
  0.9.1). Claiming an invitation now consumes it, and the upgrade clears the
  badge from accounts that were already claimed.

## v0.15.3 — 2026-10-16

Pins: Cerea `0.15.3`, Pystino `0.9.0`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **Installed Android PWA no longer cuts the composer off after login.**
  Returning from the Authelia screen could leave the viewport height stuck
  at the taller in-tab value, pushing the chat input below the fold with no
  way to scroll it back short of restarting the app. The shell now tracks
  the window's measured height (re-read on every return to the page) and
  clears the system gesture bar, so the composer stays visible.

## v0.15.2 — 2026-10-16

Pins: Cerea `0.15.2`, Pystino `0.9.0`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **The model can read PDFs from the web.** A PDF (or a Word, Excel,
  PowerPoint, OpenDocument or e-book file) that `web_fetch` reaches is now
  read by the document reader, the same one an attached file uses, instead
  of arriving as binary. It is recognised by its type or its bytes, also
  when the server calls it `octet-stream`, and with either fetch backend.
  It is read once per turn, however many times the model pages through it.
  A fetch approved from a card is read with the approver's access. If the
  reader can't read it, the model is told why.
- **Long pages arrive in chunks.** `web_fetch` takes an `offset`, and each
  chunk ends with where to continue, so a long article or paper can be
  read to the end instead of stopping at the first 24,000 characters.
  Paging within a turn neither refetches the page nor counts toward the
  20-page limit.
- **Direct fetches keep the article, not the page around it.** With
  `FETCH_BACKEND=direct`, HTML goes through Readability before the model
  sees it, so navigation, headers and footers no longer use up the budget.

## v0.15.1 — 2026-10-16

Pins: Cerea `0.15.1`, Pystino `0.9.0`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **Web search on by default for new accounts.** New settings documents
  start with web search on, so new chats inherit it through the existing
  chain (per-chat state, then the project default, then the app setting,
  then off). Existing accounts keep whatever they set — an unset field
  still resolves as off — and the toggle stays in Settings → Application.
  The tool itself is still only offered when the gateway grants the caller
  a search backend, so deployments without search are unaffected.

## v0.15.0 — 2026-10-16

Pins: Cerea `0.15.0`, Pystino `0.9.0`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`), then
**machines need the galopin update** (install step only, then
`systemctl --user restart galopin`).

- **galopin answers permission requests instead of writing rules into
  opencode (ADR 0097).** Every tool call now asks, and galopin answers it
  — refused, allowed once, or a card — from the machine's ceiling, the
  session's mode and its exceptions. Nothing is written into a session any
  more, so sessions stop growing thousands of rules and a new subagent no
  longer inherits a stale deny. "Allow always" is kept by galopin, not by
  opencode. The machine ceiling is unchanged and still set only on the
  machine (`galopin enroll` / `galopin policy set`), which now warn when
  edits or the web are capped but `bash` is not (a command can do either).
  Until an OS sandbox exists the ceiling is advisory against `bash`; the
  docs say so.
- **The session selector reads Plan · Ask · Allow.** Deny is folded into
  Plan: the plan agent, and galopin refuses anything that would change
  something; reading still works. Ask and Allow run the build agent. The
  agent picker now lists only your own custom agents. Existing Deny
  sessions and schedules read as Plan.
- **Upgrade note: sessions from before this release** get one final
  "everything asks" rule the first time galopin sees them. A stale deny
  already stored in them can still refuse their new subagents (the "An
  earlier Deny is stuck" banner stays for those sessions only): start a new
  session.
- **Delegated sessions report back (ADR 0099).** A session started with
  `session_spawn` is a delegate: its spawner reads it and the two message
  each other without a card (the machine's own rules still win). When a
  turn the spawner started ends, galopin hands the delegate's final message
  back to the spawner, plus one notice if it fails or waits on your
  approval; reports wait while the spawner is busy and survive a restart.
  `report: false` turns it off. The delegation skill is rewritten around
  situations, with a briefing template.
- **A document reader closed to someone falls back to the local one.** When
  the reader chosen on the Knowledge screen (or `CHAT_OCR_MODEL`) is
  restricted to groups a person is not in, their PDFs are read by the local
  reader when there is one, and otherwise the file is stored without text
  with a plain reason instead of the gateway's refusal.
- **Knowledge bases accept documents and text only.** The type is read from
  the file's bytes: PDF, Word, Excel, PowerPoint, OpenDocument, e-books and
  text (UTF-8 or Windows-1252, as Excel exports CSV) are accepted; images,
  archives and other binaries are refused with a message saying what is
  accepted. A binary file already in a knowledge base fails its own
  reindex with that reason instead of being indexed as garbage.
- **`./configure --fetch` / `--no-fetch` adds or removes the headless
  browser on any preset.** Before, the `fetch` profile came only with the
  enterprise preset or by editing `COMPOSE_PROFILES` by hand. On an existing
  deployment, `./configure --fetch && docker compose up -d` adds the profile,
  sets `FETCH_BACKEND=playwright` and the renderer address; `--no-fetch`
  removes them (a renderer you pointed at elsewhere is left alone, and said
  so). Without the flag nothing changes. The summary shows whether the
  browser is on.

## v0.14.0 — 2026-10-15

Pins: Cerea `0.14.0`, Pystino `0.9.0`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **Group quotas can apply to the group's total or to each member.**
  Console → Quotas offers **"Applies to"** when a rule targets a group:
  the group's total (today's behaviour — every existing rule stays "total")
  or each member, in which case a member's cap counts only what *they* had
  billed to the group. A group may hold both kinds at once — e.g. a €500
  total and a €50 per member — and a request must pass every rule that
  matches it. The rules list prints the mode with the limit ("€50/month per
  member"), the health table reports one row per member with their name, and
  a 429 says whose budget ran out: the member's share or the group's total,
  never anyone else's usage.
- **The usage page labels per-member bars.** A per-member rule appears to a
  person as their own limit and their own consumption, marked "per member",
  beside the group's aggregate bar (`applies_to` on the usage document,
  additive).

## v0.13.3 — 2026-10-15

Pins: Cerea `0.13.3`, Pystino `0.8.2`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **Pystino 0.8.2: the usage page's notes collapse to one line.** The
  console's usage disclosures — the caveats above the figures on Your usage
  and the admin chargeback screen — start collapsed to a single warn-toned
  line naming the count and carrying the first note, opening onto the notes
  exactly as before. The notes stay in the page behind `hidden`, and the
  open-or-closed choice is remembered per page.

## v0.13.2 — 2026-10-15

Pins: Cerea `0.13.2`, Pystino `0.8.1`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **The Chats/Agents switch follows the person's capability.** The sidebar
  switch and every `/code` entry point are now decided per person, from the
  gateway's `/v1/me` `capabilities.code_agents` (ADR 0096): the client's
  feature-flags answer used to be the deployment-wide
  `CODE_AGENTS_ENABLED`, so a person the gateway denies still saw the
  switch, and every click 404'd. The decision now denies until the gateway
  says true — no token, a refusal, or a capabilities block that does not
  grant the flag all hide the switch and 404 the routes as before — and,
  when the gateway cannot be asked, rides the person's last valid answer
  for five minutes (the machine link's grace) before hiding, so one blip
  no longer hides /code from everyone for the length of the `/v1/me`
  cache. An older gateway (a `/v1/me` body carrying no `capabilities` key
  at all) still reads as allowed, so an upgrade locks nobody out. Without
  a gateway the env switch alone decides, unchanged.
- **No welcome screen.** The first-visit modal is gone — it marked `#app`
  inert until dismissed and every test had to seed around it — with its
  `welcomeModalSeen` settings plumbing end to end. Stored settings
  documents may keep a stray `welcomeModalSeenAt`: it is ignored, no
  migration.

## v0.13.1 — 2026-10-14

Pins: Cerea `0.13.1`, Pystino `0.8.1`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **Capabilities are per group.** A person holds coding agents or API keys
  as an administrator, or through an active membership in a group carrying
  the flag — the old everyone/groups setting is gone as a rule.
  **Console → Settings** sets what *new* groups start with (`ACCESS_*`,
  now `on`/`off`; the old spellings still parse for one release) and offers
  **Turn on/off for all groups** with a preview of how many people gain or
  lose it; **Console → Groups** carries the two toggles. Keys are refused,
  not deleted; machines close and reconnect when access returns. The
  upgrade keeps everyone's access: migration 0060 turns the flag on for
  every existing group where "everyone" was in force, and leaves flags
  alone where "groups" was. The kit passes the two `ACCESS_*` variables to
  the migrate service for exactly that fold.
- **Failure banners in /code.** After a reload every failed turn shows its
  banner again (older ones collapsed to one line); previously only the last
  survived. The "check the provider's credit" hint still appears only on a
  live failure, not after a reload.
- **Docs.** Copyable commands use `$GATEWAY_BASE_URL`, `$CEREA_BASE_URL`
  and `$OIDC_ISSUER` instead of example hosts (already on `main` as
  `b53a0df7`; Pystino's docs as `1fa9d64`).
- **Fixed:** the Groups page's capability checkboxes always showed off
  after a refetch, even when a flag was set — the group list answered both
  flags as `false` regardless of the stored value.
- **Fixed:** on a fresh install the default group now gets the deployment's
  capability defaults when it is created (Pystino `0.8.1`), so new people
  are no longer chat-only.
- **CI:** the boot specs no longer start an in-memory Mongo (it crashed on
  runners without AVX); they use the test Mongo.
- v0.13.0 was tagged and its image published, but never released: its kit
  pinned Pystino 0.8.0, whose default group made new people chat-only.

## v0.12.0 — 2026-10-14

Pins: Cerea `0.12.0`, Pystino `0.7.1`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

(Pystino `0.7.0` was tagged but never released — its stack caught a
startup refusal the capability check tripped on the compose default; that
check is semantic now, and `0.7.1` is the release.)

- **Chat-only people.** The gateway can now restrict who may use coding
  agents and who may hold API keys: **Console → Identity** sets each
  capability to everyone or to flagged groups (with a preview of who would
  lose it), and **Console → Groups** carries the two toggles. A person with
  neither is badged **Chat only** on Users; their chat keeps working while
  `/code` reads as hidden. Keys are refused, not deleted — regaining the
  capability restores them — and a machine whose owner loses the capability
  closes and reconnects by itself when access returns, never revoked.
- **New variables, both defaulting to open.** `ACCESS_CODE_AGENTS` and
  `ACCESS_API_KEYS` (`everyone`, or `groups` for flagged groups only); the
  console's decision wins once it saves. The kit passes the machine client
  through to the gateway now, so a renamed client (a GitLab app uid) matches
  instead of silently passing chat-only machines.

## v0.11.2 — 2026-10-13

Pins: Cerea `0.11.2`, Pystino `0.6.0`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`).

- **A fork always carries the conversation.** The fork dialog's "Carry the
  conversation up to here" toggle is gone: "Fork from here" now always
  seeds the new session with the conversation up to the chosen message —
  a fork without it would just be a brand-new session, which is not what
  the action promises. The route's `carry` flag stays optional for other
  callers.

## v0.11.1 — 2026-10-13

Pins: Cerea `0.11.1`, Pystino `0.6.0`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`), then
**machines need the galopin update** (install step only, then
`systemctl --user restart galopin`).

- **IdP groups reach local groups only through a mapping.** A group name
  from a token resolves through the console's group mappings and nothing
  else — an unmapped name resolves to nothing, even when a local group
  carries the same name (IdP group namespaces are user-writable; a
  same-name claim is not a vouch). **"Import" is now "Map"**: the Groups
  page's Map dialog asks what the name means here — a new group with the
  same name, a new group under another name, or an existing group — and
  the mapping is what the token resolves through. Migration 0058 keeps
  existing memberships by adding self-mappings (name → the same group),
  except where a mapping already exists (a key, or a target: those came
  through the mapping) or group mode requires a hand-made group; review
  them in **Console → Groups**. A mapping trusts the IdP name, so remove
  it if the IdP group is deleted — if the real IdP group is deleted and
  someone else re-creates that name there, the mapping trusts the new
  one.
- **Agents can find their own subagents again.** `session_list` skipped
  every session with a parent id, including the caller's own task
  subagents — a session with five finished children told the person it
  had launched none. A caller now sees the subagents at or below itself
  in its own tree, with the subagent type, the last-activity time and the
  `task_id` resume handle; `session_send` to an own-tree id stays
  refused.
- **Older failure banners collapse.** When several turns failed, every
  failed-turn banner started expanded and stacked into a wall; only the
  most recent one starts open now, older ones fold to one line with a
  chevron.
- **Drag and drop files onto the agent composer.** The /code panel's
  composer takes dropped files through the same allowlist and upload flow
  as the chat composer's picker.

## v0.11.0 — 2026-10-13

Pins: Cerea `0.11.0`, Pystino `0.5.0`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`), then
**machines need the galopin update** (install step only, then
`systemctl --user restart galopin`).

- **"Who may join" is one setting, for any identity provider.** The
  gateway's four join modes (`open`, `approval`, `invite`, `group`) replace
  the provisioning checkbox and refusal rule; the console's Identity page
  asks as a radio group and previews a group gate ("N people will lose
  access") before saving. `./configure` asks the question for an external
  IdP — `approval` is a new install's default, an existing `.env` keeps its
  behaviour — and `group` mode also asks for the local group names and the
  fallback, refusing to write a gate that would refuse to start. New env
  keys `OIDC_JOIN_MODE`, `OIDC_REQUIRED_GROUPS`, `OIDC_GROUP_FALLBACK`
  (documented in the kit README's identity section).
- **Invitations for every provider.** The console invites a person by
  email for any IdP that creates no logins — a pending account claimed at
  first sign-in by verified email, invitations expiring after 14 days with
  re-issue, optional delivery through the configured SMTP (a failed send
  leaves the invitation standing). A person the directory pushes is claimed
  the same way instead of duplicated.
- **The approval queue on the Users page.** Filter chips with counts
  (Awaiting approval, Invited, Active, Disabled); an invited row is badged —
  with an expiry marker and re-issue — and an awaiting row carries Approve
  (Reject is Delete).
- **One group-mapping surface.** The Groups page's panel lists every seen
  IdP name with one decision — import, map to an existing group, or ignore —
  with the current mappings and their Unmap; Settings points there.
- **A machine survives losing its group.** The gateway refuses `/v1` with
  `403 outside_access_groups` (never the 401 that would make the chat
  revoke the device), Cerea closes the link with a new `4404` close code
  and the machine retries; regaining the group reconnects it. galopin and
  the protocol document the code.
- **`pystino idp check` fails loudly when the issuer cannot run the device
  flow** (no `device_authorization_endpoint`, or a grant list omitting it —
  Infomaniak, 2026-10-10), names the effective join mode, and warns in
  invite mode when the provider's tokens carry no `email_verified`.
  `./configure` makes the same check a blocking warning with an explicit
  continue-without-agent-machines choice.
- **The group gate holds on every sign-in and every API call.** The
  gateway admits only members of the required groups — strangers refused,
  people who lost their last required group refused with `403
  outside_access_groups` (never a 401), administrators exempt everywhere —
  and the console's Identity page previews who loses access before saving.
- **The README and the docs home read as one shelf.** The README places
  Cerea beside Pystino before calling it the gateway, and the docs home
  places Pystino beside Cerea; each links the other's context.
- **The agent transcript no longer runs Python fences.** Fenced code in
  the agent view renders as text — nothing executes there.

## v0.10.17 — 2026-10-12

Pins: Cerea `0.10.17`, Pystino `0.4.2`, Authelia 4.39.22. No galopin update —
the changes are Cerea-only.

- **The top tab selector is more compact on phones.** Workspace, Settings,
  Admin and the project page's bar all run smaller text, tighter padding
  and smaller gap below `sm`. The Workspace page's tabs now read two rows
  on a 390px phone (133px down to 66px); the tab once called Customize
  models reads **Custom models**, with memory moved ahead of MCP Servers.
  The `?tab=custom` address is unchanged. Cerea only.
- **Attached pictures sit as thumbnails above the agent composer's input.**
  An image rendered at full preview size inside the input's row squeezed
  the textarea to a sliver; pending attachments now render on their own
  line at the top left — small tiles for images, the existing cards for
  everything else — so the text keeps its width. Cerea only.
- **The agents panel leads with Schedules and drops the machine gutter.**
  Schedules moved from under the devices to the top of the list. Machine
  rows read bolder and a touch larger with no gutter under them:
  workspaces start at the left edge, machines are separated by vertical
  space, and the workspace rail opens a chevron slot wider so a session's
  marker starts clearly right of its workspace's folder icon. Cerea only.

## v0.10.16 — 2026-10-12

Pins: Cerea `0.10.16`, Pystino `0.4.2`, Authelia 4.39.22. Update the
deployment (`docker compose pull && docker compose up -d`), then **machines
need the galopin update** (install step only, then
`systemctl --user restart galopin`).

- **A GitLab machine no longer has to re-enroll after its first token
  refresh.** Two bugs met. galopin's renewal at 70% of the token's life
  pushed the *same* token, found the renewal still due and pushed it again
  with no wait, thousands of frames until the token's last minute; and when
  it finally refreshed, GitLab revoked the old token at once, the chat's
  minute check still held it, the gateway refused it, and the chat revoked
  the device. galopin now rotates the token when renewal is due and pushes
  it once (at most once a minute), and the chat tells a refused token from a
  refused account: a token that no longer validates closes the link with
  4401 so the machine renews and reconnects, and only a still-valid token the
  gateway refuses revokes the device.
- **A revoked machine can be removed from the list.** A machine the gateway
  refused stayed in the panel as **access revoked** with no way to remove
  it; it now has a bin icon, which takes it off the list.

## v0.10.15 — 2026-10-12

Pins: Cerea `0.10.15`, Pystino `0.4.2`, Authelia 4.39.22. Only the chat
changes: `docker compose pull && docker compose up -d`; machines need no
galopin update.

- **Administration → Storage: how long produced files are kept.** Files the
  assistant's code writes (documents, spreadsheets, charts) were kept a fixed
  30 days. The new **Storage** tab sets the period, or **Never expire**, and
  says how many files a shorter period would delete before it is saved.
  `CHAT_FILE_RETENTION_DAYS` sets the default from the environment (empty: 30).
- **Expired produced files now free their bytes.** The fixed 30 days was
  enforced twice, by a database TTL on the files' records and by an hourly
  sweep that finds the files through those records; the TTL usually won, so
  the bytes were left in GridFS for good. The sweep alone expires files now,
  bytes and records together, and also frees the bytes already orphaned (on
  the first start, after an hour's grace for uploads in flight).

## v0.10.14 — 2026-10-12

Pins: Cerea `0.10.14`, Pystino `0.4.2`, Authelia 4.39.22. Only the chat
changes: `docker compose pull && docker compose up -d`; machines need no
galopin update.

- **A GitLab-enrolled machine connects.** After a successful enroll, the
  machine's link to the chat was refused with HTTP 401 on every attempt: the
  chat checked the machine's access token as a JWT, and GitLab's are opaque.
  The chat now checks an opaque token at GitLab's `/oauth/token/info` with
  the token itself, at an issuer whose introspection endpoint is
  Doorkeeper's: the token must belong to the machine client
  (`OIDC_MACHINE_CLIENT_ID`) and expire, and its subject is userinfo's. Only
  the chat changes: `docker compose pull && docker compose up -d`; no
  galopin update.

## v0.10.13 — 2026-10-12

Pins: Cerea `0.10.13`, Pystino `0.4.2`, Authelia 4.39.22. **Machines need the
galopin update** (install step only, then `systemctl --user restart galopin`)
and the deployment needs the new gateway (`docker compose pull && docker
compose up -d`) for these fixes.

- **Agent machines enroll with GitLab.** GitLab's discovery lists the device
  grant but not its device endpoint, so a headless `galopin enroll` stopped at
  *no device endpoint advertised*. galopin now uses GitLab's
  `<issuer>/oauth/authorize_device` when the device grant is listed and the
  authorization endpoint is Doorkeeper's, says so, and takes
  `--device-endpoint URL` for any other provider that leaves it out.
- **The gateway accepts galopin's GitLab tokens** (Pystino 0.4.2). They are
  opaque and issued to a public application, so introspection could never
  vouch for them; the gateway now asks GitLab's `/oauth/token/info` with the
  token itself, for accepted clients that are neither the console nor the
  chat. Set `OIDC_MACHINE_CLIENT_ID` to the GitLab application's id; the
  default `opencode-enrollment` cannot exist on GitLab.

## v0.10.12 — 2026-10-12

Pins: Cerea `0.10.12`, Pystino `0.4.1`, Authelia 4.39.22. **Machines need the
galopin update** for the sync-sweep fix: update the deployment first (the
install line downloads galopin from it), then re-run the install line from
the pairing dialog, then `systemctl --user restart galopin`.

- **A sync sweeping a Deny session's seeded asks rejects each once.** The
  sweep consulted the same pre-filter a live ask takes, which consumes an
  ask and sends its rejection from its own goroutine — and then rejected
  the same ask again, synchronously: two replies, two audit rows, per ask
  of a Deny root whose view a sync rebuilt. The flake that had been
  failing the suite's Deny-sweep test at roughly one run in fifty, and
  three CI runs today. The sweep now only withdraws the card; the
  rejection goes out once, through the filter. Needs the galopin update.
- **The phone terminal's key bar is three full rows.** It broke nine keys,
  then eight, then a lone Type pill on an empty row. It now fills three
  rows of nine: modifiers and motion first (Esc, Tab, Ctrl, Alt, the
  arrows, `|`); a shell punctuation row — `$ > " ' * &`, six keys the bar
  never had; and the actions row, where `^U` (kill line) joins `^C` and
  `^D` beside Paste and the font steps, with the typing-mode toggle
  anchoring the row's right side under the thumb. Cerea only.

## v0.10.11 — 2026-10-11

Pins: Cerea `0.10.11`, Pystino `0.4.1`, Authelia 4.39.22. **Machines need the
galopin update** for the model-capability fix, in this order: update the
deployment first (the install line downloads galopin from it), then re-run
the install line from the pairing dialog, then
`systemctl --user restart galopin`.

- **The machine now reports which models take images.** galopin read the
  image claim out of opencode's `/config/providers` answer at the wrong
  shape — the resolved entry nests it under `capabilities` (the boolean
  `attachment` beside the input modality `input.image`), and the reader
  looked at the top level — so no model ever arrived at Cerea claiming
  images, and v0.10.10's composer affordance failed closed everywhere:
  no session ever saw "Add image(s)". The reader now takes any affirmative
  claim from the resolved shape (and keeps the older top-level shape for a
  backend that still serves it), pinned against the real opencode by a new
  integration test. Needs the galopin update; the Cerea side needs nothing.

## v0.10.10 — 2026-10-11

Pins: Cerea `0.10.10`, Pystino `0.4.1`, Authelia 4.39.22. No galopin update —
the change is Cerea-only.

- **Pictures can be attached to agent sessions.** The whole path existed and
  was never offered: the upload route, the wire's `session.prompt`
  attachments, galopin and opencode all take images — but the composer's
  "Add image(s)" item is gated on the session's model claiming them, and
  nothing agent-side passed that, so the + menu showed only text files and
  documents. The provider list now carries the machine's per-model
  `images` flag and the composer reads the session's own model (or the
  backend's default): the picker item and a paste that keeps screenshots
  as chips appear when the backend takes images and the model claims them,
  and stay hidden otherwise. The transcript already renders the
  attachments a user message carries, images included. Cerea only.

## v0.10.9 — 2026-10-11

Pins: Cerea `0.10.9`, Pystino `0.4.1`, Authelia 4.39.22. No galopin update —
the changes are Cerea-only.

- **The /code terminal copies and pastes.** xterm's defaults swallowed the
  browser's clipboard machinery: Ctrl+C always reached the shell as SIGINT
  even over a selection, and Ctrl+V reached it as `^V`, so the only working
  paths were the undiscoverable right-click menu and, by accident, macOS's
  Cmd chords. Now copy wins over SIGINT while a selection exists, Ctrl+V
  pastes (bracketed-paste aware), and Ctrl+Shift+C writes the clipboard
  itself instead of opening DevTools. The phone key bar gains a Paste
  button. Copying out of the terminal on a phone is unchanged — canvas
  rendering has no touch selection. Cerea only.
- **The project page is two tabs.** Conversations — the count strip, New
  chat and the chat list — open by default on `/projects/<id>`; Settings
  (`?tab=settings`) carries everything that configures the project: the five
  context levels, the fields, knowledge bases, the defaults for new chats,
  sharing and delete. Addressed like the workspace panel, and a tab switch
  never remounts the page, so the loaded project and unsaved edits survive
  it. `/projects/new` has no tab bar. Cerea only.

## v0.10.8 — 2026-10-11

Pins: Cerea `0.10.8`, Pystino `0.4.1`, Authelia 4.39.22. No galopin update —
the change is Cerea-only.

- **The web app manifest is built from the deployment's base path, and
  carries what an install sheet scores.** The static manifest hardcoded
  `/chat` into its start URL and every icon source — correct only for a
  deployment built with that base — and had no `id`, `scope`,
  `theme_color`, `description`, `shortcuts` or `categories`. It now comes
  from a route (`/manifest.webmanifest`): every URL derives from the
  compile-time base, the `id` resolves to the address browsers already
  derived from the old start URL (already-installed apps keep their
  identity), the theme colours match the page, and the shortcuts list
  Chats, Projects and Agents — Agents only when the deployment serves the
  code panel. The route answers with no session, as the static file did.
  Cerea only.

## v0.10.7 — 2026-10-11

Pins: Cerea `0.10.7`, Pystino `0.4.1`, Authelia 4.39.22. No galopin update —
the change is Cerea-only.

- **Thinking is collapsed by default.** A streaming turn auto-expanded its
  thinking section and folded it again when the answer began, so the
  reasoning scrolled by whether the reader wanted it or not. The section
  starts closed now and only a click opens it — streaming included; the
  shimmering "Thinking" header stays the live indicator, and a section
  expanded by hand during streaming keeps the tail-following view with its
  fade. Cerea only.

## v0.10.6 — 2026-10-11

Pins: Cerea `0.10.6`, Pystino `0.4.1`, Authelia 4.39.22. **Machines need the
galopin update** for this fix: the install step only (no re-enroll), then
`systemctl --user restart galopin`.

- **A task subagent reports to its parent in its final message; galopin now
  cards every other send it makes.** A background subagent that
  tried to `session_send` its parent was refused (correctly — same tree),
  then picked the only other session its `session_list` showed and
  auto-sent that session a file's contents, because its root was on Allow.
  Now: `session_list` marks the parent's row "report to it in your final
  message; it is delivered automatically, do not session_send it"; the
  `session_send` tool and the delegation skill say the same; and a send from
  a task subagent (a session with a parent in the tree — a `session_spawn`
  child is a root and is unaffected) is never auto-approved: it always shows
  the card, marked `fromSubagent` with the parent's title, whatever the
  rules, the Allow word or a schedule's coordination grant say. The card
  shows the sender as "a task subagent of \<parent\>". Audited as before.

## v0.10.5 — 2026-10-11

Pins: Cerea `0.10.5`, Pystino `0.4.1`, Authelia 4.39.22. **Machines need the
galopin update** for these fixes: re-run the install line from the pairing
dialog (not the pairing line itself), then `systemctl --user restart
galopin`.

- **A session that was once on Deny no longer poisons its subagents.**
  In Deny mode the session's rules now say ask and galopin itself refuses
  every call with a message naming the word and the way out — no card is
  ever shown — so a parent that was on Deny and back on Ask or Allow spawns
  subagents whose first turn runs instead of being refused. A Deny chosen
  mid-turn takes effect at once, from the next ask. Needs the galopin
  update.
- **Sessions stuck with an earlier Deny or machine policy say so.** A
  session whose stored rules still carry an old Deny block (or a deny the
  ceiling no longer imposes) shows a one-line banner: subagents started
  from it have their first turn refused — start a new session. If a task
  subagent reports its tools refused on its first turn, the model now
  resumes it once with the same `task_id`. Needs the galopin update.
- **opencode models pinned outside the gateway are reported.** A global
  agent file or config key pinning a non-Pystino model bypasses the
  gateway — and breaks background subagent results once its provider is
  unreachable. galopin scans those sources at every start and warns (log,
  audit, status file and device card) without editing them. With
  `--allow-free-models` the generated config now allows the `pystino` and
  `opencode` providers. Needs the galopin update.

## v0.10.4 — 2026-10-11

Pins: Cerea `0.10.4`, Pystino `0.4.1`, Authelia 4.39.22. **Machines need the
galopin update** for this fix: re-run the install line from the pairing
dialog, then `systemctl --user restart galopin`.

- **A deleted subagent no longer lingers in its session's permissions or
  subagent count.** Deleting a subagent session in opencode left it in
  galopin's memory: every later permission change on the parent session
  failed with "a subagent under it could not be given them" — one 404 per
  deleted child — and the panel kept showing the deleted subagents under
  the session. galopin now forgets a child opencode answers 404 for when it
  re-applies a session's rules, and drops the child edges its memory holds
  for children opencode's own listing no longer has, so the count drops
  with the deletions. Needs the galopin update.
- **Schedules can stop after N occurrences instead of running for ever.**
  An optional "Stop after N runs" on a schedule switches it off once that
  many scheduled fires have happened — a run that sent or failed counts;
  skipped and missed runs, and a manual Run now, do not. The list row shows
  how far it has got, agents can set the cap through schedule.create and
  schedule.update, and clearing it runs the schedule for ever again.
  Cerea only.

## v0.10.3 — 2026-10-10

Pins: Cerea `0.10.3`, Pystino `0.4.1`, Authelia 4.39.22. No galopin update —
the change is Cerea-only.

- **Word documents in the preview keep their formatting** (fonts, styles,
  lists, tables, headers and footers). A .docx preview rendered with no
  fonts, sizes, paragraph styles, list numbering, table borders or page
  geometry: DOMPurify dropped the `<style>` block docx-preview leads its
  output with (a fragment that begins with `<style>` parses into `<head>`,
  which a body-fragment sanitizer discards). The shared render now sanitizes
  with `FORCE_BODY`, renders headers, footers and footnotes, and the side
  pane's docx preview gained the fit-to-width script the artifact panel
  already had.

## v0.10.2 — 2026-10-10

Pins: Cerea `0.10.2`, Pystino `0.4.1`, Authelia 4.39.22. **Machines need the
galopin update** for steering and for subagents keeping their tools: re-run
the install line from the pairing dialog, then
`systemctl --user restart galopin`.

- **Sending while a turn runs (steer) works again: galopin never advertised
  it.** `buildHello` omitted `steer` and `agentTools` from the capabilities
  it sends, so Cerea read both as false and the composer never offered Send
  beside Stop on a running turn. It sends every capability the backend
  reports now, checked by a test that walks the capability struct. Needs the
  galopin update.
- **Subagents keep their tools when the session was once on Deny.** opencode
  starts a task subagent with only its parent's deny rules, and session rules
  only ever grow, so a session switched to Deny even once (for a second) gave
  every later subagent a first step with **no tools at all**: the model could
  only answer in text, and a background subagent ended there. galopin now
  opens every rule block with a deny that can never apply, which keeps the
  children's tools visible without changing any decision; sessions affected
  before this release recover on their next message. Upstream:
  anomalyco/opencode#45078. Needs the galopin update.
- **A subagent's model line names the model it actually runs on**, instead of
  the machine's default model ("Claude Sonnet 4 · Default"): galopin reports
  it from the subagent's own messages. Needs the galopin update.
- A server test that hung in CI (the account-erasure test for chat
  attachments listened for its second upload only after awaiting the first)
  is fixed.
- **Pystino 0.4.1:** the Identity page's "Create an account on first
  sign-in" hint describes the state the box is in — On said what Off does,
  and pointed to a rule the ticked box hides. Cerea only.
- The user and developer guides are aligned with what shipped: the shield
  button, the named build caches as safe directories, session paging, the
  in-memory session cache, the mountain, the plan card, fork and the retry
  notice, the delegation skill's long-waits rule, and a Skills link in the
  index; the developer docs now match the code at the capability list, the
  policy examples, the spawn inheritance and the default ceiling, and the
  known-failures list is current.
- **The agent's task plan lives in the Tasks pane only.** The plan card that
  closed each agent turn is gone from the transcript — the pane showed the
  same list — and the `todowrite` row stays in the "Called N tools" group as
  the record that the plan changed. A chat's own plan card is untouched.
  Cerea only.
- **The side pane opens at about a third of the window.** It used to take
  60% of the area right of the sidebar; on a 1440 screen it now opens around
  480px instead of 660px. A dragged width still wins, the phone drawer is
  unchanged. Cerea only.
- **The inline progress mark is a little larger on desktop.** The mark that
  rides at the bottom of a working turn is 16px on a desktop and the
  previous 12px on a phone; the waiting mark at the start of a turn keeps
  its size. Cerea only.
- **Word documents fit the side pane's width.** A .docx opened in the
  artifact pane kept its print width (A4 ≈ 794px) and was cut off on the
  right; the pages now scale down to the pane's width like a PDF viewer
  does, recompute when the pane is dragged, never enlarge past their real
  size, and centre in a wide pane. The page layout is kept (no reflow), and
  the sanitising and the sandbox are unchanged. Cerea only.

## v0.10.1 — 2026-10-10

Pins: Cerea `0.10.1`, Pystino `0.4.0`, Authelia 4.39.22. **Machines need the
galopin update** for the retry notice (re-run the install line from the
pairing dialog, then `systemctl --user restart galopin`); everything else
is Cerea only.

- **Going back to a session shows it at once.** The last 8 sessions you had
  open are kept in memory (never on disk); reopening one shows it straight
  away instead of the loading skeleton, and the fresh replay replaces it in
  the background without moving what you were reading. Until then the
  copy is display only (paging, retry and fork wait for the refresh).
  Cerea only.
- **A background subagent no longer makes the parent look busy.** When a
  session ended its turn with a background subagent still working, the
  child's next permission card opened a new answer with no end, so the
  view showed dots and Stop as if the parent were running again. The card
  now joins the last answer. Cerea only.
- **The mountain is the progress mark.** The three dots are gone: while a
  turn works, the animated mountain shows on its own (no empty bubble) and
  then inline where the dots were; answers use the whole row on desktop as
  they already did on a phone; your message's Edit/Copy row sits right,
  under it. Cerea only.
- **The desktop sidebar is wider** (340px, from 300), so a session's title
  is no longer cut short beside its state and menu. Cerea only.
- **A session waiting on a refusing model provider says so.** When the
  provider rate-limits or is overloaded, opencode keeps retrying with
  backoff; the agent view now shows "Retrying — Rate limit exceeded
  (attempt 3, next try in 20 s)" with a live countdown, beside Stop,
  instead of a silent running turn that read as a hang. Needs the galopin
  update; Cerea alone keeps the old look.
- **The agent's task plan stays out of the thinking.** At most one plan card
  per message, after its thinking and tool steps and before the answer; it
  no longer splits the "Thought / Called N tools" group, and it no longer
  reappears on the newest message when nothing changed (on every page open,
  or when opencode re-sent an unchanged list). Cerea only.
- **Documented: a long session's permission list grows.** opencode 1.18.34
  only appends session rules, so each change of a session's word,
  exceptions, grant or the machine ceiling adds one composed block (the
  newest always wins). Measured cost is record size, not speed (about
  100 KB at 1,300 rules); see the agent protocol, section 6. No behaviour
  change.

## v0.10.0 — 2026-10-10

Pins: Cerea `0.10.0`, Pystino `0.4.0`, Authelia 4.39.22. **Machines need the
galopin update** for paged transcripts, provider errors on the failed turn,
the safe directories and the background-wait guidance: re-run the install
line from the pairing dialog, then `systemctl --user restart galopin`. With
only the new Cerea (or only the new galopin) a session still opens the old
way, behind the loading skeleton.

- **A long agent session opens in about a second.** The opening snapshot
  carries only the newest 40 messages; scrolling near the top fetches the
  previous pages (`session.history`, capability `historyPaging`) with the
  visible message held where it was — a loading row while a page is in
  flight, a quiet marker at the start of the session. While a session loads
  it shows a "Loading conversation…" skeleton and lands on its newest
  message instead of rendering itself from the top. Needs the galopin
  update for the paging; older machines keep sending the whole log behind
  the skeleton.
- **A few safe directories outside the workspace never ask.** `/tmp`, the
  temp directory and the toolchain caches a build or test run needs
  (`~/.cache/go-build`, `~/.cache/pip`, `~/.cache/uv`, `~/.cache/pnpm`,
  `~/.cache/node-gyp`, `~/go/pkg/mod`, `~/.npm`, `~/.local/share/pnpm`) no
  longer raise the external_directory card — in any session, under any
  Deny / Ask / Allow setting, subagents included. Never the whole
  `~/.cache`, which also holds programs other tools run. The machine's
  policy holds the list (`enroll --safe-dir PATH` replaces the default,
  `--no-safe-dirs` empties it; `galopin policy set --no-safe-dir PATH` may
  only remove), the ceiling still caps it, and the Permissions dialog names
  it in the _Work outside the project folder_ row. A machine enrolled
  before gets the default list with the update. A safe directory is one the
  agent may write into, so the list stays short. Needs the galopin update.
- **A session can coordinate without a card each time.** The Permissions
  dialog's new Coordination section lets a session's agent find, read and
  message other sessions in the workspace, and start new ones, from its next
  turn; sessions it spawns inherit the grant. Another workspace, a send past
  three hops and anything the machine caps still ask. Works with the
  current galopin.
- **Permissions belong to the session, visibly.** The sidebar's Permissions
  item read as machine-wide but was the selected session's; it is gone. A
  session's ⋯ menu now has **Permissions…** (not on subagents), and the
  composer has a shield button beside the Deny · Ask · Allow selector that
  carries the exceptions count. Both open the dialog for that session,
  titled _Permissions — ‹session title›_.
- **A failed agent turn says why, on the turn itself.** When a provider
  refuses a turn (Cortecs answering `Insufficient Balance.` with HTTP 401,
  for example), the provider's own text now appears on the failed turn,
  with a hint to check the credit or key for the auth/payment statuses.
  Needs the galopin update; without it the generic error stays.
- **Agents stop blocking their turn on long waits.** opencode's bash has no
  background mode, so an agent waiting on CI, a full test suite or a release
  wrote foreground sleep-and-poll loops that held the whole turn. galopin's
  delegation skill now says to hand any such wait to a background task
  (`task` with `background: true`), end the turn, and pick up when the
  result arrives. Ships with the galopin update.
- "Fork from here" is back on finished agent messages.

## v0.9.4 — 2026-10-09

Pins: Cerea `0.9.4`, Pystino `0.4.0`, Authelia 4.39.22. **Machines need the
galopin update** (spawned sessions inherit exceptions).

- **Spawned sessions inherit the spawner's "always" answers.** A spawned
  session used to start without the spawner's permission exceptions and
  re-asked for things the person had already allowed (external directories
  above all). The spawner's exceptions are copied to the child as they are,
  still capped by the machine's ceiling; later changes do not propagate.
- `docker compose pull` no longer fails on a kit with restic backups: the
  `backup` service now carries `pull_policy: never`, since
  `cerea-backup:1` is built on the machine and published nowhere. An
  override copied from an older kit needs the two words added by hand.
## v0.9.3 — 2026-10-09

Pins: Cerea `0.9.3`, Pystino `0.4.0`, Authelia 4.39.22.

- Opening a generated image (PNG, SVG, …) in the side panel shows it
  instead of hanging on "Loading preview…": the preview re-downloaded the
  image in a loop.

## v0.9.2 — 2026-10-09

Pins: Cerea `0.9.2`, Pystino `0.4.0`, Authelia 4.39.22.

- The agents panel no longer asks for a password when the chat sign-in
  merely expired: an open tab whose session died (the ordinary hourly
  expiry) now says "You were signed out" and goes through a plain sign-in
  that the identity provider's own SSO session answers silently — the
  forced re-login stays for the 7-day staleness only.
- **Compact now works with opencode.** Galopin sent no body to opencode's
  summarize call, which requires the model to summarize with, so "Compact
  now" always failed with a 400. It sends the session's model now. Machines
  need the galopin update.
- Agent tool cards show their input while the call runs, not only after a
  reload.

## v0.9.1 — 2026-10-09

Pins: Cerea `0.9.1`, Pystino `0.4.0`, Authelia 4.39.22.

- **Permissions in the sidebar, not over the chat.** The /code panel's
  Permissions row moved into the Agents sidebar beside Schedules: it shows
  the session's Deny/Ask/Allow word and its exceptions count (or an amber
  warning on a machine enrolled before ceilings), and opens the capability
  rows, exceptions with Remove, and the raw rules in a dialog that keeps the
  transcript and its approval cards in view. Nothing else about permissions
  changed. Machines need no galopin update for this one.
- **Spawned sessions inherit their spawner's word and grant.** An Allow
  session's blanket now covers spawning and messaging too (reads stay
  grant-gated), so coordinating through spawned sessions stops asking for
  every command — still under the machine's ceiling, which caps the child
  exactly as it caps the caller. Fresh machines enroll with `session_spawn`
  uncapped; machines enrolled before this keep `session_spawn=ask` in their
  own file until re-enrolled. **`bash` stays capped at `ask`**: unattended
  commands still need a deliberate `--permission-max bash=allow` per
  machine, because a command that may run can read the agent's own server
  password and widen its rules past the ceiling. This release **does** need
  the galopin update on every machine (re-run the install line from the
  pairing dialog, then `systemctl --user restart galopin`) — mixed versions
  work, but only updated machines spawn and message without the extra cards.

## v0.9.0 — 2026-10-09

Pins: Cerea `0.9.0`, Pystino `0.4.0`, Authelia 4.39.22.

- **Built-in office skills.** The chat now ships twelve deployment-wide skills
  the assistant loads when a request matches: Word, Excel, PDF, PDF tools,
  PowerPoint, charts, data analysis, business writing and themes (plus the
  existing csv/json shaping and report writing). They produce real files —
  .docx, .xlsx, .pdf, .pptx, images — from the browser sandbox, with the
  packages they need (reportlab, seaborn joining the already-vendored document
  wheels, ~2 MB more in `static/pyodide/`) served same-origin. Skills are
  visible to everyone on the Workspace → Skills tab; administrators can edit
  or disable them there, and a shipped skill updates itself on upgrade unless
  an administrator has edited it. `CHAT_SKILLS_DISABLED` (comma-separated
  names) turns any of them off deployment-wide. Machines need no galopin
  update. See docs/skills.md for what each skill does — and what it honestly
  cannot (no formula recalculation, no rendered previews, RC4-only PDF
  encryption).

## v0.8.0 — 2026-10-08

Pins: Cerea `0.8.0`, Pystino `0.4.0`, Authelia 4.39.22.

- **GitLab works for the chat.** The gateway checks identity-provider access tokens that
  are not JWTs (GitLab's) with the provider's introspection endpoint, using the chat
  client's credentials, and caches the answer for up to 60 s. Every refused token is now
  logged by the gateway with its reason (`docker compose logs gateway`). The chat
  application in GitLab needs the scopes `openid profile email`.

- **Groups from an external identity provider are imported by hand by default.** A sign-in
  no longer creates a group for every name the IdP reports (one GitLab sign-in made 67):
  the console's Groups page lists them under "Seen from your identity provider", with
  Import and Dismiss. `./configure` asks, or takes `--group-import manual|auto`
  (`OIDC_GROUP_IMPORT`, default `manual`). **On upgrade an existing install becomes
  `manual`**: groups that already exist keep being granted from the claim, only new names
  stop becoming groups. To keep the old behaviour: `./configure --group-import auto`.
  Groups created before can be deleted in the console; under `manual` they are not
  recreated. No effect with the bundled Authelia.
- **Everyone joins `users`.** `OIDC_DEFAULT_GROUP` (default `users`, empty turns it off):
  every person joins it once, at their first sign-in (existing people at their next),
  with any IdP, so a new account can bill and use the public models. It grants no model
  by itself. With the bundled Authelia it is the same `users` group as before.
- `OIDC_GROUP_ALLOWLIST` (advanced, optional): only these IdP group names are considered.
- The gateway now receives the chat client's secret (`OIDC_CHAT_CLIENT_SECRET`, already in
  `.env`) to introspect opaque access tokens (GitLab).
- No galopin update needed.

## v0.7.2 — 2026-10-08

Pins: Cerea `0.7.2`, Pystino `0.3.2`, Authelia 4.39.22.

- Settings → Application settings shows the running version ("Cerea 0.7.2 · <commit>"),
  linking to its GitHub release. No galopin update needed.

## v0.7.1 — 2026-10-08

Pins: Cerea `0.7.1`, Pystino `0.3.2`, Authelia 4.39.22.

- Corrected texts: galopin's built-in delegation skill no longer tells agents that
  background subagents need a flag (they are on by default); `galopin policy -h` and
  `galopin enroll -h` state the real defaults; the pairing dialog's "No agent tools" option
  names the schedule tools too.
- Documentation checked page by page against the code, and a handoff guide for maintainers
  (`MAINTAINING.md`).
- If you are updating galopin for v0.7.0, take this one instead: re-run the install line,
  then `systemctl --user restart galopin`.

## v0.7.0 — 2026-10-08

Pins: Cerea `0.7.0`, Pystino `0.3.2`, Authelia 4.39.22.

- **Agents can schedule work.** A coding session can list, create, change, pause and
  delete your scheduled actions on its own machine with four new tools (`schedule_list`,
  `schedule_create`, `schedule_update`, `schedule_delete`). What it creates is never broader
  than the session itself: same machine, a permission word no looser than its own, no
  coordination options it does not have, and at most 5 active agent-made schedules per
  machine. The Schedules list marks them "Created by an agent in ‹session›", with a link.
- **When it asks:** creating a schedule follows the session's Deny / Ask / Allow word
  (Allow creates without a card). A scheduled run that wants to create another schedule
  always asks. A run may always pause or delete its own schedule without a card ("stop when
  done"). Any other change or deletion asks. A new machine limit, `schedule`, caps all of it.
- Agent-made schedules run in build mode by default (`agentMode`).
- **Update galopin on your machines** to get the tools: re-run the install line from the
  pairing dialog, then `systemctl --user restart galopin`. An older galopin keeps working
  without them.
- The release machinery now lives in the repository (`scripts/release/`).

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
