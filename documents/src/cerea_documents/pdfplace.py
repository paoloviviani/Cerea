"""Text onto a PDF page that has no form fields (a scanned or printed form, lines to write on): `doc_edit`'s
`place_text`. The text is drawn into the page's content as an overlay, in Helvetica (Windows-1252), at the
positions given in PDF points (origin at the page's bottom left, the same space `doc_outline` reports its text
lines and field rectangles in). Only page content changes; the rest of the file is carried over."""

from __future__ import annotations

import io
import math
from typing import Any

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject

from .pdfform import (
    PdfFormError,
    _add_object,
    _check_shown,
    _pdf_text,
    _Reject,
    _text_width,
    open_reader,
    read_form,
)
from .pdflayout import page_segments

MAX_ITEMS = 300
MAX_TEXT = 500
DEFAULT_SIZE = 10.0
SIZE_RANGE = (4.0, 72.0)
FONTS = {"helvetica": ("Helvetica", 1.0), "helvetica-bold": ("Helvetica-Bold", 1.08)}  # (base font, width factor)
_TAGS = {"Helvetica": "/CrPT1", "Helvetica-Bold": "/CrPT2"}


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return float(value)


def _plan(
    items: list[dict[str, Any]], boxes: list[Any], rotated: dict[int, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(valid items with their font, width and size settled, problems)"""
    plan: list[dict[str, Any]] = []
    problems: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        where = f"item {index}"

        def bad(
            message: str, item: dict[str, Any] = item, where: str = where, index: int = index, reason: str = ""
        ) -> None:
            problem = {"item": index, "value": item.get("text"), "message": f"{where}: {message}"}
            problems.append({**problem, "reason": reason} if reason else problem)

        page, text = item.get("page"), item.get("text")
        if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= len(boxes):
            bad(f"page must be a number from 1 to {len(boxes)}")
            continue
        along = item.get("along")
        angle = 0.0
        length: float | None = None
        if along is not None:
            if item.get("rotate") is not None or item.get("x") is not None or item.get("y") is not None:
                bad("along gives the start and the direction: leave out x, y and rotate")
                continue
            values = [_number(v) for v in along] if isinstance(along, list) and len(along) == 4 else []
            if len(values) != 4 or any(v is None for v in values):
                bad("along is [x1, y1, x2, y2]: four numbers, PDF points from the page's bottom left")
                continue
            x, y = values[0], values[1]
            dx, dy = values[2] - values[0], values[3] - values[1]  # type: ignore[operator]
            length = math.hypot(dx, dy)
            if length < 1.0:
                bad("along must run for at least 1 point")
                continue
            angle = math.degrees(math.atan2(dy, dx))
        else:
            x, y = _number(item.get("x")), _number(item.get("y"))
            if x is None or y is None:
                bad("x and y must be numbers (PDF points from the page's bottom left)")
                continue
            if item.get("rotate") is not None:
                turn = _number(item.get("rotate"))
                if turn is None:
                    bad("rotate is a number of degrees, counter-clockwise")
                    continue
                angle = ((turn + 180.0) % 360.0) - 180.0
        if not isinstance(text, str) or not text.strip():
            bad("text must be a non-empty string")
            continue
        if len(text) > MAX_TEXT or "\n" in text or "\r" in text:
            bad(f"text is one line of at most {MAX_TEXT} characters; place a line per item")
            continue
        size = _number(item.get("size")) if item.get("size") is not None else DEFAULT_SIZE
        if size is None or not SIZE_RANGE[0] <= size <= SIZE_RANGE[1]:
            bad(f"size must be a number from {SIZE_RANGE[0]:g} to {SIZE_RANGE[1]:g}")
            continue
        font_key = str(item.get("font") or "helvetica").lower()
        if font_key not in FONTS:
            bad(f'font must be "Helvetica" or "Helvetica-Bold", not "{item.get("font")}"')
            continue
        try:
            _check_shown(text)
        except _Reject as exc:
            bad(exc.message)
            continue
        base, factor = FONTS[font_key]
        width = _text_width(text, size) * factor
        if item.get("fit") and length is not None and width > length:
            # shrunk to the segment, down to the floor the form fill uses; what still does not fit is refused
            size = max(min(size, size * length / width), FIT_FLOOR)
            width = _text_width(text, size) * factor
            if width > length + 0.01:
                bad(f"the text does not fit the {length:.0f} point line even at {FIT_FLOOR:g} pt: shorten it")
                continue
        if page in rotated and not _near_a_line(rotated[page](), x, y, size):
            bad(
                f"page {page} is rotated, and x and y are in the page's own unrotated space, which the picture does "
                "not show: place text only next to a text line that doc_outline lists on this page (within "
                f"{ROTATED_REACH:g} points of it)",
                reason="rotated_page",
            )
            continue
        left, bottom, right, top = boxes[page - 1]
        if abs(angle) < 1e-9:
            xs, ys = [x, x + width], [y, y + size * 0.8]
        else:  # the corners of the text's box (baseline to cap height), turned about its start
            cos, sin = math.cos(math.radians(angle)), math.sin(math.radians(angle))
            corners = [(0.0, 0.0), (width, 0.0), (width, size * 0.8), (0.0, size * 0.8)]
            xs = [x + u * cos - v * sin for u, v in corners]
            ys = [y + u * sin + v * cos for u, v in corners]
        if min(xs) < left - 0.01 or max(xs) > right + 0.01 or min(ys) < bottom - 0.01 or max(ys) > top + 0.01:
            turned = f" (turned {angle:.1f} degrees)" if abs(angle) >= 1e-9 else ""
            bad(
                f"the text would leave the page{turned}: it spans x {min(xs):.1f} to {max(xs):.1f} and y "
                f"{min(ys):.1f} to {max(ys):.1f} on a page of {right - left:.1f} x {top - bottom:.1f} points "
                "(origin bottom left)"
            )
            continue
        plan.append(
            {"page": page, "x": x, "y": y, "text": text, "size": size, "font": base, "w": width, "angle": angle}
        )
    return plan, problems


ROTATED_REACH = 30.0
FIT_FLOOR = 6.0  # `fit` shrinks text to its line down to this size, like the form fill


def _near_a_line(segs: list[Any], x: float, y: float, size: float) -> bool:
    """The point is within ROTATED_REACH of a text segment's box."""
    for s in segs:
        dx = max(s.x0 - x, 0.0, x - s.x1)
        dy = max(s.y - 0.3 * s.size - y, 0.0, y - (s.y + s.size))
        if dx * dx + dy * dy <= ROTATED_REACH**2:
            return True
    return False


def _overlay(writer: PdfWriter, page: Any, ops: bytes, fonts: set[str]) -> None:
    resources = page.get("/Resources")
    resources = resources.get_object() if resources is not None else page.get_inherited("/Resources")
    resources = DictionaryObject(resources) if resources is not None else DictionaryObject()
    page[NameObject("/Resources")] = resources
    table = resources.get("/Font")
    table = DictionaryObject(table.get_object()) if table is not None else DictionaryObject()
    resources[NameObject("/Font")] = table
    for base in fonts:
        table[NameObject(_TAGS[base])] = _add_object(
            writer,
            DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Font"),
                    NameObject("/Subtype"): NameObject("/Type1"),
                    NameObject("/BaseFont"): NameObject("/" + base),
                    NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
                }
            ),
        )
    before, after = DecodedStreamObject(), DecodedStreamObject()
    before.set_data(b"q\n")  # the page's own drawing cannot leave a state behind that moves or hides the overlay
    after.set_data(b"Q\n" + ops)
    current = page.raw_get("/Contents") if "/Contents" in page else ArrayObject()
    current_obj = current.get_object()
    parts = list(current_obj) if isinstance(current_obj, ArrayObject) else [current]
    page[NameObject("/Contents")] = ArrayObject([_add_object(writer, before), *parts, _add_object(writer, after)])


