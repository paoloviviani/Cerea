"""Where things are on a PDF page: the text lines with positions (`doc_outline`), and for every form field the
label that describes it and, for fields aligned in rows and columns, its place in the table.

Positions are PDF points in the page's own space, origin at the bottom left (the same as a field's /Rect and as
`place_text`). Text comes from pypdf's text visitor, one fragment per text-showing operation; fragments on one
baseline are merged into segments. A fragment's width is not known to the visitor, so a segment's right edge
(`x + w`) is estimated from Helvetica's widths: good to a few points, not exact.

Everything here is deterministic and capped. It imports pypdf only through the reader it is given, and only the
PDF jobs of the service load this module.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

from .pdfform import _text_width as _helvetica_width

MAX_LINES_PER_PAGE = 200
MAX_LINES_TOTAL = 1500
MAX_TEXT_PAGES = 40  # pages whose text lines are listed; fields are labelled on every page
MAX_LABEL = 80
MAX_SEGMENT_TEXT = 300
LINE_TOLERANCE = 1.5  # points between baselines of the same line
HEADER_REACH = 30.0  # how far above a table's first row its column headers are looked for
ABOVE_REACH = 24.0  # how far above a field "the text just above" is looked for

_FILLER = re.compile(r"[._…]{3,}")
_PRIVATE = re.compile("[-•●■▪]")
_SPACES = re.compile(r"\s+")


_WIDE = {"\u2026": 1000, "\u2014": 1000, "\u2013": 556, "\u2019": 222, "\u2018": 222, "\u201c": 333, "\u201d": 333}


def _text_width(text: str, size: float) -> float:
    """Helvetica's width, with the few typographic marks the base table does not know."""
    extra = sum(_WIDE.get(c, 0) - 556 for c in text if c in _WIDE)
    return _helvetica_width(text, size) + extra * size / 1000


@dataclass
class Seg:
    """A run of text on one baseline: raw text (filler kept), left edge, estimated right edge, baseline, size."""

    raw: str
    x0: float
    x1: float
    y: float
    size: float

    @property
    def text(self) -> str:
        return clean(self.raw)


def meaningful(text: str) -> str:
    """The text without the blanks (`___`) and dots at its ends; "" when nothing readable is left."""
    text = text.strip(" ._")
    while text.startswith("___") or text.endswith("___"):
        text = text.removeprefix("___").removesuffix("___").strip(" ._")
    return text if re.search(r"\w", text) else ""


def clean(raw: str) -> str:
    """Readable text: private-use bullet glyphs dropped, runs of dots and underscores (the blanks) as `___`."""
    text = _PRIVATE.sub("", raw)
    text = _FILLER.sub(" ___ ", text)
    return _SPACES.sub(" ", text).strip()


def _fragments(page: Any) -> list[Seg]:
    found: list[Seg] = []

    def visit(text: str, cm: list[float], tm: list[float], _font: Any, size: float) -> None:
        text = text.replace("\n", " ").replace("\r", " ")
        if not clean(text):  # nothing but blanks or bullet glyphs: not text a label can use
            return
        try:
            x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
            y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
            a = tm[0] * cm[0] + tm[1] * cm[2]
            b = tm[0] * cm[1] + tm[1] * cm[3]
            scale = math.hypot(a, b) or 1.0
            fs = abs(float(size)) * scale if size else 10.0
        except (TypeError, ValueError, IndexError):
            return
        if not all(math.isfinite(v) for v in (x, y, fs)) or fs <= 0:
            return
        found.append(Seg(text, x, x + _text_width(text, fs), y, fs))

    try:
        page.extract_text(visitor_text=visit)
    except Exception:  # a page whose content cannot be parsed has no text lines
        return []
    return found


