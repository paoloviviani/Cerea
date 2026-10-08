---
name: powerpoint
description: >
  Generate and edit consultant-grade PowerPoint decks from markdown outlines,
  filling a template's real slide-master layouts and placeholders — never
  text overlays. Use when the person wants slides or a deck from an outline
  or brief, wants their own .pptx used as a template, or asks to fix or check
  a deck.
---

# PowerPoint from layouts

**Core principle: fill the template's actual layouts and placeholders — never
overlay text boxes on slides.** Text laid over a slide ignores the template's
branding; text placed in the template's own placeholders inherits it.

## Setup

```python
import micropip
await micropip.install("python-pptx")
```

## The bundled scripts

Three scripts ship with this skill. Load each with `load_skill_file` (skill
`powerpoint`), write it into the working directory, and import it — no
command line, every function takes paths:

- `scripts/generate.py` — outline → deck. Also carries the bundled default
  template inside itself (used when no template is given).
- `scripts/edit.py` — inventory an existing deck, retype paragraphs, reorder slides.
- `scripts/validate.py` — the quality gate: empty placeholders, estimated
  text overflow, off-slide shapes, unfilled picture slots.

```python
# after writing the scripts into the working directory:
import generate, validate

result = generate.generate("outline.md", "deck.pptx")   # uses the bundled template
print(result["warnings"], result["picture_slots"])
report = validate.validate("deck.pptx")
print(report["score"], report["errors"], report["warnings"])
```

## Mandatory workflow

1. **Produce an outline** with a `**Visual: type**` declaration on every
   content slide — see the format below and `references/rules/outline-format.md`.
2. **Generate**, then **read the validation report**: a deck is not done
   until the score is clean of errors and overflow warnings. Fix the outline
   (shorter lines, fewer bullets per block) and re-run — the generator is
   deterministic, so a fix is a regeneration, not a hand-edit.
3. **Report the score and the file path** — not just "done".

## Outline format

Slides are separated by `---`. Each slide:

```markdown
# Slide 2: Three outcomes

**Visual: column-3**

**Level-set the reader in one line.**

[Column 1: Discover]
- Stakeholder interviews
- Competitive audit

[Column 2: Define]
- Workshop facilitation
- Persona development

[Column 3: Deliver]
- Solution architecture
- Training & handover
```

Markers the parser knows:

| Element | Marker |
|---|---|
| Slide header | `# Slide N: Label` (or plain `## Title`) |
| Separator | `---` — never inside slide content |
| Visual type | `**Visual: type**` |
| Layout override | `**Layout: layout-name**` (exact name in the template) |
| Column / card | `[Column N: Header]`, `[Card N: Title]` |
| Headline | first `**bold**` line |
| Quote | `> quoted text` |
| Timeline entry | `[Week 1] Kickoff` |
| Table | markdown `\| a \| b \|` rows |
| Image note | `[Image: description]` / `[Background: description]` |
| Typography | `{bold}…{/bold}`, `{italic}`, `{blue}`, `{question}`, `{signpost}LABEL{/signpost}` |

## Visual types — decide, don't default to bullets

| Type | Use when |
|---|---|
| `process-N-phase` | sequential steps (N = 2–5) |
| `comparison-N` | side-by-side options (N = 2–5) |
| `cards-N` | discrete parallel items (N = 2–5) |
| `data-contrast` | two opposing metrics |
| `quote-hero` | a powerful quote |
| `hero-statement` | a single punchy statement only |
| `table` | genuinely tabular data |
| `bullets` | default, last resort |

Decision order: sequence → comparison → parallel items → data contrast →
quote → table → hero → bullets. Full reference with length limits:
`references/rules/visual-types.md`. The engine auto-picks a layout whose
body placeholders match the block count, so an odd template still gets a
sensible slide; `**Layout: name**` forces an exact layout when you know it.

## Editing an existing deck

```python
import edit, validate, json

inv = edit.inventory("project.pptx")
# change only the "text" fields you care about in inv, then:
changes = {"slide-2": {"shape-3": {"paragraphs": [{"id": "p-0", "text": "Q2 2026"}]}}}
edit.replace("project.pptx", changes, "updated.pptx")
edit.reorder("project.pptx", [3, 1, 2], "reordered.pptx")
```

Small fixes only: typos and values on few slides, or a reorder. Layout
changes, added/removed slides, or changes across more than ~30% of slides
belong to regeneration — **never** edit those by hand.

## Templates

- **Bundled**: `generate.py` carries the Inner Chapter template inside itself
  (`references/layouts.md` catalogs its layouts; the engine maps visual types
  onto it automatically).
- **The person's own template**: they attach the `.pptx`; write it to the
  working directory and pass `template_path=generate("outline.md",
  "deck.pptx", template_path="their-template.pptx")`. Layout selection falls
  back to matching body-placeholder counts; `**Layout: name**` picks an exact
  layout — `edit.inventory` on the template shows what layouts exist.
  `references/rules/bring-your-own-template.md` describes the upstream
  one-time onboarding flow; in this sandbox, profiling means running
  `edit.inventory` on the template and reading the layout names.

## Anti-patterns (forbidden)

- Skipping the `**Visual:**` declaration — the parser's fallback may not match.
- Defaulting to bullets when a richer type fits — bullets are the last resort.
- `hero-statement` for 3+ items or multi-sentence content.
- Tables for process flows (use `process-N-phase`); bullet lists for
  comparisons (use `comparison-N`).
- Edit mode for layout changes, added/removed slides, or >30% churn — regenerate.
- Claiming success without a clean validation pass.

## Rules

- There is no renderer here: validation is structural (placeholders, overflow
  estimate, geometry), and the person opens the deck for the visual verdict —
  say so once, briefly.
- Picture placeholders are left for real images: the person attaches them and
  they are inserted into the placeholder (`placeholder.insert_picture`),
  which keeps the template's crop and position.
- Report the validation score and path; never announce a deck you did not
  produce.
