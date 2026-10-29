"""PDF in the document tools: `doc_outline` lists the pages and the form fields, `doc_edit` has one operation,
`fill_form`. A PDF has no other edit operations and no `doc_read`. The form logic itself is `pdfform.py`."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from . import ENGINE
from .config import Limits
from .errors import DocumentError, InvalidDocument, PatchError, UnsafeDocument

if TYPE_CHECKING:
    from .pdfform import PdfFormError

# pypdf is imported by the functions that need it, not here: every worker imports `core`, and a worker that
# does not touch a PDF must not pay for the library (its memory cap is tight for charts and large files).
CAN_READ = False
DEFERRED: list[str] = []
MAX_PAGES_LISTED = 200
MAX_SKIPPED_LISTED = 100
FLATTENED_SUFFIX = "-flattened"

FILL_FORM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "op": {"type": "string"},
        "values": {
            "type": "object",
            "minProperties": 1,
            "description": "Field name (as doc_outline lists it) to value: text, true/false or the on-state for a "
            "checkbox, an option for a radio group, an option's value or label for a list or combo box.",
            "additionalProperties": {
                "anyOf": [
                    {"type": "string"},
                    {"type": "number"},
                    {"type": "boolean"},
                    {"type": "null"},
                    {"type": "array", "items": {"type": "string"}},
                ]
            },
        },
        "flatten": {
            "type": "boolean",
            "description": "Bake the values into the pages (the form is no longer editable). Saved as a new file, "
            "<name>-flattened.pdf; the fillable file is left as it is.",
        },
        "flatten_in_place": {
            "type": "boolean",
            "description": "With flatten: replace the fillable file by the flattened one (a new version of the same "
            "file) instead of writing <name>-flattened.pdf. Only when the user asked for that.",
        },
    },
    "required": ["op", "values"],
    "additionalProperties": False,
}

PLACE_TEXT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "op": {"type": "string"},
        "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 300,
            "description": "Text to draw, one line per item. page is 1-based; x and y are PDF points from the page's "
            "bottom left, where the text starts on its baseline (doc_outline gives the lines' positions). Text runs "
            "horizontally unless an item says `rotate` (degrees, counter-clockwise) or `along` ([x1, y1, x2, y2]: the "
            "baseline starts at (x1, y1) and runs toward (x2, y2), for a line that is not level, such as a scanned page).",
            "items": {
                "type": "object",
                "properties": {
                    "page": {"type": "integer", "minimum": 1},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "text": {"type": "string", "minLength": 1},
                    "size": {"type": "number", "description": "Points, 4 to 72; default 10."},
                    "font": {"type": "string", "description": '"Helvetica" (default) or "Helvetica-Bold".'},
                    "rotate": {
                        "type": "number",
                        "description": "Turn the text this many degrees counter-clockwise about (x, y).",
                    },
                    "along": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 4,
                        "maxItems": 4,
                        "description": "[x1, y1, x2, y2]: instead of x, y and rotate. The text starts at (x1, y1) and "
                        "follows the line toward (x2, y2).",
                    },
                    "fit": {
                        "type": "boolean",
                        "description": "With along: shrink the text (down to 6 pt) to fit the line's length.",
                    },
                },
                "required": ["page", "text"],
                "additionalProperties": False,
            },
        },
        "allow_on_form": {
            "type": "boolean",
            "description": "A PDF that has form fields is refused (use fill_form); true allows text on it anyway.",
        },
    },
    "required": ["op", "items"],
    "additionalProperties": False,
}


def _raise(exc: PdfFormError) -> DocumentError:
    """The service's own error for a refusal of the form code."""
    details = {"problems": exc.problems} if exc.problems else {}
    if exc.reason in ("not_a_pdf", "damaged", "encrypted"):
        return InvalidDocument(exc.message, reason=exc.reason)
    if exc.reason in ("too_many_fields", "form_structure"):
        return UnsafeDocument(exc.message, reason=exc.reason)
    return PatchError(exc.message, reason=exc.reason, details=details)


