# Changelog

All notable changes to this deployment kit are documented here. The
convention: newest first, one section per release, dated, with the pins it
shipped.

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
