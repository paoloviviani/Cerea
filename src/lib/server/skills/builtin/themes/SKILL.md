---
name: themes
description: Apply a professional colour-and-font theme to any document, deck, chart or HTML artifact — ten curated themes plus custom themes on the fly. Use when the person asks for consistent styling, branding, or a nicer look across their files.
license: Complete terms in LICENSE.txt
---

# Theme Factory

A curated collection of professional font and colour themes, each with
carefully selected colour palettes and font pairings. Once a theme is chosen,
it can be applied to any artifact: a `.docx` report, a `.pptx` deck, a
matplotlib chart, or an HTML page.

## Usage instructions

1. **Show the options briefly**: list the ten themes below with one line each,
   in the chat — no file preview is needed to choose. When the person wants to
   *see* a theme before committing, render a small preview with matplotlib:
   a row of colour swatches plus a title styled in the theme (the colors are
   in the theme file; DejaVu Sans is always available to matplotlib).
2. **Ask for their choice**, and wait for an explicit answer. If none of the
   ten fits, offer to build a custom theme from a short description (see
   below), show it for review, then apply it after confirmation.
3. **Apply the theme** consistently across the whole artifact — every colour
   and font choice comes from the theme, not from mixed defaults.

## The ten themes

Each is defined in a bundled file loaded with `load_skill_file`
(skill `themes`), which carries its exact palette, font pairing, and best use:

| Theme | File |
|---|---|
| Arctic Frost | `references/themes/arctic-frost.md` |
| Botanical Garden | `references/themes/botanical-garden.md` |
| Desert Rose | `references/themes/desert-rose.md` |
| Forest Canopy | `references/themes/forest-canopy.md` |
| Golden Hour | `references/themes/golden-hour.md` |
| Midnight Galaxy | `references/themes/midnight-galaxy.md` |
| Modern Minimalist | `references/themes/modern-minimalist.md` |
| Ocean Depths | `references/themes/ocean-depths.md` |
| Sunset Boulevard | `references/themes/sunset-boulevard.md` |
| Tech Innovation | `references/themes/tech-innovation.md` |

## Applying a theme

1. Load the theme file with `load_skill_file` and read its palette and font
   pairing.
2. Apply it with the format's proper package — python-docx for `.docx`
   (paragraph shading, font colours, heading styles), python-pptx for `.pptx`
   (shape fills, text colours, fonts), matplotlib for charts (rcParams or
   explicit colours), inline CSS for HTML. Never hand-edit raw OOXML.
3. Font names in a theme are suggestions the document carries; the viewer's
   system substitutes what it lacks. Prefer the theme's fonts for headings and
   body as written, but do not bundle or embed font files.
4. Keep contrast readable: dark text on light backgrounds or the reverse —
   check the theme's own pairings and don't mix them.

## Creating a custom theme

When none of the ten fits, write a new theme in the same shape as the bundled
files: a name describing the combination, 3–5 hex colours with roles, a header
and body font pairing, and a "best used for" line. Show it in the chat for
review before applying it, exactly as you would a bundled theme.

## Rules

- One theme per artifact unless the person asks for a blend; say what you
  blended.
- Never claim to have applied a theme you didn't apply — every styled element
  traces to a code block you ran or a file you wrote.