def page_segments(page: Any) -> list[Seg]:
    """The text of a page as segments, top to bottom and left to right."""
    frags = sorted(_fragments(page), key=lambda s: (-s.y, s.x0))
    lines: list[list[Seg]] = []
    for frag in frags:
        if lines and abs(lines[-1][0].y - frag.y) <= LINE_TOLERANCE:
            lines[-1].append(frag)
        else:
            lines.append([frag])
    out: list[Seg] = []
    for line in lines:
        line.sort(key=lambda s: s.x0)
        cur = line[0]
        for nxt in line[1:]:
            gap = nxt.x0 - cur.x1
            if gap <= 0.6 * max(cur.size, nxt.size):
                joiner = "" if (gap <= 0.35 * cur.size or cur.raw.endswith(" ") or nxt.raw.startswith(" ")) else " "
                cur = Seg(cur.raw + joiner + nxt.raw, cur.x0, max(cur.x1, nxt.x1), cur.y, max(cur.size, nxt.size))
            else:
                out.append(cur)
                cur = nxt
        out.append(cur)
    return [s for s in out if s.text]


def text_lines(reader: Any, *, pages: int) -> dict[int, list[dict[str, Any]]]:
    """{page number: [{x, y, w, text}]} for the first pages, capped per page and in total."""
    out: dict[int, list[dict[str, Any]]] = {}
    total = 0
    for number in range(1, min(pages, MAX_TEXT_PAGES) + 1):
        if total >= MAX_LINES_TOTAL:
            break
        rows = []
        for seg in page_segments(reader.pages[number - 1])[:MAX_LINES_PER_PAGE]:
            rows.append(
                {
                    "x": round(seg.x0, 1),
                    "y": round(seg.y, 1),
                    "w": round(seg.x1 - seg.x0, 1),
                    "text": seg.text[:MAX_SEGMENT_TEXT],
                }
            )
        rows = rows[: MAX_LINES_TOTAL - total]
        total += len(rows)
        out[number] = rows
    return out


# -- labels and tables --------------------------------------------------------------------------------------


@dataclass
class Box:
    name: str
    page: int
    x: float
    y: float
    w: float
    h: float

    @property
    def x1(self) -> float:
        return self.x + self.w

    @property
    def top(self) -> float:
        return self.y + self.h


def _boxes(fields: list[dict[str, Any]]) -> dict[int, list[Box]]:
    by_page: dict[int, list[Box]] = {}
    for f in fields:
        r = f.get("rect")
        if r and f.get("type") in ("text", "combo", "list"):
            by_page.setdefault(r["page"], []).append(Box(f["name"], r["page"], r["x"], r["y"], r["w"], r["h"]))
    return by_page


def _cluster(values: list[float], tolerance: float) -> list[float]:
    """Cluster centres of sorted values: a value joins the cluster whose first member is within `tolerance`."""
    firsts: list[float] = []
    for v in sorted(values):
        if not firsts or v - firsts[-1] > tolerance:
            firsts.append(v)
    return firsts


def _nearest(centres: list[float], value: float) -> int:
    return min(range(len(centres)), key=lambda i: abs(centres[i] - value))


def find_tables(boxes: list[Box]) -> list[list[list[Box]]]:
    """Grids on one page: runs of rows (at least two, each with at least two fields) whose columns line up."""
    rows: list[list[Box]] = []
    for box in sorted(boxes, key=lambda b: (-b.top, b.x)):
        if rows and abs(rows[-1][0].top - box.top) <= 3.5:
            rows[-1].append(box)
        else:
            rows.append([box])
    for row in rows:
        row.sort(key=lambda b: b.x)
    tables: list[list[list[Box]]] = []
    current: list[list[Box]] = []

    def lined_up(a: list[Box], b: list[Box]) -> bool:
        return sum(1 for p in a if any(abs(p.x - q.x) <= 6 for q in b)) >= 2

    for row in rows:
        if len(row) < 2:
            if len(current) >= 2:
                tables.append(current)
            current = []
            continue
        if current:
            prev = current[-1]
            gap = min(b.y for b in prev) - max(b.top for b in row)
            if gap <= 1.2 * max(b.h for b in row) and lined_up(prev, row):
                current.append(row)
                continue
            if len(current) >= 2:
                tables.append(current)
        current = [row]
    if len(current) >= 2:
        tables.append(current)
    return tables


def _above(segs: list[Seg], left: float, right: float, bottom: float, reach: float) -> Seg | None:
    """The nearest text line above `bottom` (within `reach`) that starts in [left, right]."""
    best: Seg | None = None
    for s in segs:
        if (
            bottom + 0.5 <= s.y <= bottom + reach
            and left <= s.x0 < right
            and (best is None or s.y < best.y or (s.y == best.y and s.x0 < best.x0))
        ):
            best = s
    return best


