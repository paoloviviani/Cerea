"""doc_outline on a scanned page: the tilt and the rules to write on, read from the image alone."""

from __future__ import annotations

import io
import math
from typing import Any

import pytest
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from cerea_documents import core
from cerea_documents.config import Limits

LIMITS = Limits()
W, H = 1240, 1754  # A4 at 150 dpi
TILT = 1.1
# (x1, x2, y) of the printed lines, in the straight (unscanned) image; the labels are above their lines
LINES = [(420, 1100, 400), (420, 1100, 520), (300, 640, 700), (760, 1100, 700), (420, 1100, 900)]


def scan(tilt: float = TILT, dotted: bool = False) -> tuple[bytes, Image.Image]:
    image = Image.new("L", (W, H), 255)
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=26)
    for i, (x1, x2, y) in enumerate(LINES):
        if dotted and i == 1:
            for x in range(x1, x2, 9):
                draw.rectangle([x, y - 1, x + 2, y + 1], fill=0)
        else:
            draw.line([(x1, y), (x2, y)], fill=0, width=2)
        draw.text((60, y - 34), f"Campo numero {i}", fill=0, font=font)
    # a printed word sitting on the first line splits it
    draw.text((700, 400 - 25), "ROSSI", fill=0, font=font)
    turned = image.rotate(tilt, resample=Image.Resampling.BILINEAR, fillcolor=255)
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    pdf.drawImage(ImageReader(turned), 0, 0, width=A4[0], height=A4[1])
    pdf.showPage()
    pdf.save()
    return buffer.getvalue(), turned


def truth(x: float, y: float, tilt: float = TILT) -> tuple[float, float]:
    """Where a point of the straight image ends up on the page (points)."""
    phi = math.radians(tilt)
    u, v = x - W / 2, y - H / 2
    px = W / 2 + u * math.cos(phi) + v * math.sin(phi)
    py = H / 2 - u * math.sin(phi) + v * math.cos(phi)
    return px / W * A4[0], (1 - py / H) * A4[1]


def outline(data: bytes) -> dict[str, Any]:
    return core.outline(data, "pdf", LIMITS)


def rules_on(page: dict[str, Any], y_truth: float) -> list[dict[str, float]]:
    _, y_pt = truth(700, y_truth)
    return [r for r in page["rules"] if abs((r["y1"] + r["y2"]) / 2 - y_pt) < 12]


def test_a_scan_reports_its_tilt_and_the_rules_to_write_on() -> None:
    data, _ = scan()
    page = outline(data)["pages"][0]
    assert page["image_only"] is True
    assert page["skew_deg"] == pytest.approx(TILT, abs=0.2)
    # the whole line at y=520 is one rule, from its true start to its true end
    (rule,) = rules_on(page, 520)
    (x1, y1), (x2, y2) = truth(420, 520), truth(1100, 520)
    for got, want in ((rule["x1"], x1), (rule["y1"], y1), (rule["x2"], x2), (rule["y2"], y2)):
        assert got == pytest.approx(want, abs=2.0)
    # the two blanks on one row are two rules
    assert len(rules_on(page, 700)) == 2
    # the rules slope like the page does: along them is the tilt
    assert math.degrees(math.atan2(rule["y2"] - rule["y1"], rule["x2"] - rule["x1"])) == pytest.approx(TILT, abs=0.25)


def test_a_printed_word_on_a_line_splits_it() -> None:
    data, _ = scan()
    pieces = sorted(rules_on(outline(data)["pages"][0], 400), key=lambda r: r["x1"])
    assert len(pieces) == 2
    word_x = truth(700, 400)[0]
    assert pieces[0]["x2"] <= word_x + 6 and pieces[1]["x1"] >= word_x - 6


def test_a_dotted_line_is_one_rule() -> None:
    data, _ = scan(dotted=True)
    (rule,) = rules_on(outline(data)["pages"][0], 520)
    assert rule["x2"] - rule["x1"] == pytest.approx(truth(1100, 520)[0] - truth(420, 520)[0], abs=4.0)


def test_a_level_scan_and_a_negative_tilt() -> None:
    assert outline(scan(0.0)[0])["pages"][0]["skew_deg"] == pytest.approx(0.0, abs=0.2)
    assert outline(scan(-2.0)[0])["pages"][0]["skew_deg"] == pytest.approx(-2.0, abs=0.2)


def test_a_page_with_text_is_not_analysed_and_a_blank_scan_does_not_fail() -> None:
    from .pdf_fixtures import make_plain_pdf

    assert "skew_deg" not in outline(make_plain_pdf())["pages"][0]
    blank = Image.new("L", (W, H), 255)
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    pdf.drawImage(ImageReader(blank), 0, 0, width=A4[0], height=A4[1])
    pdf.showPage()
    pdf.save()
    page = outline(buffer.getvalue())["pages"][0]
    assert page.get("rules", []) == [] and "skew_deg" not in page


def _jpeg_page(declared: int, real: int) -> bytes:
    """A PDF whose one image declares `declared` pixels a side and carries a JPEG that is `real` a side."""
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject

    jpeg = io.BytesIO()
    Image.new("L", (real, real), 255).save(jpeg, format="JPEG", quality=30)
    writer = PdfWriter()
    page = writer.add_blank_page(A4[0], A4[1])
    image = DecodedStreamObject()
    image.set_data(jpeg.getvalue())
    image.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Image"),
            NameObject("/Width"): NumberObject(declared),
            NameObject("/Height"): NumberObject(declared),
            NameObject("/ColorSpace"): NameObject("/DeviceGray"),
            NameObject("/BitsPerComponent"): NumberObject(8),
            NameObject("/Filter"): NameObject("/DCTDecode"),
        }
    )
    ref = writer._add_object(image)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/XObject"): DictionaryObject({NameObject("/Im0"): ref})}
    )
    content = DecodedStreamObject()
    content.set_data(f"q {A4[0]} 0 0 {A4[1]} 0 0 cm /Im0 Do Q".encode())
    page[NameObject("/Contents")] = writer._add_object(content)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def test_an_image_larger_than_it_declares_is_not_decoded() -> None:
    import time

    started = time.monotonic()
    page = outline(_jpeg_page(1000, 8000))["pages"][0]  # 64 megapixels of data under a 1 megapixel header
    assert "image_only" not in page and "skew_deg" not in page
    assert time.monotonic() - started < 5
    assert Image.MAX_IMAGE_PIXELS != 36_000_000  # the limit is only held while decoding
