"""generate.py: outline -> deck from a template's real layouts, in Cerea's Python sandbox.

Distilled for Cerea from pptx-from-layouts (MIT, Tristan McInnis) — the core
approach, not the full engine: parse a markdown outline, fill the template's
actual slide-master layouts and placeholders (never overlay text boxes on
slides), and report what was left for images. No argv: import this file in
the sandbox and call `generate(...)` with paths. python-pptx is the only
dependency.

Outline grammar (slides separated by `---`):

    # Slide 2: Three outcomes            (explicit header; or plain `## Title`)
    **Visual: column-3**                 (optional; or **Layout: name** to force one)
    [HINT: column-3-centered-a]          (optional exact layout name)
    **The headline the slide leads with.**
    [Column 1: Discover]                 (blocks fill body placeholders in order)
    - Stakeholder interviews
    > A quote worth its own slide.       (quote slide)
    | a | b |                            (markdown table rows -> a real table)
    [Week 1] Kickoff                     (timeline entries fill body placeholders)
    [Image: research in progress]        (picture placeholder note; images attach later)
"""

from __future__ import annotations

import base64
import re

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

# The bundled Inner Chapter template, base64-encoded, so this script is
# self-contained: generate() unpacks it when no template path is given.

BRAND_BLUE = RGBColor(0x01, 0x96, 0xFF)
BRAND_GRAY = RGBColor(0x59, 0x59, 0x59)

SLIDE_HEADER = re.compile(r"^#\s+Slide\s+\d+:\s*(.+)$")
VISUAL = re.compile(r"^\*\*Visual:\s*([a-z0-9-]+)\*\*\s*$")
LAYOUT_OVERRIDE = re.compile(r"^\*\*Layout:\s*([A-Za-z0-9_ -]+)\*\*\s*$")
HINT = re.compile(r"^\[HINT:\s*([A-Za-z0-9_ -]+)\]\s*$")
COLUMN = re.compile(r"^\[(?:Column|Card|Table)\s+\d+:\s*(.+?)\]\s*$")
IMAGE = re.compile(r"^\[(?:Image|Background):\s*(.+?)\]\s*$")
TIMELINE = re.compile(r"^\[(.+?)\]\s+(.+)$")
QUOTE = re.compile(r"^>\s?(.*)$")
HEADING = re.compile(r"^(#{1,3})\s+(.*)$")
BOLD_LINE = re.compile(r"^\*\*(.+)\*\*\s*$")
TYPOGRAPHY = re.compile(r"\{(bold|italic|blue|question|signpost)\}(.*?)\{/\1\}")