def place_text(
    data: bytes, items: list[dict[str, Any]], *, allow_on_form: bool = False, max_fields: int = 5000
) -> tuple[bytes, dict[str, Any]]:
    """Draw each item's text at its position. Returns (the new PDF, a report with `placed`, `not_found` and
    the page count). A refusal raises PdfFormError and nothing is written."""
    from .pdflayout import _fragments

    reader = open_reader(data)
    form = read_form(reader.trailer["/Root"], reader.pages, max_fields=max_fields)
    if form.signed:
        raise PdfFormError(
            "this PDF carries a digital signature: drawing on it would invalidate the signature, so it was not changed",
            reason="signed",
        )
    fields = [f for f in form.fields.values() if f.kind and f.kind != "signature"]
    if fields and not allow_on_form:
        raise PdfFormError(
            f"this PDF has {len(fields)} form field{'s' if len(fields) != 1 else ''}: fill them with fill_form "
            "(doc_outline lists them with their positions and labels). place_text is for a PDF without fields; "
            "pass allow_on_form: true only to add text the fields do not cover",
            reason="has_form",
        )
    if not items:
        raise PdfFormError("give at least one item to place", reason="no_values")
    if len(items) > MAX_ITEMS:
        raise PdfFormError(f"{len(items)} items is more than the {MAX_ITEMS} one call takes", reason="too_many_items")
    boxes = []
    rotated: dict[int, Any] = {}
    for number, page in enumerate(reader.pages, start=1):
        box = page.cropbox  # what a viewer shows; the media box when there is no crop
        boxes.append((float(box.left), float(box.bottom), float(box.right), float(box.top)))
        if int(page.rotation) % 360:
            rotated[number] = lambda page=page: page_segments(page)
    plan, problems = _plan(items, boxes, rotated)
    if problems:
        lines = "; ".join(p["message"] for p in problems[:6])
        more = f" (and {len(problems) - 6} more)" if len(problems) > 6 else ""
        raise PdfFormError(
            f"{len(problems)} item{'s were' if len(problems) != 1 else ' was'} not acceptable and nothing was "
            f"written: {lines}{more}",
            reason="values",
            problems=problems,
        )

    writer = PdfWriter(clone_from=io.BytesIO(data))
    by_page: dict[int, list[dict[str, Any]]] = {}
    for entry in plan:
        by_page.setdefault(entry["page"], []).append(entry)
    for number, entries in by_page.items():
        ops = b""
        fonts: set[str] = set()
        for e in entries:
            fonts.add(e["font"])
            if abs(e["angle"]) < 1e-9:
                place = f"{e['x']:.2f} {e['y']:.2f} Td"
            else:
                c, s_ = math.cos(math.radians(e["angle"])), math.sin(math.radians(e["angle"]))
                place = f"{c:.6f} {s_:.6f} {-s_:.6f} {c:.6f} {e['x']:.2f} {e['y']:.2f} Tm"
            ops += (
                f"BT\n{_TAGS[e['font']]} {e['size']:.2f} Tf 0 g\n{place}\n".encode()
                + _pdf_text(e["text"].replace("\t", " "))
                + b" Tj\nET\n"
            )
        _overlay(writer, writer.pages[number - 1], ops, fonts)
    out = io.BytesIO()
    writer.write(out)
    result = out.getvalue()

    # read the text back from the written file: each item must be there, where it was put
    check = open_reader(result)
    seen: dict[int, list[Any]] = {n: _fragments(check.pages[n - 1]) for n in by_page}
    placed: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for e in plan:
        want = " ".join(e["text"].split())
        found = any(
            abs(f.x0 - e["x"]) <= 1.5 and abs(f.y - e["y"]) <= 1.5 and " ".join(f.raw.split()) == want
            for f in seen[e["page"]]
        )
        row = {
            "page": e["page"],
            "x": round(e["x"], 1),
            "y": round(e["y"], 1),
            "w": round(e["w"], 1),
            "size": e["size"],
            "text": e["text"],
            **({"angle": round(e["angle"], 2)} if abs(e["angle"]) >= 1e-9 else {}),
        }
        (placed if found else missing).append(row)
    return result, {
        "pages": len(reader.pages),
        "placed": placed,
        "not_found": missing,
        "on_form": bool(fields),
    }