def _open(data: bytes, limits: Limits) -> Any:
    from .pdfform import PdfFormError, open_reader

    try:
        reader = open_reader(data)
        pages = len(reader.pages)
    except PdfFormError as exc:
        raise _raise(exc) from exc
    if pages > limits.max_pdf_pages:
        raise UnsafeDocument(
            f"the PDF has {pages} pages; the limit is {limits.max_pdf_pages}",
            reason="too_many_pages",
            details={"pages": pages, "limit": limits.max_pdf_pages},
        )
    return reader


def _page_sizes(reader: Any) -> list[dict[str, Any]]:
    out = []
    for number, page in enumerate(reader.pages, start=1):
        if number > MAX_PAGES_LISTED:
            break
        box = page.cropbox  # the page as a viewer shows it (the media box when there is no crop)
        entry: dict[str, Any] = {
            "page": number,
            "width_pt": round(float(box.width), 1),
            "height_pt": round(float(box.height), 1),
        }
        if round(float(box.left), 1) or round(float(box.bottom), 1):
            # positions are in the page's own space: this is where the visible area starts in it
            entry["origin_x"] = round(float(box.left), 1)
            entry["origin_y"] = round(float(box.bottom), 1)
        if page.get("/Rotate"):
            entry["rotation"] = int(page["/Rotate"])
        out.append(entry)
    return out


FLAT_NOTE = (
    "this PDF has no form fields: the blanks (if any) are only drawn on the page. Write onto it with "
    "doc_edit place_text, using the text lines (`lines`, with x, y and width) listed on each page to put values "
    "next to their labels; look at the page with look_doc first and after. A scanned page (an image and no text) "
    "also lists `skew_deg` (the tilt, counter-clockwise) and `rules` (the lines to write on, each x1, y1 to x2, y2): "
    "write along a rule with place_text `along`, never by estimating positions from the picture"
)


def _operations(form: dict[str, Any]) -> list[str]:
    if form["xfa"] or form.get("signed"):
        return ["fill_form"] if form["has_form"] and not form["xfa"] else []
    return ["fill_form"] if form["has_form"] else ["place_text"]


def _read_scans(reader: Any, sizes: list[dict[str, Any]]) -> None:
    """A page with no text whose content is one image (a scan): its tilt and the rules to write on. Never fails."""
    try:
        from .pdfscan import analyse

        empty = [e["page"] for e in sizes if "lines" in e and not e["lines"]]
        for number, found in analyse(reader, empty).items():
            sizes[number - 1].update(found)
    except Exception:
        return


def outline(data: bytes, limits: Limits) -> dict[str, Any]:
    from .pdfform import PdfFormError, inspect_reader

    reader = _open(data, limits)
    try:
        form = inspect_reader(reader, max_fields=limits.max_pdf_fields)
    except PdfFormError as exc:
        raise _raise(exc) from exc
    from .pdflayout import Layout, annotate, text_lines

    pages = len(reader.pages)
    layout = Layout(reader)  # each page's text is read once, for the lines and for the labels
    lines = text_lines(layout)
    if form["fields"]:
        annotate(layout, form)
    elif not form["xfa"] and not form.get("signed"):
        form["note"] = FLAT_NOTE
    sizes = _page_sizes(reader)
    for entry in sizes:
        rows = lines.get(entry["page"])
        if rows is not None:
            entry["lines"] = rows
    if not form["fields"] and not form["xfa"]:
        _read_scans(reader, sizes)
    out: dict[str, Any] = {
        "page_count": pages,
        "pages": sizes,
        "form": form,
        "operations": _operations(form),
    }
    if pages > MAX_PAGES_LISTED:
        out["pages_truncated"] = pages - MAX_PAGES_LISTED
    return out


