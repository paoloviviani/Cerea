"""fill_form chooses the font size from the field's box: the glyphs of a low field are not cut off at the top,
and a field too low for the smallest size is reported as clipped."""

from __future__ import annotations

import io
import re
from typing import Any

from pypdf import PdfReader
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from cerea_documents import core
from cerea_documents.config import Limits

LIMITS = Limits()


def make_pdf(font_size: int) -> bytes:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    for name, y, height in (("low", 700, 11), ("tall", 600, 24), ("tiny", 500, 6)):
        pdf.acroForm.textfield(
            name=name,
            x=50,
            y=y,
            width=120,
            height=height,
            fontSize=font_size,
            borderWidth=0,
            forceBorder=False,
            fieldFlags="",
        )
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def fill(data: bytes, values: dict[str, str]) -> tuple[dict[str, Any], bytes]:
    return core.edit(data, "pdf", {"operations": [{"op": "fill_form", "values": values}]}, {}, LIMITS)


def appearance(data: bytes, name: str) -> str:
    for annot in PdfReader(io.BytesIO(data)).pages[0]["/Annots"]:
        annot = annot.get_object()
        if annot.get("/T") == name:
            return annot["/AP"]["/N"].get_object().get_data().decode("latin-1")
    raise AssertionError(name)


def size_of(stream: str) -> float:
    return float(re.search(r"/Helv ([\d.]+) Tf", stream).group(1))  # type: ignore[union-attr]


def baseline_of(stream: str) -> float:
    return float(re.search(r"([\d.]+) ([\d.]+) Td", stream).group(2))  # type: ignore[union-attr]


def test_a_low_field_gets_a_smaller_font_and_nothing_is_clipped() -> None:
    result, data = fill(make_pdf(10), {"low": "27"})
    stream = appearance(data, "low")
    assert size_of(stream) < 10  # the field's own 10 pt would cut the glyph tops in an 11 pt box
    assert result["operations"][0]["result"]["clipped"] == []
    # The glyph box (digits reach 0.718 em) stays inside the clip window (box height less 2 x 2 pt).
    fs = size_of(stream)
    assert baseline_of(stream) >= 2 - 0.01
    assert baseline_of(stream) + 0.718 * fs <= 11 - 2 + 0.01


def test_a_field_that_fits_keeps_its_own_size() -> None:
    result, data = fill(make_pdf(10), {"tall": "27"})
    assert size_of(appearance(data, "tall")) == 10
    assert result["operations"][0]["result"]["clipped"] == []


def test_a_field_too_low_for_the_smallest_size_is_reported_clipped() -> None:
    result, data = fill(make_pdf(10), {"tiny": "27"})
    assert size_of(appearance(data, "tiny")) == 6
    assert result["operations"][0]["result"]["clipped"] == ["tiny"]
    assert "Helvetica" in str(
        PdfReader(io.BytesIO(data)).pages[0]["/Annots"][2].get_object()["/AP"]["/N"].get_object()["/Resources"]
    )


def test_an_empty_value_in_a_low_field_is_not_reported_clipped() -> None:
    result, _ = fill(make_pdf(10), {"tiny": "", "low": "27"})
    assert "tiny" not in result["operations"][0]["result"]["clipped"]
