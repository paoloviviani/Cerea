# Skills: built-ins, bundled files, and the seeding rule

Built-in deployment skills live in two places, unified by
`src/lib/server/skills/builtinSkills.ts`: the three original inline seeds in
`adminSkills.ts` (csv-shaping, report-writing, json-shaping), and the
directory skills under `src/lib/server/skills/builtin/<name>/` — `SKILL.md`
plus bundled `scripts/`, `references/`, `assets/` files, with the upstream
`LICENSE.txt` and a `SOURCE.md` (provenance: repo URL, commit SHA, what was
changed and why) sitting beside `SKILL.md`, never seeded. The directories are
read through Vite `?raw` globs and inlined into the server bundle — the
container copies only `build/`, so a runtime filesystem read would not
survive the image. `?raw` decodes as UTF-8: **bundled files must be text**; a
binary asset embeds base64 inside the script that uses it (the powerpoint
skill's template does exactly that).

Everything goes through the same validation the zip import uses
(`parseSkill`, `validateSkillFiles`); a definition that fails is dropped with
a logged reason and never seeded — a broken built-in must never fail a turn.

**The seeding rule** (`ensureDeploymentSeeds`): each seeded row stores the
definition's sha256 as `seedHash`. On boot, a built-in whose definition
changed replaces the row only when the row's current content and files still
hash to the stored `seedHash` — nobody edited it since seeding. An
administrator's edit is never overwritten, and `enabled` is never touched.
The update carries an equality filter on content and files, so a concurrent
edit between read and write wins instead of being clobbered. Rows seeded
before `seedHash` existed are stamped when their content still matches the
current definition, left alone otherwise. To change a built-in's shipped
definition: edit the directory (or the inline string), bump nothing else —
the next boot upgrades every unedited deployment automatically; edited rows
keep the admin's version until they delete the row (it re-seeds fresh).

Adding or updating a built-in: copy the upstream skill folder, keep its
`LICENSE.txt` verbatim, write the `SOURCE.md`, adapt the body for the
execution model (Pyodide only: no shell, no subprocess, no network in the
sandbox; verification is reading files back, never rendering), add every
upstream attribution to `NOTICE`, and cover the skill's scripts in the
Pyodide check (`scripts/pyodide_skills_check.mjs`). Licences: OSI-approved
only; never source from Anthropic's proprietary `docx`/`xlsx`/`pptx`/`pdf`
skills or from "awesome skills" aggregates; OpenAI's removed skills come from
OpenAI's own git history, never a third-party copy.