def parse_outline(text: str) -> list[dict]:
	"""Parse the outline into slide dicts. `## Appendix` stops parsing."""
	lines = text.splitlines()
	for index, line in enumerate(lines):
		if re.match(r"^##\s+Appendix\b", line.strip(), re.IGNORECASE):
			lines = lines[:index]
			break
	explicit = any(SLIDE_HEADER.match(line.strip()) for line in lines)

	def new_slide():
		return {
			"title": "", "visual": None, "layout": None, "headline": None,
			"columns": [], "current_column": None, "bullets": [],
			"paragraphs": [], "table": None, "quote": None, "images": [],
			"timeline": [],
		}

	def close(slide: dict):
		if slide["current_column"] and slide["current_column"]["bullets"]:
			slide["columns"].append(slide["current_column"])
		if any(
			(slide["title"], slide["columns"], slide["bullets"], slide["paragraphs"], slide["table"], slide["quote"], slide["timeline"])
		):
			slides.append(slide)

	slides: list[dict] = []
	current: dict | None = None
	for raw in lines:
		stripped = raw.strip()
		if stripped == "---":
			if current:
				close(current)
				current = None
			continue
		if not stripped or stripped.startswith("<!"):
			continue
		if current is None:
			current = new_slide()
		heading = HEADING.match(stripped)
		if heading:
			level, text = heading.group(1), heading.group(2).strip()
			if level == "#" or (level == "##" and not explicit):
				if current["title"]:
					close(current)
					current = new_slide()
				current["title"] = text
			else:
				current["paragraphs"].append(text)
			continue
		visual = VISUAL.match(stripped)
		if visual:
			current["visual"] = visual.group(1)
			continue
		override = LAYOUT_OVERRIDE.match(stripped)
		if override:
			current["layout"] = override.group(1)
			continue
		hint = HINT.match(stripped)
		if hint:
			current["hint"] = hint.group(1)
			continue
		column = COLUMN.match(stripped)
		if column:
			if current["current_column"] and current["current_column"]["bullets"]:
				current["columns"].append(current["current_column"])
			current["current_column"] = {"heading": column.group(1).strip(), "bullets": []}
			continue
		image = IMAGE.match(stripped)
		if image:
			current["images"].append(image.group(1))
			continue
		if stripped.startswith("|"):
			row = [cell.strip() for cell in stripped.strip("|").split("|")]
			if all(re.fullmatch(r":?-{2,}:?", cell) for cell in row):
				continue
			current["table"] = (current["table"] or []) + [row]
			continue
		quote = QUOTE.match(stripped)
		if quote:
			current["quote"] = (current["quote"] + " " + quote.group(1).strip()) if current["quote"] else quote.group(1).strip()
			continue
		timeline = TIMELINE.match(stripped)
		if timeline and not stripped.startswith("[HINT") and not stripped.startswith("[Image") and not stripped.startswith("[Background"):
			current["timeline"].append((timeline.group(1).strip(), timeline.group(2).strip()))
			continue
		bold = BOLD_LINE.match(stripped)
		if bold and not current["current_column"]:
			if current["headline"] is None:
				current["headline"] = bold.group(1).strip()
			else:
				current["paragraphs"].append(stripped)
			continue
		bullet = re.match(r"^[-*]\s+(.*)$", stripped)
		if bullet:
			target = current["current_column"] or current
			target["bullets"].append(bullet.group(1).strip())
			continue
		if current["current_column"]:
			current["current_column"]["bullets"].append(stripped)
		else:
			current["paragraphs"].append(stripped)
	if current:
		close(current)
	return slides


def _split_typography(text: str):
	"""Split `{bold}x{/bold}`-style markers into (text, style) runs."""
	runs: list[tuple[str, dict]] = []
	position = 0
	while position < len(text):
		match = TYPOGRAPHY.search(text, position)
		plain = text[position:(match.start() if match else len(text))]
		if plain:
			runs.append((plain, {"bold": False, "italic": False, "color": None}))
		if not match:
			break
		kind, inner = match.group(1), match.group(2)
		style = {"bold": False, "italic": False, "color": BRAND_BLUE}
		if kind == "bold":
			style["bold"] = True
		elif kind == "italic":
			style["italic"] = True
		elif kind == "question":
			style["italic"] = True
		elif kind == "signpost":
			style["color"] = BRAND_GRAY
		runs.append((inner, style))
		position = match.end()
	return runs or [(text, {"bold": False, "italic": False, "color": None})]


def _write_runs(paragraph, text: str, size: int | None = None, bold: bool = False):
	for part, style in _split_typography(text):
		run = paragraph.add_run()
		run.text = part
		run.font.bold = style["bold"] or bold
		run.font.italic = style["italic"]
		if style["color"] is not None:
			run.font.color.rgb = style["color"]
		if size:
			run.font.size = Pt(size)


def _fill_text_frame(placeholder, lines: list[tuple[str, str]], size: int | None = None):
	"""lines: (text, kind) where kind is 'h' (heading), 'b' (bullet) or 'p' (paragraph)."""
	text_frame = placeholder.text_frame
	text_frame.word_wrap = True
	first = True
	for text, kind in lines:
		paragraph = text_frame.paragraphs[0] if first else text_frame.add_paragraph()
		first = False
		if kind == "b":
			_write_runs(paragraph, text, size=size)
		else:
			_write_runs(paragraph, text, size=(size + 2 if kind == "h" and size else size), bold=(kind == "h"))


