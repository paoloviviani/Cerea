---
name: powerpoint
description: >
  Create and edit PowerPoint (.pptx) decks with the doc_* tools - slides built in real layouts and placeholders,
  native charts, tables and images, or in the person's own uploaded template. Use when the person wants slides or
  a deck, wants their own .pptx used as a template, or asks to change or check a deck.
---

# PowerPoint from layouts

**Core principle: fill real layouts and placeholders; never overlay text boxes on slides.** Text placed in a
layout's own placeholders inherits the master's branding; text laid over a slide ignores it. The tools work this way.

## One rule

**When `doc_create` is in your tool list, the `doc_*` tools are the ONLY way to create or edit a PowerPoint deck.**
Do not write Python to make or change one (no python-pptx, no bundled scripts such as `generate.py`, no zip
editing), and do not mix the two ways. If the tools are not in your tool list, jump to the last section,
"Fallback".

**One exception, opt-in.** When the person explicitly asks for a custom visual design the tools cannot express
(free-placed shapes or cards, coloured or picture backgrounds, an infographic, a timeline drawn from shapes, a
"designed" or "creative" deck), or asks for something the tool rejected as not expressible, build that deck in the
sandbox as the last section, "Fallback", describes, and say in one line that you are building a custom design in
the sandbox. A plain "make it nice" is not an opt-in, and "a deck about X" still goes through `doc_create`. Within
one deck the two ways are never mixed; a later edit of a sandbox-built deck may use `doc_edit` normally.

**When it is unclear which the person wants** ("make it look great", "something eye-catching", a style the tools
may not express), ask before building anything. Call `ask_user_question` with two plain options: a clean deck in
standard layouts (the reliable default), or a custom design with free shapes and backgrounds (more distinctive,
more likely to need fixes). If that tool is not in your tool list, ask the same in plain text. Clear cases need
no question: an ordinary deck request goes to the tools, an explicit custom design request to the sandbox.

## Creating a deck

Call `doc_create` with `format: "pptx"` and a `spec` of `slides`. The tool's description lists every property; the
service checks the spec first and answers with what is allowed if something is off.

- **Slides:** each has a `layout` (`title`, `title_content`, `section`, `two_content`, `title_only`, `blank`), a
  `title`, a `subtitle` (title and section slides), `body` blocks (paragraph, list, table, image, chart, quote,
  code), `body_right` for `two_content`, `notes` (speaker notes), and `images` and `charts` that are placed
  explicitly (a box in cm) or fitted to the body area (`fit: "placeholder"`). Without a `layout` the first slide
  without body is a title slide and the others use `title_content`.
- **Placement:** text blocks fill the layout's body placeholder; tables, images and charts share the body area (on
  the right when there is text too). A text-only slide stays in the placeholder, so it keeps the template's look.
- **Look:** neutral 16:9 built-in master; `theme` only for what the person asked (fonts from the tool's list,
  colours, accent, table style). **Their template:** give the uploaded `.pptx` as `theme.template`; `layout` then
  names one of its layouts (an unknown name answers with the list), its size, master and fonts are kept, and its
  own sample slides are not. To fill a template that has `{{placeholders}}`, use `doc_create_from_template` (text
  boxes, placeholders and notes; a shape holding only a placeholder can become a picture).
- **Charts:** a chart block (bar, column, stacked, line, area, pie, doughnut, scatter) with `render: "native"`
  (editable in PowerPoint, the data stays in the chart) or `"image"` (a PNG). For a chart the tool cannot draw,
  make the picture in the sandbox, save it under `/mnt/output/` and pass it as an image reference.
- **Images:** files in the conversation (an attachment, or a picture saved under `/mnt/output/`), listed in the
  call's `images` and named the same way in the slide.
