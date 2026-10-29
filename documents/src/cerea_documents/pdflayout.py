"""Where things are on a PDF page: the text lines with positions (`doc_outline`), and for every form field the
label that describes it and, for fields aligned in rows and columns, its place in the table.

Positions are PDF points in the page's own space, origin at the bottom left (the same as a field's /Rect and as
`place_text`). Text comes from pypdf's text visitor, one fragment per text-showing operation; fragments on one
baseline are merged into segments. A fragment's width is not known to the visitor, so a segment's right edge
(`x + w`) is estimated from Helvetica's widths: good to a few points, not exact. Text drawn through a Form
XObject — every value of a flattened form — is placed by the `cm` at its `Do` and the form's /Matrix; pypdf
recurses into the form with a fresh state and applies neither, so an operator pair here composes them into the
matrix the text visitor sees.

Everything here is deterministic and capped. It imports pypdf only through the reader it is given, and only the
PDF jobs of the service load this module.
"""

from __future__ import annotations

import math
import re
import time
from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .pdfform import _text_width as _helvetica_width

MAX_LINES_PER_PAGE = 200
MAX_LINES_TOTAL = 1500
LAYOUT_PAGES = 40  # pages whose text is read at all: their lines are listed and their fields are labelled
LAYOUT_SECONDS = 6.0  # a safety net on top of the page cap: the outline must answer inside the worker's limits
MAX_FRAGMENTS = 20_000  # text fragments read from one page
MAX_LABEL = 80
MAX_SEGMENT_TEXT = 300
LINE_TOLERANCE = 1.5  # points between baselines of the same line
HEADER_REACH = 30.0  # how far above a table's first row its column headers are looked for
ABOVE_REACH = 24.0  # how far above a field "the text just above" is looked for

_IDENTITY: tuple[float, ...] = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

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


def _mul(o: Sequence[float], i: Sequence[float]) -> list[float]:
    """The affine matrix `o` composed with `i`, `i` applied first (`_mul(o, i)(p) == o(i(p))`); the PDF's
    six-number [a b c d e f] shape."""
    a, b, c, d, e, f = (float(v) for v in o)
    return [
        a * i[0] + c * i[1],
        b * i[0] + d * i[1],
        a * i[2] + c * i[3],
        b * i[2] + d * i[3],
        a * i[4] + c * i[5] + e,
        b * i[4] + d * i[5] + f,
    ]


def _form_resources(page: Any) -> Any:
    """The page's /Resources when its /XObject holds a Form XObject (text can then be drawn through one)."""
    try:
        resources = page["/Resources"].get_object()
    except Exception:
        try:
            resources = page.get_inherited("/Resources")
        except Exception:
            return None
    try:
        xobjects = resources.get("/XObject")
        if xobjects is not None:
            for value in xobjects.get_object().values():
                if value.get_object().get("/Subtype") == "/Form":
                    return resources
    except Exception:
        return None
    return None


def _fragments(page: Any) -> list[Seg]:
    found: list[Seg] = []
    page_resources = _form_resources(page)
    # pypdf reads the text of a Form XObject with a fresh state: the `cm` at its `Do` and the form's own
    # /Matrix are never applied, so text drawn through a form — every value of a flattened form — is reported
    # at its place inside the form, near the page's origin. `placed` and `waiting` follow the forms the
    # operand visitors walk through, in the order pypdf recurses, so `visit` can fold each form's placement
    # into the `cm` it is given. A form counts as entered only from its first drawn operation on: the pieces
    # of the surrounding text that pypdf flushes at the `Do` itself keep the placement outside the form.
    placed: list[tuple[list[float], Any]] = []  # forms entered: (form space -> page space, resources for Dos)
    waiting: tuple[list[float], Any] | None = None  # a `Do` seen, entered when its first operation arrives

    def enter(operands: Any, cm: Any, level: Any) -> tuple[list[float], Any]:
        """(placement, resources) of the form `operands` names, drawn with the CTM `cm` inside `level`."""
        matrix = _IDENTITY
        try:
            item = level.get("/XObject").get_object()[operands[0]].get_object()
            value = item.get("/Matrix")
            if value is not None:
                matrix = tuple(float(v) for v in value)
            own = item.get("/Resources")
            child = own.get_object() if own is not None else level
        except Exception:
            child = level  # an unreadable form is placed as its `cm` says, with the level's own resources
        try:
            outer = placed[-1][0] if placed else _IDENTITY
            return _mul(_mul(outer, [float(v) for v in cm[:6]]), matrix), child
        except Exception:
            return list(_IDENTITY), child

    def before(op: Any, operands: Any, cm: Any, _tm: Any) -> None:
        nonlocal waiting
        try:
            if waiting is not None:  # an operation inside the waiting form: the form is entered from here on
                placed.append(waiting)
                waiting = None
            if op == b"Do":
                waiting = enter(operands, cm, placed[-1][1] if placed else page_resources)
        except Exception:
            waiting = (list(_IDENTITY), page_resources)  # the leave stays balanced even if this failed

    def after(op: Any, operands: Any, cm: Any, tm: Any) -> None:
        nonlocal waiting
        if op != b"Do":
            return
        if waiting is not None:  # nothing was drawn from this form (empty, an image, cyclic): never entered
            waiting = None
        elif placed:
            placed.pop()

    def visit(text: str, cm: list[float], tm: list[float], _font: Any, size: float) -> None:
        text = text.replace("\n", " ").replace("\r", " ")
        if not clean(text):  # nothing but blanks or bullet glyphs: not text a label can use
            return
        try:
            if placed:  # text drawn through a form: fold the form's placement into the cm pypdf passes
                cm = _mul(placed[-1][0], cm)
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
        if page_resources is None:  # no form on the page: the visitors would only cost two calls per operator
            page.extract_text(visitor_text=visit)
        else:
            page.extract_text(visitor_text=visit, visitor_operand_before=before, visitor_operand_after=after)
    except Exception:  # a page whose content cannot be parsed has no text lines
        return []
    return found[:MAX_FRAGMENTS]


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