def _fill_body(placeholder, lines: list[tuple[str, str]], size: int | None):
	if not lines:
		return
	_fill_text_frame(placeholder, lines, size=size)


def _layout_named(prs: Presentation, words: tuple[str, ...]):
	for layout in prs.slide_master.slide_layouts:
		name = layout.name.lower()
		if any(word in name for word in words):
			return layout
	return None


def _pick_layout(slide: dict, prs: Presentation, result: dict, first: bool):
	layouts = list(prs.slide_master.slide_layouts)
	name = slide.get("layout") or slide.get("hint")
	if name:
		for layout in layouts:
			if layout.name == name:
				return layout
		result["warnings"].append(f"layout `{name}` is not in this template; auto-picked instead")
	blocks = len(slide["columns"]) or (1 if (slide["bullets"] or slide["paragraphs"] or slide["table"] or slide["quote"] or slide["timeline"]) else 0)
	if not blocks:
		# Cover on the first slide, a section/hero slide after it: by name
		# when the template names one, else the first layout (a title slide
		# in every stock template).
		words = ("cover", "title") if first else ("section", "center", "title")
		return _layout_named(prs, words) or layouts[0]
	visual = slide["visual"]
	if visual and re.match(r"(process|comparison|cards|column)-?\d*", visual):
		digits = re.search(r"(\d+)", visual)
		blocks = max(2, int(digits.group(1)) if digits else 3)
	# A slide with a title needs a layout that has one — an auto-picked
	# layout without a title placeholder would silently drop the title.
	best = None
	for index, layout in enumerate(layouts):
		count = sum(
			1
			for ph in layout.placeholders
			if ph.placeholder_format.type == 2 and ph.placeholder_format.idx not in (0, 12)
		)
		has_title = any(ph.placeholder_format.idx == 0 for ph in layout.placeholders)
		if count >= blocks and (slide["title"] == "" or has_title) and (best is None or count < best[0]):
			best = (count, index)
	if best is not None:
		return layouts[best[1]]
	# Nothing fits the block count — a template can lack a 3-column layout.
	# The layout with the most body placeholders takes the overflow (the
	# fill merges the extra blocks into its last placeholder); Blank, with
	# none, is the last resort.
	fallback = None
	for index, layout in enumerate(layouts):
		count = sum(
			1
			for ph in layout.placeholders
			if ph.placeholder_format.type == 2 and ph.placeholder_format.idx not in (0, 12)
		)
		has_title = any(ph.placeholder_format.idx == 0 for ph in layout.placeholders)
		if (slide["title"] == "" or has_title) and (fallback is None or count > fallback[0]):
			fallback = (count, index)
	return layouts[fallback[1]] if fallback is not None else layouts[0]


