---
name: slides
description: >
  Write slides to present or share right here in the chat: a deck of HTML sections that Cerea shows in the side
  panel with navigation, full-screen presenting, notes and a PDF download. Use when the user wants slides, a deck or
  a presentation to show or share, and does not need an editable PowerPoint file. If it is unclear whether they want
  this or a .pptx to edit, ask first (see Routing below). Not for .pptx files: that is the powerpoint skill.
---

# Slides in the chat

You write the deck as HTML in an artifact of `type="slides"`. Cerea runs it with reveal.js in the side panel: the
user can step through it, present it full screen, read the notes and download a PDF or the source. It cannot be
opened in PowerPoint; when the user needs an editable Office file, use the `powerpoint` skill instead.

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

Write `<section>` elements, one per slide, nothing else around them: no `<html>`, `<head>`, `<body>` or `<script>`
(the engine is Cerea's; scripts, remote files and event handlers are removed). Put CSS in a `<style>` block before
the first section. Nested sections make vertical stacks. Put notes in `<aside class="notes">` inside the section.

```html
<style>
	.reveal .slides section {
		padding: 72px 96px;
	}
	h2 {
		font-size: 54px;
	}
</style>
<section data-background-gradient="linear-gradient(135deg,#0b1020,#3b1a6b)" style="color:#fff">
	<h2>Three things to remember</h2>
	<ul>
		<li>Revenue grew</li>
		<li>Support load fell</li>
	</ul>
	<aside class="notes">Say the numbers once.</aside>
</section>
```

- **Design freely at 1280 x 720.** The slide is that fixed size and scales to fit. Use your own CSS: grids, cards,
  gradients, inline SVG, CSS shapes for diagrams. Do the layout in a `div` inside the section, not on the section.
- **Backgrounds:** `data-background-color="#111"` or `data-background-gradient="linear-gradient(...)"` on the section.
- **Fragments:** `class="fragment"` on an element reveals it step by step.
- **Brand variables** are always defined: `var(--brand-accent)`, `var(--brand-font)` and, when the user's
  organisation set one, `var(--brand-logo-url)` (use as `background: var(--brand-logo-url) center / contain no-repeat`).
  Use them for the accent colour and font unless the user asks for another look; nothing forces you to.
- **Images:** remote images are blocked. Use inline SVG, CSS, or a small `data:` URL.
- **No theme is applied unless you name one.** Optional: `data-theme="dracula"` on the first section (or `theme:
dracula` in front matter) gives reveal.js styling. Names: `cerea`, `cerea-dark`, `white`, `black`, `simple`, `moon`,
  `solarized`, `dracula`. Skip it when you are designing the look yourself.
- **Readable:** body text at least 24px, headings 44px or more, strong contrast, at most about six lines per slide.

### Markdown shortcut

For a quick plain deck you may write Markdown instead: slides separated by a line of `---`, `Note:` starts the
speaker notes, and optional front matter (`theme`, `accent`, `font`, `logo`) first. Code fences with a language are
highlighted. Use HTML when the user cares how it looks. See `references/example-markdown.md`.

## Good decks

- One idea per slide; the heading says it ("Support load fell", not "Support").
- Detail goes in the notes; the slide is for the audience.
- About one slide per minute; ten slides unless asked otherwise. Open with a title slide, close with the decision.
- Never invent figures; use what the user gave you or label placeholders.

## Delivering and changing

Create the artifact with the artifact tool, then tell the user in one or two lines what is in it and that they can
present it full screen or download a PDF. Do not ask a question in the same step. Change it as any artifact: small
edits with an update, larger ones by rewriting with the same identifier.

A designed example is in `references/example-deck.html`.