class PageText:
    """The segments of one page, indexed by line so that "what is on this line" and "what is just above" are
    bisections, not scans."""

    def __init__(self, segs: list[Seg]) -> None:
        self.segs = segs
        lines: dict[float, list[Seg]] = {}
        for s in segs:
            lines.setdefault(round(s.y, 1), []).append(s)
        self.lines: list[tuple[float, list[Seg]]] = sorted(lines.items())
        self.ys = [y for y, _ in self.lines]

    def between(self, low: float, high: float) -> list[Seg]:
        """Segments whose baseline is in [low, high]."""
        first, last = bisect_left(self.ys, low), bisect_right(self.ys, high)
        return [s for _, line in self.lines[first:last] for s in line]


class Layout:
    """The text of a PDF's first pages, extracted once and shared by the outline's text lines and the field
    labels. Pages past LAYOUT_PAGES, and any page after the time budget is spent, are not read (`complete` is
    False then): the fields on them come without a label."""

    def __init__(self, reader: Any, *, seconds: float = LAYOUT_SECONDS) -> None:
        self.reader = reader
        self.pages = len(reader.pages)
        self.deadline = time.monotonic() + seconds
        self._cache: dict[int, PageText] = {}
        self.complete = self.pages <= LAYOUT_PAGES
        self.out_of_time = False

    def page(self, number: int) -> PageText | None:
        if number in self._cache:
            return self._cache[number]
        if not 1 <= number <= min(self.pages, LAYOUT_PAGES):
            return None
        if time.monotonic() > self.deadline:
            self.out_of_time = True
            self.complete = False
            return None
        self._cache[number] = PageText(page_segments(self.reader.pages[number - 1]))
        return self._cache[number]


def text_lines(layout: Layout) -> dict[int, list[dict[str, Any]]]:
    """{page number: [{x, y, w, text}]} for the first pages, capped per page and in total."""
    out: dict[int, list[dict[str, Any]]] = {}
    total = 0
    for number in range(1, min(layout.pages, LAYOUT_PAGES) + 1):
        if total >= MAX_LINES_TOTAL:
            break
        text = layout.page(number)
        if text is None:
            break
        rows = [
            {
                "x": round(seg.x0, 1),
                "y": round(seg.y, 1),
                "w": round(seg.x1 - seg.x0, 1),
                "text": seg.text[:MAX_SEGMENT_TEXT],
            }
            for seg in text.segs[:MAX_LINES_PER_PAGE]
        ]
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
    """Cluster starts of sorted values: a value joins the cluster whose first member is within `tolerance`."""
    firsts: list[float] = []
    for v in sorted(values):
        if not firsts or v - firsts[-1] > tolerance:
            firsts.append(v)
    return firsts


def _nearest(centres: list[float], value: float) -> int:
    """Index of the closest of the sorted `centres`."""
    i = bisect_left(centres, value)
    if i == 0:
        return 0
    if i == len(centres):
        return len(centres) - 1
    return i if centres[i] - value < value - centres[i - 1] else i - 1


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
        xs = [q.x for q in b]  # b is sorted by x
        hits = 0
        for p in a:
            i = bisect_left(xs, p.x - 6)
            if i < len(xs) and xs[i] <= p.x + 6:
                hits += 1
                if hits >= 2:
                    return True
        return False

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


