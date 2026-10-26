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

Three scripts ship with this skill for building and checking decks (three more,
`pptx_edit.py`, `pptx_slides.py` and `pptx_verify.py`, edit supplied ones: see
Editing an existing deck). Load each with `load_skill_file` (skill
`powerpoint`), write it into the working directory, and import it — no
command line, every function takes paths:

- `scripts/generate.py` — outline → deck. Without a template it uses
  python-pptx's built-in one (standard layouts, real placeholders); with an
  attached `.pptx` it uses the person's own.
- `scripts/edit.py` — inventory an existing deck, retype paragraphs, reorder slides.
- `scripts/validate.py` — the quality gate: empty placeholders, estimated
  text overflow, off-slide shapes, unfilled picture slots.

```python
# after writing the scripts into the working directory (scratch; only
# files saved under /mnt/output/ are offered to the person):
import generate, validate

result = generate.generate("outline.md", "/mnt/output/deck.pptx")   # uses the bundled template
print(result["warnings"], result["picture_slots"])
report = validate.validate("/mnt/output/deck.pptx")
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

| Element         | Marker                                                                             |
| --------------- | ---------------------------------------------------------------------------------- |
| Slide header    | `# Slide N: Label` (or plain `## Title`)                                           |
| Separator       | `---` — never inside slide content                                                 |
| Visual type     | `**Visual: type**`                                                                 |
| Layout override | `**Layout: layout-name**` (exact name in the template)                             |
| Column / card   | `[Column N: Header]`, `[Card N: Title]`                                            |
| Headline        | first `**bold**` line                                                              |
| Quote           | `> quoted text`                                                                    |
| Timeline entry  | `[Week 1] Kickoff`                                                                 |
| Table           | markdown `\| a \| b \|` rows                                                       |
| Image note      | `[Image: description]` / `[Background: description]`                               |
| Typography      | `{bold}…{/bold}`, `{italic}`, `{blue}`, `{question}`, `{signpost}LABEL{/signpost}` |

## Visual types — decide, don't default to bullets

| Type              | Use when                          |
| ----------------- | --------------------------------- |
| `process-N-phase` | sequential steps (N = 2–5)        |
| `comparison-N`    | side-by-side options (N = 2–5)    |
| `cards-N`         | discrete parallel items (N = 2–5) |
| `data-contrast`   | two opposing metrics              |
| `quote-hero`      | a powerful quote                  |
| `hero-statement`  | a single punchy statement only    |
| `table`           | genuinely tabular data            |
| `bullets`         | default, last resort              |

Decision order: sequence → comparison → parallel items → data contrast →
quote → table → hero → bullets. Full reference with length limits:
`references/rules/visual-types.md`. The engine auto-picks a layout whose
body placeholders match the block count, so an odd template still gets a
sensible slide; `**Layout: name**` forces an exact layout when you know it.

## Editing an existing deck

**First choice: the document tools.** If `doc_outline`, `doc_read` and `doc_edit` are in your tool list, edit a
supplied deck with them and write no code: `doc_outline` for the structure and ids, `doc_read` for exact
content, then `doc_edit` with typed operations (replace text, set placeholder text, replace or insert images, duplicate, delete or reorder slides, set notes). The edit is saved as a new version of the file
under the same name, the original is kept, and the result gives you the diff and a verification report to
summarise for the person. Edit again by the same name to build on your last version. If the tools are not in
your list, the service is not set up on this deployment: use the helpers below, which do the same work inside
the sandbox. (New files are still made as described elsewhere in this skill.)

**Decision rule.** A new deck: `generate.py`. A deck the person supplied that
you must change: use the bundled editing helpers. **Never**
`Presentation(path)` + `save()` on a supplied file for edits: python-pptx
re-serialises every slide, layout and master, and its run API loses
formatting when text spans runs. (`edit.py` below is the older
paragraph-retype helper; prefer the helpers here for supplied decks.)

