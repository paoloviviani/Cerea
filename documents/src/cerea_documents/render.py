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
import math
from typing import Any

from .config import Limits
from .errors import InvalidDocument, InvalidRequest, UnsafeDocument

JPEG_QUALITY = 80
MIN_SIDE_PX = 8  # a page whose short side would be drawn smaller than this is refused
_BODY_KEYS = {"pages", "width_px", "max_side_px", "grid", "region"}
GRID_STEP_PT = 50.0  # the spacing of the grid's lines, in PDF points
GRID_STEP_ZOOMED_PT = 10.0  # and inside a region narrower than ZOOMED_BELOW_PT
ZOOMED_BELOW_PT = 160.0


def _positive_int(body: dict[str, Any], key: str, maximum: int) -> int | None:
    value = body.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise InvalidRequest(f"{key} must be a whole number of at least 1", reason="schema")
    if value > maximum:
        raise InvalidRequest(f"{key} is {value}; the most this service draws is {maximum}", reason="too_large_image")
    return value


def _region(body: dict[str, Any]) -> tuple[float, float, float, float] | None:
    """(x, y, width, height) in PDF points from the body's `region`, or None; refuses what is not a real area."""
    value = body.get("region")
    if value is None:
        return None
    keys = ("x", "y", "width", "height")
    if not isinstance(value, dict) or set(value) != set(keys):
        raise InvalidRequest("region is {x, y, width, height} in PDF points", reason="schema")
    numbers = []
    for key in keys:
        n = value[key]
        if isinstance(n, bool) or not isinstance(n, int | float) or not math.isfinite(n):
            raise InvalidRequest(f"region.{key} must be a number", reason="schema")
        numbers.append(float(n))
    if numbers[2] < 4 or numbers[3] < 4:
        raise InvalidRequest("region.width and region.height must be at least 4 points", reason="schema")
    return numbers[0], numbers[1], numbers[2], numbers[3]


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
    if body.get("grid") is not None and not isinstance(body["grid"], bool):
        raise InvalidRequest("grid is true or false", reason="schema")
    _region(body)
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
        # before any page is loaded: without the form layer a filled form is drawn empty. This PDFium has neither
        # V8 nor XFA, so no document script runs. A form layer that will not start is not a damaged file: the
        # pages are drawn without it, from a fresh handle (the form env is tied to the first one)
        try:
            pdf.init_forms()
        except Exception:
            pdf.close()
            pdf = pdfium.PdfDocument(data)
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
        region, grid = _region(body), body.get("grid") is True
        images = [_draw(pdf, p, width_px, side_px, limits.max_render_px, region, grid) for p in dict.fromkeys(wanted)]
    finally:
        pdf.close()
    return {"format": "pdf", "page_count": count, "images": images}


