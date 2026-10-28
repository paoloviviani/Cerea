"""Pages of a PDF as images (`look_doc`): PDFium through pypdfium2, run only inside a render job.

pypdfium2 is imported by `render_pages`, never at module level, and this module is imported only by the
worker's render branch: `core` (and so every edit, create and outline worker) never loads PDFium, because the
worker's memory cap is tight (it already bit pypdf).

Each page is drawn once at the requested size and stored as PNG or JPEG, whichever is smaller. Flat graphics
are usually smaller as PNG; anti-aliased text on a large page and photographs, as JPEG. The answer says which.
"""

from __future__ import annotations

import base64
import io
from typing import Any

from .config import Limits
from .errors import InvalidDocument, InvalidRequest, UnsafeDocument

JPEG_QUALITY = 80
_BODY_KEYS = {"pages", "width_px", "max_side_px"}


def _positive_int(body: dict[str, Any], key: str, maximum: int) -> int | None:
    value = body.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise InvalidRequest(f"{key} must be a whole number of at least 1", reason="schema")
    if value > maximum:
        raise InvalidRequest(f"{key} is {value}; the most this service draws is {maximum}", reason="too_large_image")
    return value


def check_body(body: dict[str, Any], limits: Limits) -> tuple[list[int] | None, int | None, int | None]:
    """(pages or None, width_px, max_side_px) from the request body, before any file is opened."""
    unknown = sorted(set(body) - _BODY_KEYS)
    if unknown:
        raise InvalidRequest(f"unknown field(s) in the render body: {unknown}", reason="schema")
    pages = body.get("pages")
    if pages is not None:
        if (
            not isinstance(pages, list)
            or not pages
            or not all(isinstance(p, int) and not isinstance(p, bool) for p in pages)
        ):
            raise InvalidRequest("pages must be a non-empty list of 1-based page numbers", reason="schema")
        if len(pages) > limits.max_render_pages:
            raise InvalidRequest(
                f"{len(pages)} pages asked for; at most {limits.max_render_pages} are drawn per call",
                reason="too_many_render_pages",
                details={"asked": len(pages), "limit": limits.max_render_pages},
            )
    width = _positive_int(body, "width_px", limits.max_render_px)
    side = _positive_int(body, "max_side_px", limits.max_render_px)
    if (width is None) == (side is None):
        raise InvalidRequest("send exactly one of width_px and max_side_px", reason="schema")
    return pages, width, side


def render_pages(data: bytes, body: dict[str, Any], limits: Limits) -> dict[str, Any]:
    pages, width_px, side_px = check_body(body, limits)
    if b"%PDF-" not in data[:1024]:
        raise InvalidDocument("the file is not a PDF", reason="not_a_pdf")

    import pypdfium2 as pdfium
    from pypdfium2 import PdfiumError

    try:
        pdf = pdfium.PdfDocument(data)
    except PdfiumError as exc:
        if "password" in str(exc).lower():
            raise InvalidDocument(
                "the PDF is encrypted (password-protected), which this tool cannot open; remove the protection first",
                reason="encrypted",
            ) from exc
        raise InvalidDocument(f"the PDF cannot be read ({str(exc)[:160]})", reason="damaged") from exc
    try:
        count = len(pdf)
        if count < 1:
            raise InvalidDocument("the PDF has no pages", reason="damaged")
        if count > limits.max_pdf_pages:
            raise UnsafeDocument(
                f"the PDF has {count} pages; the limit is {limits.max_pdf_pages}",
                reason="too_many_pages",
                details={"pages": count, "limit": limits.max_pdf_pages},
            )
        wanted = pages if pages is not None else list(range(1, min(count, limits.max_render_pages) + 1))
        bad = [p for p in wanted if p < 1 or p > count]
        if bad:
            raise InvalidRequest(
                f"the document has {count} page{'s' if count != 1 else ''}; page {bad[0]} does not exist",
                reason="page_out_of_range",
                details={"page_count": count, "pages": bad},
            )
        images = [_draw(pdf, p, width_px, side_px, limits.max_render_px) for p in dict.fromkeys(wanted)]
    finally:
        pdf.close()
    return {"format": "pdf", "page_count": count, "images": images}


def _draw(pdf: Any, number: int, width_px: int | None, side_px: int | None, ceiling: int) -> dict[str, Any]:
    page = pdf[number - 1]
    try:
        w_pt, h_pt = page.get_size()  # the page as shown: rotation is applied
        if w_pt <= 0 or h_pt <= 0:
            raise InvalidDocument(f"page {number} has no size", reason="damaged")
        scale = (width_px / w_pt) if width_px is not None else (side_px or ceiling) / max(w_pt, h_pt)
        scale = min(scale, ceiling / max(w_pt, h_pt))  # a very tall or wide page never makes a huge bitmap
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil().convert("RGB")
    finally:
        page.close()
    png = io.BytesIO()
    image.save(png, format="PNG", optimize=True)
    jpg = io.BytesIO()
    image.save(jpg, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    if len(png.getvalue()) <= len(jpg.getvalue()):
        fmt, content_type, raw = "png", "image/png", png.getvalue()
    else:
        fmt, content_type, raw = "jpeg", "image/jpeg", jpg.getvalue()
    return {
        "page": number,
        "width": image.width,
        "height": image.height,
        "format": fmt,
        "content_type": content_type,
        "data_base64": base64.b64encode(raw).decode("ascii"),
    }