def _fill(data: bytes, op: dict[str, Any], limits: Limits) -> tuple[dict[str, Any], bytes]:
    """(result, new bytes)"""
    from .pdfform import PdfFormError, fill_pdf_form

    try:
        out, report = fill_pdf_form(data, op["values"], bool(op.get("flatten")), max_fields=limits.max_pdf_fields)
    except PdfFormError as exc:
        raise _raise(exc) from exc
    skipped = report["skipped"]
    flattened = report["flattened"]
    result = {
        "filled": report["filled"],
        "rejected": report["rejected"],
        "skipped": skipped[:MAX_SKIPPED_LISTED],
        "skipped_count": len(skipped),
        "flattened": flattened,
        "required_missing": report["required_missing"],
        "clipped": report["clipped"],
    }
    if flattened and not op.get("flatten_in_place"):
        # the chat saves it beside the fillable file, which stays as it was
        result["save_as_suffix"] = FLATTENED_SUFFIX
    problems = [f'field "{r["field"]}": wanted {r["value"]!r}, found {r["found"]!r}' for r in report["rejected"]]
    problems += [
        f'field "{n}": the text does not fit the box even at the smallest size, so it is cut off'
        for n in report["clipped"]
    ]
    verify = {
        "ok": not problems,
        "pages": report["pages"],
        "fields_checked": len(report["filled"]) + len(report["rejected"]),
        "filled": len(report["filled"]),
        "not_taken": report["rejected"],
        "problems": problems,
        "flattened": flattened,
        "reopened_with": "pypdf",
    }
    return {"result": result, "diff": report["diff"], "verify": verify}, out


def _place(data: bytes, op: dict[str, Any], limits: Limits) -> tuple[dict[str, Any], bytes]:
    from .pdfform import PdfFormError
    from .pdfplace import place_text

    try:
        out, report = place_text(
            data, op["items"], allow_on_form=bool(op.get("allow_on_form")), max_fields=limits.max_pdf_fields
        )
    except PdfFormError as exc:
        raise _raise(exc) from exc
    problems = [
        f'page {r["page"]} ({r["x"]}, {r["y"]}): "{r["text"]}" was not found at its position after saving'
        for r in report["not_found"]
    ]
    diff = [f'p{r["page"]} ({r["x"]}, {r["y"]}): "{r["text"]}"' for r in report["placed"] + report["not_found"]]
    result = {"placed": report["placed"], "not_found": report["not_found"]}
    verify = {
        "ok": not problems,
        "pages": report["pages"],
        "items_checked": len(report["placed"]) + len(report["not_found"]),
        "found_at_position": len(report["placed"]),
        "problems": problems,
        "reopened_with": "pypdf",
    }
    return {"result": result, "diff": diff, "verify": verify}, out


OPS: dict[str, tuple[dict[str, Any], Callable[..., Any]]] = {
    "fill_form": (FILL_FORM_SCHEMA, _fill),
    "place_text": (PLACE_TEXT_SCHEMA, _place),
}


def edit(data: bytes, body: dict[str, Any], limits: Limits) -> tuple[dict[str, Any], bytes]:
    """Apply the one operation. `body` has been validated against the envelope and the operation's schema."""
    ops = body["operations"]
    if len(ops) != 1:
        raise PatchError(
            "a PDF takes exactly one operation per call: fill_form or place_text, not both and not several",
            reason="one_operation",
            details={"operations": len(ops)},
        )
    _open(data, limits)  # the page limit and the cheap refusals, before the form is walked
    op = ops[0]
    name = op["op"]
    try:
        done, out = OPS[name][1](data, op, limits)
    except PatchError as exc:
        exc.operation_index = 0
        exc.message = f"operation 0 ({name}): {exc.message}"
        exc.args = (exc.message,)
        exc.details = {**exc.details, "operation": name, "applied_before_failure": 0, "nothing_written": True}
        raise
    return {
        "format": "pdf",
        "engine": ENGINE,
        "operations": [{"index": 0, "op": name, "result": done["result"]}],
        "diff": done["diff"],
        "verify": done["verify"],
        "passed_through": [],
    }, out
