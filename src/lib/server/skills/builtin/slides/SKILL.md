---
name: slides
description: >
  Write slides to present or share right here in the chat: a deck in Markdown that Cerea shows in the side panel,
  with themes, layouts, speaker notes, full-screen presenting and a PDF download. Use when the user wants slides, a
  deck or a presentation to show or share, and does not need an editable PowerPoint file. If it is unclear whether
  they want this or a .pptx to edit, ask first (see Routing below). Not for .pptx files: that is the powerpoint skill.
---

# Slides in the chat

You write the deck as Markdown in an artifact of `type="slides"`. Cerea renders it with reveal.js in the side
panel; the user can step through it, present it full screen, download a PDF and download the Markdown. It cannot
be opened in PowerPoint: when the user needs an editable Office file, use the `powerpoint` skill instead.

## Routing: slides or a PowerPoint file?

Decide before you write anything.

- The user says "PowerPoint", "pptx", "a file to edit", "to edit in PowerPoint", or gives a .pptx: load the
  `powerpoint` skill, do not ask.
- The user says "just slides", "to present", "show", "present it here", "a quick deck to share": use this skill,
  do not ask.
- Anything else ("make me a deck about X", "a presentation for Monday", "slides on Y"): ask once with
  `ask_user_question`, two options:
  1. **Slides to present or share here** - shown in this chat, present full screen, PDF download; quick to change
     by asking.
  2. **A PowerPoint file to edit** - a .pptx the user opens and edits in PowerPoint.
  Then follow the answer. Ask nothing else first; take the topic, length and audience from the request and
  proceed with sensible defaults.
- If the `powerpoint` skill is not in the Available skills list, do not ask: build the slides. If this skill is the
  only one of the two that is listed, the same. If you cannot create artifacts in this conversation, say so and
  offer the PowerPoint route instead.

## The format

One artifact, `type="slides"`. Optional front matter first, then Markdown. Slides are separated by a line that is
exactly `---`.

```
---
title: Quarterly review
theme: cerea
accent: "#7008e7"
font: sans
logo: logo.png
---

<!-- .slide: class="title" -->
# Quarterly review

Where we are

Note: Welcome everyone. Say the headline first.

---

## Three things to remember

- First
- Second
```

- **Speaker notes:** a line starting `Note:` ends the slide's content; everything after it is notes. The user
  reads them in the panel (notes button, or the `N` key) while presenting.
- **Slide attributes:** `<!-- .slide: class="two-columns" -->` as the first line of a slide sets its layout.
  Fragments, backgrounds and other reveal.js attributes work too, but prefer the layouts below.
- **Code:** fenced blocks with a language are highlighted. Keep them under about 12 lines.
- **Images:** an image already in the chat can only be used as the `logo`. For a picture in a slide use a `data:`
  URL (small) or draw it as SVG; remote images are blocked.
- **No raw HTML or CSS for styling.** Colours, fonts and sizes come from the theme.

## Front matter (all optional)

| Key | Values |
| --- | --- |
| `title` | Plain text, used for the PDF name |
| `theme` | `cerea` (default), `cerea-dark`, or a reveal.js theme: `white`, `black`, `simple`, `moon`, `solarized`, `dracula` |
| `accent` | A hex colour such as `#0a7e8c`; changes links, bullets, rules and highlights |
| `font` | `sans`, `serif`, `humanist`, `mono` (system fonts); without it the theme's own font |
| `logo` | File name of an image in the chat (png, jpg, svg, webp), shown bottom right |

Anything else is ignored. If the organisation has set a default look, decks use it unless the front matter
overrides it, so only set `theme` or `accent` when the user asked for a look. Pick a theme other than `cerea` only
when asked; `cerea-dark` suits a dark room, `simple` and `white` a classic look.

## Layouts

Use `<!-- .slide: class="NAME" -->`:

| Class | Use it for |
| --- | --- |
| `title` | The opening slide: `# Title`, then a subtitle line |
| `section` | A divider: `# Section name`, then one line |
| `two-columns` | Heading, then two columns; put `***` on its own line between them |
| `image-left` / `image-right` | A heading, a few lines of text and one image beside them |
| `quote` | A `>` quote, then the attribution on its own line |
| `big-number` | `# 24%`, then one line saying what it is |

No class is the normal slide: a heading and up to six bullets, a short paragraph, a table or a code block.

## Good decks

- One idea per slide, and the heading says it ("Support load fell", not "Support").
- At most six bullets, each under about ten words. If it needs more, split it or move it to the notes.
- Put the detail in `Note:`; the slide is for the audience, the notes are for the speaker.
- Open with a `title` slide, use `section` slides to mark parts in long decks, close with the decision or next step.
- Length: about one slide per minute. Ten slides unless the user says otherwise.
- Numbers: a `big-number` slide or a table beats a bullet. Never invent figures; use what the user gave you or say
  what is a placeholder.

## Delivering and changing

Create the artifact with the artifact tool (or the artifact tag if that is how this conversation works), then tell
the user in one or two lines what is in it and that they can present it full screen or download a PDF. Do not ask
a question in the same step.

Change it as any artifact: small edits with an update, larger ones by rewriting with the same identifier. Keep
the front matter.

A full example deck is in `references/example-deck.md`.