def _left_text(segs: list[Seg], box: Box, row: list[Box]) -> str:
    """The text on the field's line to its left (down to the previous field on that line), or "" for none."""
    centre = box.y + box.h / 2
    on_line = [s for s in segs if box.y - 2 <= s.y <= box.top - 1 and s.x0 < box.x - 0.5]
    if not on_line:
        return ""
    line_y = min((s.y for s in on_line), key=lambda y: abs(y - centre))
    mine = [s for s in on_line if abs(s.y - line_y) <= LINE_TOLERANCE]
    # the previous field on this line bounds the text that belongs to this one
    prev_end = max(
        (b.x1 for b in row if b.name != box.name and b.x1 <= box.x + 1 and b.y <= line_y <= b.top + 1),
        default=None,
    )

    def cut(lo: float | None) -> str:
        # the widths are estimated, so a word the box starts inside is kept whole, and the text just after the
        # previous field is allowed to start a little before where its right edge is estimated to be
        parts = []
        for s in mine:
            kept: list[str] = []
            x = s.x0
            for char in s.raw:
                if x >= box.x - 0.5 and not (kept and (kept[-1].isalnum() and (char.isalnum() or char in "'\u2019"))):
                    break
                if lo is None or x >= lo - 8:
                    kept.append(char)
                x += _text_width(char, s.size)
            parts.append("".join(kept))
        return meaningful(clean(" ".join(parts)))

    text = cut(prev_end) if prev_end is not None else ""
    return text or cut(None)


def _trim(text: str, tail: bool) -> str:
    if len(text) <= MAX_LABEL:
        return text
    return "..." + text[-(MAX_LABEL - 3) :] if tail else text[: MAX_LABEL - 3] + "..."


def annotate(reader: Any, form: dict[str, Any]) -> None:
    """Add `label` and `table` to the form's fields (in place), and `tables` to the form."""
    fields = form["fields"]
    by_page = _boxes(fields)
    info: dict[str, dict[str, Any]] = {}
    tables_out: list[dict[str, Any]] = []
    segs_by_page: dict[int, list[Seg]] = {}

    def segs_of(page: int) -> list[Seg]:
        if page not in segs_by_page:
            segs_by_page[page] = page_segments(reader.pages[page - 1])
        return segs_by_page[page]

    for page, boxes in sorted(by_page.items()):
        segs = segs_of(page)
        tid = len(tables_out)
        for grid in find_tables(boxes):
            tid += 1
            all_boxes = [b for row in grid for b in row]
            centres = _cluster([b.x for b in all_boxes], 8.0)
            headers: list[str] = []
            for c, left in enumerate(centres):
                members = [b for b in grid[0] if _nearest(centres, b.x) == c] or [
                    b for b in all_boxes if _nearest(centres, b.x) == c
                ]
                span_right = max(b.x1 for b in members)
                head = _above(segs, left - 6, span_right, max(b.top for b in grid[0]), HEADER_REACH)
                headers.append(_trim(head.text, False) if head else "")
            for r, row in enumerate(grid, start=1):
                for b in row:
                    col = _nearest(centres, b.x)
                    info[b.name] = {
                        "table": {"id": tid, "row": r, "col": col + 1},
                        "label": headers[col],
                    }
            tables_out.append({"id": tid, "page": page, "rows": len(grid), "cols": len(centres), "headers": headers})
        for box in boxes:
            if box.name in info and info[box.name].get("label"):
                continue
            row = [b for b in boxes if abs(b.top - box.top) <= 3.5 or (b.y < box.top and b.top > box.y)]
            label = _left_text(segs, box, row)
            if label:
                label = _trim(label, True)
            else:
                above = _above(segs, box.x - 2, box.x1 + 2, box.top, ABOVE_REACH)
                label = _trim(above.text, False) if above else ""
            info.setdefault(box.name, {})
            if label:
                info[box.name]["label"] = label
    for f in fields:
        extra = info.get(f["name"])
        if extra:
            f.update({k: v for k, v in extra.items() if v})
    if tables_out:
        form["tables"] = tables_out
