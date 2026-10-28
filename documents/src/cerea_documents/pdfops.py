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
            "description": "Bake the values into the pages; the form is no longer editable.",
        },
    },
    "required": ["op", "values"],
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
        box = page.mediabox
        entry: dict[str, Any] = {
            "page": number,
            "width_pt": round(float(box.width), 1),
            "height_pt": round(float(box.height), 1),
        }
        if page.get("/Rotate"):
            entry["rotation"] = int(page["/Rotate"])
        out.append(entry)
    return out


def outline(data: bytes, limits: Limits) -> dict[str, Any]:
    from .pdfform import PdfFormError, inspect_reader

    reader = _open(data, limits)
    try:
        form = inspect_reader(reader, max_fields=limits.max_pdf_fields)
    except PdfFormError as exc:
        raise _raise(exc) from exc
    pages = len(reader.pages)
    out: dict[str, Any] = {
        "page_count": pages,
        "pages": _page_sizes(reader),
        "form": form,
        "operations": ["fill_form"] if form["has_form"] and not form["xfa"] else [],
    }
    if pages > MAX_PAGES_LISTED:
        out["pages_truncated"] = pages - MAX_PAGES_LISTED
    return out


def _fill(data: bytes, op: dict[str, Any], limits: Limits) -> tuple[dict[str, Any], bytes]:
    """(report, new bytes)"""
    from .pdfform import PdfFormError, fill_pdf_form

    try:
        out, report = fill_pdf_form(data, op["values"], bool(op.get("flatten")), max_fields=limits.max_pdf_fields)
    except PdfFormError as exc:
        raise _raise(exc) from exc
    return report, out


OPS: dict[str, tuple[dict[str, Any], Callable[..., Any]]] = {"fill_form": (FILL_FORM_SCHEMA, _fill)}


def edit(data: bytes, body: dict[str, Any], limits: Limits) -> tuple[dict[str, Any], bytes]:
    """Apply the one operation. `body` has been validated against the envelope and the operation's schema."""
    ops = body["operations"]
    if len(ops) != 1:
        raise PatchError(
            "a PDF takes exactly one operation per call: fill_form",
            reason="one_operation",
            details={"operations": len(ops)},
        )
    _open(data, limits)  # the page limit and the cheap refusals, before the form is walked
    op = ops[0]
    try:
        report, out = _fill(data, op, limits)
    except PatchError as exc:
        exc.operation_index = 0
        exc.message = f"operation 0 (fill_form): {exc.message}"
        exc.args = (exc.message,)
        exc.details = {**exc.details, "operation": "fill_form", "applied_before_failure": 0, "nothing_written": True}
        raise
    problems = [f'field "{r["field"]}": wanted {r["value"]!r}, found {r["found"]!r}' for r in report["rejected"]]
    skipped = report["skipped"]
    result = {
        "filled": report["filled"],
        "rejected": report["rejected"],
        "skipped": skipped[:MAX_SKIPPED_LISTED],
        "skipped_count": len(skipped),
        "flattened": report["flattened"],
    }
    return {
        "format": "pdf",
        "engine": ENGINE,
        "operations": [{"index": 0, "op": "fill_form", "result": result}],
        "diff": report["diff"],
        "verify": {
            "ok": not problems,
            "pages": report["pages"],
            "fields_checked": len(report["filled"]) + len(report["rejected"]),
            "filled": len(report["filled"]),
            "not_taken": report["rejected"],
            "problems": problems,
            "flattened": report["flattened"],
            "reopened_with": "pypdf",
        },
        "passed_through": [],
    }, out