def _fill_slide(slide: dict, prs: Presentation, result: dict, first: bool):
	layout = _pick_layout(slide, prs, result, first)
	slide_shape = prs.slides.add_slide(layout)
	placeholders = {ph.placeholder_format.idx: ph for ph in slide_shape.placeholders}
	title = placeholders.get(0)
	bodies = sorted(
		(ph for idx, ph in placeholders.items() if ph.placeholder_format.type == 2 and idx not in (0, 12)),
		key=lambda ph: (ph.top or 0, ph.left or 0),
	)
	for ph in placeholders.values():
		if ph.placeholder_format.type == 18:
			result["picture_slots"].append(ph.name)
	has_body_content = bool(slide["columns"] or slide["bullets"] or slide["table"] or slide["quote"] or slide["timeline"])
	cover = not has_body_content and not slide["paragraphs"]

	if not has_body_content:
		# Cover / hero: the title placeholder (or the first body on a cover
		# layout without one) carries the text; extra paragraphs spread over
		# the remaining body placeholders.
		lines = [slide["headline"] or slide["title"]]
		lines += [p for p in slide["paragraphs"]]
		if title is None and bodies:
			_write_runs(bodies[0].text_frame.paragraphs[0], lines[0], size=28, bold=True)
			for ph, text in zip(bodies[1:], lines[1:]):
				_write_runs(ph.text_frame.paragraphs[0], text, size=16)
		elif title is not None:
			title.text_frame.word_wrap = True
			_write_runs(title.text_frame.paragraphs[0], lines[0], size=28, bold=True)
			for ph, text in zip(bodies, lines[1:]):
				_write_runs(ph.text_frame.paragraphs[0], text, size=16)
		return

	if title is not None:
		title.text_frame.word_wrap = True
		_write_runs(title.text_frame.paragraphs[0], slide["title"], size=28, bold=True)
	if not bodies:
		result["warnings"].append(f"`{slide['title']}`: this layout has no body placeholder; its content was not placed")
		return
	if slide["quote"]:
		_fill_body(bodies[0], [(f"“{slide['quote']}”", "p")], size=22)
		bodies[0].text_frame.paragraphs[0].alignment = PP_ALIGN.LEFT
	elif slide["table"]:
		rows = slide["table"]
		width = prs.slide_width - Inches(1.2)
		graphic = slide_shape.shapes.add_table(
			len(rows), len(rows[0]), Inches(0.6), Inches(1.7),
			width, Inches(0.4 + 0.35 * len(rows)),
		)
		for r, row in enumerate(rows):
			for c, cell in enumerate(row[: len(graphic.table.columns)]):
				_write_runs(graphic.table.cell(r, c).text_frame.paragraphs[0], cell, size=11, bold=(r == 0))
	elif slide["timeline"]:
		for entry, ph in zip(slide["timeline"], bodies):
			_fill_body(ph, [(entry[0], "h"), (entry[1], "b")], size=14)
	elif slide["columns"]:
		count = min(len(slide["columns"]), len(bodies))
		for block, ph in zip(slide["columns"][: count - 1], bodies[: count - 1]):
			_fill_body(ph, [(block["heading"], "h")] + [(b, "b") for b in block["bullets"]], size=14)
		# The last body placeholder takes its own block plus any overflow,
		# so no content is silently dropped when the template runs short.
		lines: list[tuple[str, str]] = []
		for block in slide["columns"][count - 1:]:
			lines.append((block["heading"], "h"))
			lines.extend((b, "b") for b in block["bullets"])
		_fill_body(bodies[count - 1], lines, size=14)
	elif slide["bullets"]:
		lines = ([(slide["headline"], "h")] if slide["headline"] else []) + [(b, "b") for b in slide["bullets"]]
		_fill_body(bodies[0], lines, size=16)


def generate(outline_path: str, out_path: str, template_path: str | None = None) -> dict:
	"""Generate the deck. Returns {out_path, slides, warnings, picture_slots}.

	Without a template, python-pptx's built-in template provides the layouts
	(title slide, title-and-content, …); with one, the person's own .pptx —
	its real layouts and placeholders are what the deck fills.
	"""
	with open(outline_path, encoding="utf-8") as fh:
		slides = parse_outline(fh.read())
	if not slides:
		raise ValueError("the outline parsed to zero slides — check the `---` separators and titles")
	prs = Presentation(template_path) if template_path else Presentation()
	# A template ships layouts, not slides — but files in the wild carry demo
	# or branding slides. The deck starts from the outline alone, with the
	# template's branding layout first when it defines one ("always Slide 1",
	# as the bundled template's config puts it) — the rule the upstream
	# engine follows.
	xml = prs.slides._sldIdLst
	for element in list(xml):
		xml.remove(element)
	branding = _layout_named(prs, ("master-base", "branding"))
	if branding is not None:
		prs.slides.add_slide(branding)
	result: dict = {"out_path": out_path, "slides": len(slides), "warnings": [], "picture_slots": []}
	for index, slide in enumerate(slides):
		_fill_slide(slide, prs, result, first=(index == 0))
	prs.save(out_path)
	result["picture_slots"] = list(dict.fromkeys(result["picture_slots"]))
	return result
