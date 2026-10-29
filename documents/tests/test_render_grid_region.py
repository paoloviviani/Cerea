"""look_doc's `grid` and `region`: ticks in PDF points over the picture, and a zoomed area of the page."""

from __future__ import annotations

import base64
import io
from typing import Any

import pytest
from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from cerea_documents.config import Limits
from cerea_documents.errors import InvalidRequest
from cerea_documents.render import render_pages

LIMITS = Limits()


def pdf_with_box() -> bytes:
    """A4 with a black square from (200, 300) to (260, 360) points, and nothing else."""
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    pdf.rect(200, 300, 60, 60, fill=1, stroke=0)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def draw(data: bytes, **body: Any) -> tuple[dict[str, Any], Image.Image]:
    item = render_pages(data, {"pages": [1], "width_px": 595, **body}, LIMITS)["images"][0]
    return item, Image.open(io.BytesIO(base64.b64decode(item["data_base64"]))).convert("RGB")


def test_the_default_picture_is_unchanged() -> None:
    item, image = draw(pdf_with_box())
    assert "grid_step_pt" not in item and "region" not in item
    assert image.size == (595, 842)
    assert image.getpixel((10, 10)) == (255, 255, 255)  # no overlay


def test_the_grid_draws_lines_every_50_points_and_leaves_the_page_where_it_was() -> None:
    plain = draw(pdf_with_box())[1]
    item, gridded = draw(pdf_with_box(), grid=True)
    assert item["grid_step_pt"] == 50 and gridded.size == plain.size
    # x = 100 pt is the pixel column 100 (1 px per point), from the top: a bluish line over white paper
    r, _g, b = gridded.getpixel((100, 600))
    assert b > r + 20 and r < 250
    assert gridded.getpixel((125, 600)) == (255, 255, 255)  # between two lines: untouched
    # y = 300 pt is 842 - 300 = 542 px from the top: also a line
    r, _g, b = gridded.getpixel((300, 542))
    assert b > r + 20
    # the black square (200..260 x, 300..360 y) is still where the page has it
    assert gridded.getpixel((230, 842 - 330))[0] < 40


def test_a_region_is_drawn_larger_and_says_which_area_it_is() -> None:
    item, image = draw(pdf_with_box(), region={"x": 190, "y": 290, "width": 80, "height": 80})
    assert item["region"] == {"x": 190, "y": 290, "width": 80, "height": 80}
    assert abs(image.width - 595) <= 2 and abs(image.height - 595) <= 2  # 80 pt across about 595 px
    scale = 595 / 80
    # the square starts 10 pt in from the region's left and bottom edges, and is 60 pt wide
    inside = image.getpixel((round((10 + 30) * scale), round((80 - 10 - 30) * scale)))
    outside = image.getpixel((round(5 * scale), round(5 * scale)))
    assert inside[0] < 40 and outside == (255, 255, 255)


def test_a_small_region_gets_a_finer_grid_and_a_region_outside_the_page_is_refused() -> None:
    item, _ = draw(pdf_with_box(), region={"x": 190, "y": 290, "width": 80, "height": 80}, grid=True)
    assert item["grid_step_pt"] == 10
    with pytest.raises(InvalidRequest):
        draw(pdf_with_box(), region={"x": 2000, "y": 2000, "width": 50, "height": 50})
    with pytest.raises(InvalidRequest):
        draw(pdf_with_box(), region={"x": 1, "y": 1})
