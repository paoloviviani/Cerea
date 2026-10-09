# Source

- **Upstream:** https://github.com/anthropics/skills, `skills/internal-comms`
- **Commit:** 683bc88e56f3e09ba94f7055977f3d3aa499f202
- **Licence:** Apache-2.0 (`LICENSE.txt`, kept verbatim beside this file)

## Changes from upstream

- Renamed the skill `internal-comms` → `business-writing` (deployment-wide
  built-in name; the formats are not only internal).
- "Claude should use this skill…" reworded to name no assistant; the
  guideline files moved from `examples/` to `references/examples/` because
  Cerea bundled files must live under `scripts/`, `references/` or `assets/`
  to be readable through `load_skill_file`.
- Added a short "Delivering the result" section matching Cerea's file
  conventions (fenced code block with `title=`, no base64) and two honesty
  rules.
- The four example guidelines are otherwise unmodified.
