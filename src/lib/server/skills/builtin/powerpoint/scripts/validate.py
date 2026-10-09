"""validate.py: quality checks for a generated or edited deck, in Cerea's sandbox.

Distilled for Cerea from pptx-from-layouts (MIT, Tristan McInnis). What it
catches: empty titles and body placeholders, text estimated to overflow its
placeholder, shapes off the slide, and empty picture placeholders left behind.
What it cannot catch (no renderer in the sandbox): the actual rendered look —
the person should open the deck for spacing and brand feel. No argv: import
this file and call `validate(...)` with paths.
"""

from __future__ import annotations

import math

from pptx import Presentation
from pptx.util import Emu

# Rough line metrics for the overflow heuristic: a character is ~0.5pt of
# font width per point of size, and a line box is ~1.25x the font size. This
# is a tripwire, not typography — it errs toward warning.
CHAR_WIDTH_FACTOR = 0.52
LINE_HEIGHT_FACTOR = 1.28


def _frame_text(shape) -> str:
	return "\n".join(
		("".join(run.text for run in paragraph.runs) or paragraph.text)
		for paragraph in shape.text_frame.paragraphs
	)


def _estimate_overflow(shape) -> float | None:
	"""How far the text's estimated height exceeds the shape's height (1.0 = exactly full)."""
	text = _frame_text(shape)
	if not text.strip():
		return None
	sizes = [
		run.font.size.pt
		for paragraph in shape.text_frame.paragraphs
		for run in paragraph.runs
		if run.font.size is not None
	]
	size = max(sizes) if sizes else 12.0
	width_inches = (shape.width or 0) / 914400
	height_inches = (shape.height or 0) / 914400
	if width_inches <= 0 or height_inches <= 0:
		return None
	chars_per_line = max(8, width_inches * 72 / (size * CHAR_WIDTH_FACTOR))
	lines = 0
	for line in text.split("\n"):
		lines += max(1, math.ceil(len(line) / chars_per_line))
	estimated = lines * size * LINE_HEIGHT_FACTOR / 72
	return estimated / height_inches


def validate(path: str, template_path: str | None = None) -> dict:
	"""Run the checks. Returns {score, errors, warnings, info}; 100 is clean."""
	prs = Presentation(path)
	slide_width, slide_height = prs.slide_width, prs.slide_height
	errors: list[str] = []
	warnings: list[str] = []
	info: list[str] = []
	for s, slide in enumerate(prs.slides, start=1):
		title_filled = False
		body_filled = 0
		pictures_empty = 0
		decorated = False  # non-placeholder shapes: branding, tables, logos
		for shape in slide.shapes:
			text = _frame_text(shape) if shape.has_text_frame else ""
			if not shape.is_placeholder:
				decorated = True
				continue
			kind = shape.placeholder_format.type
			idx = shape.placeholder_format.idx
			if kind == 13 or idx == 12:  # slide number
				continue
			if kind == 1:  # title
				if text.strip():
					title_filled = True
				continue
			if kind == 2:  # body
				if text.strip():
					body_filled += 1
				continue
			if kind == 18:  # picture
				try:
					_ = shape.image
				except (ValueError, AttributeError):
					pictures_empty += 1
				continue
			if text.strip():
				ratio = _estimate_overflow(shape)
				if ratio is not None and ratio > 1.05:
					warnings.append(
						f"slide {s}: `{shape.name}` text may overflow "
						f"({ratio:.0%} of its height) — tighten or split it"
					)
			try:
				left, top = shape.left or 0, shape.top or 0
				if left < -Emu(20000) or top < -Emu(20000) or (shape.width and left + shape.width > slide_width + Emu(20000)) or (shape.height and top + shape.height > slide_height + Emu(20000)):
					errors.append(f"slide {s}: `{shape.name}` sits partly off the slide")
			except TypeError:
				pass
		# A design slide (branding, divider) carries its look in the layout,
		# so the slide itself is legitimately empty; "empty" is only an
		# error on a layout that offers content placeholders.
		content_layout = any(
			shape.is_placeholder
			and shape.placeholder_format.type in (1, 2)
			and shape.placeholder_format.idx not in (12,)
			for shape in slide.shapes
		)
		if not title_filled and body_filled == 0 and not decorated and content_layout:
			errors.append(f"slide {s}: no title and no filled body — an empty slide")
		elif not title_filled and content_layout:
			warnings.append(f"slide {s}: the title placeholder is empty")
		if pictures_empty:
			info.append(
				f"slide {s}: {pictures_empty} picture placeholder(s) still empty — "
				"attach images or replace them with content"
			)
	score = 100 - 12 * len(errors) - 4 * len(warnings)
	return {
		"score": max(0, score),
		"errors": errors,
		"warnings": warnings,
		"info": info,
		"slides": len(prs.slides._sldIdLst),
	}