def _above(text: PageText, left: float, right: float, bottom: float, reach: float) -> Seg | None:
    """The nearest text line above `bottom` (within `reach`) that starts in [left, right]."""
    best: Seg | None = None
    for s in text.between(bottom + 0.5, bottom + reach):
        if left <= s.x0 < right and (best is None or s.y < best.y or (s.y == best.y and s.x0 < best.x0)):
            best = s
    return best


class _Neighbours:
    """The fields of a page by their bottom edge, to find the ones on a given line."""

    def __init__(self, boxes: list[Box]) -> None:
        self.boxes = sorted(boxes, key=lambda b: b.y)
        self.ys = [b.y for b in self.boxes]
        self.tallest = max((b.h for b in boxes), default=0.0)

    def on_line(self, y: float) -> list[Box]:
        first, last = bisect_left(self.ys, y - self.tallest - 1), bisect_right(self.ys, y)
        return [b for b in self.boxes[first:last] if b.top + 1 >= y]


def _left_text(text: PageText, box: Box, neighbours: _Neighbours) -> str:
    """The text on the field's line to its left (down to the previous field on that line), or "" for none."""
    centre = box.y + box.h / 2
    on_line = [s for s in text.between(box.y - 2, box.top - 1) if s.x0 < box.x - 0.5]
    if not on_line:
        return ""
    line_y = min((s.y for s in on_line), key=lambda y: abs(y - centre))
    mine = [s for s in on_line if abs(s.y - line_y) <= LINE_TOLERANCE]
    # the previous field on this line bounds the text that belongs to this one
    prev_end = max(
        (b.x1 for b in neighbours.on_line(line_y) if b.name != box.name and b.x1 <= box.x + 1),
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

    found = cut(prev_end) if prev_end is not None else ""
    return found or cut(None)


def _trim(text: str, tail: bool) -> str:
    if len(text) <= MAX_LABEL:
        return text
    return "..." + text[-(MAX_LABEL - 3) :] if tail else text[: MAX_LABEL - 3] + "..."


def annotate(layout: Layout, form: dict[str, Any]) -> None:
    """Add `label` and `table` to the form's fields (in place), and `tables` to the form. Only fields on pages
    the layout reads get them; `form["labels_note"]` says when some were left out."""
    fields = form["fields"]
    by_page = _boxes(fields)
    info: dict[str, dict[str, Any]] = {}
    tables_out: list[dict[str, Any]] = []
    unlabelled = 0
    for page, boxes in sorted(by_page.items()):
        text = layout.page(page)
        if text is None:
            unlabelled += len(boxes)
            continue
        tid = len(tables_out)
        for grid in find_tables(boxes):
            tid += 1
            all_boxes = [b for row in grid for b in row]
            centres = _cluster([b.x for b in all_boxes], 8.0)
            columns: dict[int, list[Box]] = {}
            for b in grid[0]:
                columns.setdefault(_nearest(centres, b.x), []).append(b)
            headers: list[str] = []
            for c, left in enumerate(centres):
                members = columns.get(c) or [b for b in all_boxes if _nearest(centres, b.x) == c]
                head = _above(text, left - 6, max(b.x1 for b in members), max(b.top for b in grid[0]), HEADER_REACH)
                headers.append(_trim(head.text, False) if head else "")
            for r, row in enumerate(grid, start=1):
                for b in row:
                    col = _nearest(centres, b.x)
                    info[b.name] = {"table": {"id": tid, "row": r, "col": col + 1}, "label": headers[col]}
            tables_out.append({"id": tid, "page": page, "rows": len(grid), "cols": len(centres), "headers": headers})
        neighbours = _Neighbours(boxes)
        for box in boxes:
            if box.name in info and info[box.name].get("label"):
                continue
            label = _left_text(text, box, neighbours)
            if label:
                label = _trim(label, True)
            else:
                above = _above(text, box.x - 2, box.x1 + 2, box.top, ABOVE_REACH)
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
    if unlabelled:
        form["labels_note"] = (
            f"{unlabelled} field{'s' if unlabelled != 1 else ''} on later pages have no label or table: only the "
            f"first {LAYOUT_PAGES} pages' text is read{' (time ran out)' if layout.out_of_time else ''}; "
            "look at those pages with look_doc"
        )