1. Load `scripts/pptx_edit.py`, `scripts/pptx_slides.py` and
   `scripts/pptx_verify.py` with `load_skill_file`, write them into the
   working directory, and import them.
2. `outline` first and report briefly what you found: slides (1-based),
   layouts, shapes with their ids, placeholders (type and idx), pictures,
   speaker notes.
3. Chain edits through scratch files in the working directory and save the
   final result under `/mnt/output/` (the only folder offered as downloads);
   never overwrite the original.
4. `verify` against the ORIGINAL, then tell the person what changed using
   its `text_diff`.

```python
import pptx_edit as pe, pptx_slides as ps, pptx_verify as pv   # written out first

src = "/mnt/data/board.pptx"
print(pv.outline_text(pe.outline(src)))
pe.replace_text(src, "s1.pptx", "2025", "2026")                       # keeps run formatting
pe.set_placeholder_text("s1.pptx", "s2.pptx", 1, "title", "Q3 review")
pe.replace_image("s2.pptx", "s3.pptx", 2, 7, "/mnt/data/logo.png")    # slide 2, shape id 7
ps.duplicate_slide("s3.pptx", "s4.pptx", 3)                           # the copy follows slide 3
ps.reorder("s4.pptx", "s5.pptx", [1, 3, 2, 4])                        # new order, as old numbers
ps.delete_slide("s5.pptx", "/mnt/output/board-updated.pptx", 5)
rep = pv.verify(src, "/mnt/output/board-updated.pptx")
print(rep["slides"], rep["added"], rep["removed"], "\n".join(rep["text_diff"]))
```

- `replace_text(find, replace, slides=None, notes=False)` covers text boxes,
  placeholders, tables and groups; a match may span runs and the replacement
  takes the first matched run's formatting.
- `set_placeholder_text(slide, "title" | "body" | idx, text)`: one paragraph
  per line (or a list), formatting of the first paragraph and run kept.
- `replace_image(slide, shape_id, image, fit="cover")`: PNG, JPEG or GIF;
  keeps size, position and effects; `cover` crops to the frame, `stretch`
  squeezes. Alt text is unchanged: update it if the picture's meaning changed.
- `duplicate_slide` copies layout, pictures and formatting (not speaker notes)
  and refuses slides with charts, SmartArt or embedded objects; `delete_slide`
  refuses when another slide links to it; `reorder` keeps section membership
  and refuses moves between sections.
- Layouts, masters, theme and every part you did not edit stay byte-identical.

Errors are all `PatchError` with a message saying what to do (unknown slide,
shape or placeholder: the message lists the real ones). A refused edit writes
no file. If `verify` raises, do not deliver that file; never fall back to
python-pptx `save()` on the supplied file or hand-edit the zip.

Not covered: charts and SmartArt content, animations, new layouts, notes
text edits other than `replace_text(notes=True)`. Say so rather than
improvising. After delivery tell the person what changed (the diff), and that
the check was structural, not a rendered view. Layout redesigns or changes
across more than ~30% of slides belong to regeneration.

Small paragraph retypes can still use `edit.py` (`edit.inventory`,
`edit.replace`, `edit.reorder`).

## Templates

- **Bundled**: `generate.py` carries the Inner Chapter template inside itself
  (`references/layouts.md` catalogs its layouts; the engine maps visual types
  onto it automatically).
- **The person's own template**: they attach the `.pptx`; write it to the
  working directory and pass `template_path=generate("outline.md",
"/mnt/output/deck.pptx", template_path="their-template.pptx")`. Layout selection falls
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

- The deck is the deliverable: the file must exist when you finish —
  run generate() yourself rather than leaving a script for the person to
  run.
- There is no renderer here: validation is structural (placeholders, overflow
  estimate, geometry), and the person opens the deck for the visual verdict —
  say so once, briefly.
- Picture placeholders are left for real images: the person attaches them and
  they are inserted into the placeholder (`placeholder.insert_picture`),
  which keeps the template's crop and position.
- Report the validation score and path; never announce a deck you did not
  produce.