- **Backgrounds and shapes:** a slide (or `theme.slide_background`, for all) can have a `background`: a colour, a
  two-colour gradient, or a picture from the conversation (`fit: "cover"`, cropped, not stretched). `shapes` (up to
  30: rectangle, rounded rectangle, ellipse, line, arrow, chevron, text box) are placed in cm on the slide and must
  stay inside it (a 422 names the shape that does not); they sit behind the title and body unless `layer: "front"`.
  Use them on `blank` or `title_only` slides for designed pages (cards, a cover, a section slide), set the text
  colour yourself when the background is dark (the result warns on low contrast), and never use shapes for ordinary
  text slides: those are a title and body.

### Designing the deck

- One idea per slide, and a title that states it (an assertion, not a topic label). About six short lines at most;
  split rather than shrink.
- Choose the form before the words: a sequence is an ordered list or a table of steps; a comparison is
  `two_content`; parallel items are a table or two columns; a number or trend is a chart; a quote is a quote block;
  a single statement is a title or section slide. Bullets are the last resort, not the default.
- Tables for genuinely tabular data only; no tables for process flows and no bullet lists for comparisons.
- Put the detail in speaker `notes`, not on the slide.

## Reading and editing a deck

- `doc_outline` shows slides (1-based), layouts, shapes with ids, placeholders, pictures and notes; `doc_read` gives
  a slide's paragraphs with runs and notes. Look before you edit.
- `doc_edit` applies typed operations, all or none: replace text (across runs, keeping formatting), set a
  placeholder's text, replace or insert images, duplicate, delete or reorder slides, set speaker notes. To add a
  slide to an existing deck, duplicate a similar one and change its text. Adding native charts to an existing
  deck, editing chart data and layout redesigns are not available: say so, or recreate the deck with `doc_create`
  when the person wants a redesign or many changes.
- An edit is saved as a new version under the same name; the original stays. Layouts, masters and every part you did
  not edit stay as they were.

## Reporting

The result carries an outline of the slides written (or the diff of an edit) and a verification report: the file is
valid and reopens. There is no renderer, so say in one line what you checked and that the person should open the
deck for the visual verdict. Describe only files the tools actually saved.

## Fallback: when the doc_* tools are not available, or for a custom design

**Read this section only if `doc_create` is NOT in your tool list, or the design exception in "One rule"
applies** (the person explicitly asked for a custom design the tools cannot express). Otherwise stop reading
here: everything below is the in-sandbox method, and it must not be mixed with the tools within one deck. These
instructions write Python inside the browser sandbox; the helper scripts are bundled with this skill.

**Design guidance for the exception case:**

- Stay on a 16:9 slide, and keep every shape inside it: check the bounds with the bundled `validate.py`.
- One palette and one or two fonts across the deck, text at least 14 pt, and enough contrast against the
  background (dark on light or light on dark, never mid on mid).
- Save the deck under `/mnt/output/`.

### Setup

```python
import micropip
await micropip.install("python-pptx")
```

### The bundled scripts

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

### Mandatory workflow

1. **Produce an outline** with a `**Visual: type**` declaration on every
   content slide — see the format below and `references/rules/outline-format.md`.
2. **Generate**, then **read the validation report**: a deck is not done
   until the score is clean of errors and overflow warnings. Fix the outline
   (shorter lines, fewer bullets per block) and re-run — the generator is
   deterministic, so a fix is a regeneration, not a hand-edit.
3. **Report the score and the file path** — not just "done".

### Outline format

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

### Visual types — decide, don't default to bullets

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

### Editing an existing deck

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

### Templates

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

### Anti-patterns (forbidden)

- Skipping the `**Visual:**` declaration — the parser's fallback may not match.
- Defaulting to bullets when a richer type fits — bullets are the last resort.
- `hero-statement` for 3+ items or multi-sentence content.
- Tables for process flows (use `process-N-phase`); bullet lists for
  comparisons (use `comparison-N`).
- Edit mode for layout changes, added/removed slides, or >30% churn — regenerate.
- Claiming success without a clean validation pass.

### Rules

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
