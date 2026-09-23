# Desktop app — placeholder

**Nothing is built here yet.** It is not part of this repository today; this
page records the decisions already taken so they are not re-litigated.

## What it would be

A Tauri v2 shell that wraps this application and adds computer use. A _shell_,
not a second client: conversations are synced because the server is
authoritative, so there is no separate data model and no reconciliation logic
to write.

## Decisions already taken

Cited by number; the decision record is private and deliberately not linked.

| Choice    | Decision                                | ADR  |
| --------- | --------------------------------------- | ---- |
| Framework | Tauri v2 (v2.10.1 stable as of 2026-03) | 0017 |

**Do not target Tauri 3.** As of August 2026 it exists only as alpha
(`tauri-cef-v3.0.0-alpha.7`, May 2026). v2 continues to receive releases.

## The part that needs real thought

Computer use is the only capability here that does not exist in the web app,
and it is the one that grants the model control of the user's machine. It needs
its own design pass and its own ADR before any of it is written — the
sandboxing reasoning in ADR 0021 is about running _generated code_ server-side
and does not transfer to driving somebody's own desktop. The nearest thing that
does exist is the `/code` Agents panel
([docs/agent-machines.md](agent-machines.md)), and it is a different answer to a
different question: an agent the person installed on their own machine, with an
approval gate, rather than the model driving the desktop directly.