def _draw(
    pdf: Any,
    number: int,
    width_px: int | None,
    side_px: int | None,
    ceiling: int,
    region: tuple[float, float, float, float] | None = None,
    grid: bool = False,
) -> dict[str, Any]:
    page = pdf[number - 1]
    origin: tuple[float, float, float, float] | None = None  # (left, top, x0, y0) of the drawn area, for the grid
    try:
        w_pt, h_pt = page.get_size()  # the page as shown: rotation is applied
        if w_pt <= 0 or h_pt <= 0:
            raise InvalidDocument(f"page {number} has no size", reason="damaged")
        crop = (0.0, 0.0, 0.0, 0.0)
        if region is not None or grid:
            if page.get_rotation() % 360:
                raise InvalidRequest(
                    f"page {number} is rotated: positions on it are in the page's own unrotated space, which a grid "
                    "or a region cannot show; look at the whole page without them",
                    reason="page_rotated",
                    details={"page": number},
                )
            left, bottom, right, top = page.get_cropbox()
            area = (left, bottom, right - left, top - bottom)
            if region is not None:
                rx, ry, rw, rh = region
                x0, y0 = max(rx, left), max(ry, bottom)
                x1, y1 = min(rx + rw, right), min(ry + rh, top)
                if x1 - x0 < 1 or y1 - y0 < 1:
                    raise InvalidRequest(
                        f"the region is outside page {number}, which spans x {left:g} to {right:g} and y {bottom:g} to {top:g}",
                        reason="region_outside",
                        details={"page": number},
                    )
                crop = (x0 - left, y0 - bottom, right - x1, top - y1)
                area = (x0, y0, x1 - x0, y1 - y0)
                w_pt, h_pt = area[2], area[3]
            origin = (area[0], area[1] + area[3], area[2], area[3])  # left, top, width, height of the area
        scale = (width_px / w_pt) if width_px is not None else (side_px or ceiling) / max(w_pt, h_pt)
        scale = min(scale, ceiling / max(w_pt, h_pt))  # a very tall or wide page never makes a huge bitmap
        smallest = min(w_pt, h_pt) * scale
        if smallest < MIN_SIDE_PX:  # a 14400 x 1 pt strip: a sliver of 0 or 1 px that shows nothing
            raise InvalidRequest(
                f"page {number} is {w_pt:.0f} x {h_pt:.0f} pt, which would be drawn only {smallest:.1f} px on its "
                f"short side at this size, too small to show anything",
                reason="page_too_small",
                details={"page": number, "width_pt": round(w_pt, 1), "height_pt": round(h_pt, 1)},
            )
        bitmap = page.render(scale=scale, may_draw_forms=True, crop=crop)
        image = bitmap.to_pil().convert("RGB")
    finally:
        page.close()
    if grid and origin is not None:
        image = _with_grid(image, origin, scale)
    png = io.BytesIO()
    image.save(png, format="PNG", optimize=True)
    jpg = io.BytesIO()
    image.save(jpg, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    if len(png.getvalue()) <= len(jpg.getvalue()):
        fmt, content_type, raw = "png", "image/png", png.getvalue()
    else:
        fmt, content_type, raw = "jpeg", "image/jpeg", jpg.getvalue()
    shown: dict[str, Any] = {}
    if region is not None and origin is not None:
        shown["region"] = {
            "x": round(origin[0], 1),
            "y": round(origin[1] - origin[3], 1),
            "width": round(origin[2], 1),
            "height": round(origin[3], 1),
        }
    if grid:
        shown["grid_step_pt"] = (
            GRID_STEP_ZOOMED_PT
            if region is not None and origin is not None and origin[2] < ZOOMED_BELOW_PT
            else GRID_STEP_PT
        )
    return {
        **shown,
        "page": number,
        "width": image.width,
        "height": image.height,
        "format": fmt,
        "content_type": content_type,
        "data_base64": base64.b64encode(raw).decode("ascii"),
    }


def _with_grid(image: Any, origin: tuple[float, float, float, float], scale: float) -> Any:
    """The picture with faint lines and labels at every grid step, in PDF points (origin at the page's bottom
    left, the space `place_text` and `doc_outline` use): x labels along the top, y labels along the left."""
    from PIL import Image, ImageDraw, ImageFont

    left, top, width, height = origin
    step = GRID_STEP_ZOOMED_PT if width < ZOOMED_BELOW_PT else GRID_STEP_PT
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    size = max(10, min(16, round(image.width / 90)))
    font = ImageFont.load_default(size=size)
    line, text = (30, 110, 220, 70), (20, 70, 180, 255)
    bottom = top - height
    x = math.ceil(left / step) * step
    while x <= left + width:
        px = round((x - left) * scale)
        draw.line([(px, 0), (px, image.height)], fill=line, width=1)
        draw.text((px + 2, 1), f"{x:g}", fill=text, font=font)
        x += step
    y = math.ceil(bottom / step) * step
    while y <= top:
        py = round((top - y) * scale)
        draw.line([(0, py), (image.width, py)], fill=line, width=1)
        draw.text((2, py + 1), f"{y:g}", fill=text, font=font)
        y += step
    return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
