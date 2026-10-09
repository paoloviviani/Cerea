# Source

- **Upstream:** https://github.com/tristan-mcinnis/pptx-from-layouts-skill
- **Commit:** 46e7c6638305bcb424f257b5c49dcd2603dc71ea
- **Licence:** MIT (`LICENSE.txt`, kept verbatim beside this file; upstream
  copyright "Copyright (c) 2026 Tristan")
- **Upstream's `alternatives/` directory is deliberately not carried** — it
  contains a copy of a proprietary skill.

## What was carried, and what was rebuilt

Carried from upstream, near-verbatim: the SKILL.md's method (the
layout-and-placeholder thesis, the outline grammar, the visual-type decision
order, the typography markers, the anti-patterns) and the eight `rules/`
method documents. `rules/bring-your-your-own-template.md` had its CLI and
subagent sections replaced with the sandbox equivalent (inventory + smoke
generate). `references/layouts.md` is the bundled template's catalog.

Rebuilt for Cerea's sandbox: the upstream engine is a multi-thousand-line
pipeline (`generate.py` orchestrates `generate_pptx.py` (6.8k lines) +
`quality_check.py` + a pydantic `schemas/` layer through subprocesses with
argv, PYTHONPATH surgery and files under the repo root). None of that
machinery can run in a browser sandbox. The three bundled scripts here are a
first-party distillation of the upstream approach — outline parsing with the
same marker grammar, filling the template's real layouts and placeholders in
reading order, overflow/geometry validation, and inventory/replace/reorder
editing — sized for the model to read and run in `execute_code`. They are
Apache-2.0 like the rest of Cerea, and this skill as shipped is a derivative
work of the upstream MIT skill.

The bundled Inner Chapter template is not carried: Cerea's `load_skill_file`
returns a bundled file truncated past ~20k characters, so a script carrying
a 264 KB base64 blob could never reach the model intact — the real-model run
showed exactly that. Without a template the engine uses python-pptx's
built-in template (standard layouts, real placeholders — the doctrine holds),
and with an attached `.pptx` the person's own; `references/layouts.md`
(the Inner Chapter catalog) went with it.
