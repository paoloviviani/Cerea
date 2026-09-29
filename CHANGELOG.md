# Changelog

All notable changes to this deployment kit are documented here. The
convention: newest first, one section per release, dated, with the pins it
shipped.

## v0.1.0 — unreleased (pending the release checks)

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
