"""PDF forms, round 2 (Cerea 0.32.4): a filled form is drawn by `look_doc`, text is fitted to narrow boxes, the
outline says where each field is and what it is for, text goes onto a PDF without fields, and a flatten is a copy.
The real-world file is the public ISEE form (`data/isee-prospetto-blank.pdf`: 41 fields named Testo104...)."""

from __future__ import annotations

import base64
import io
import json
import re
import time
from pathlib import Path
from typing import Any

import pytest
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, RectangleObject
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from cerea_documents import core
from cerea_documents.config import Limits
from cerea_documents.errors import PatchError
from cerea_documents.pdfform import _text_width
from cerea_documents.render import render_pages

from .pdf_fixtures import make_form_pdf

LIMITS = Limits()
ISEE = Path(__file__).parent / "data" / "isee-prospetto-blank.pdf"


def isee() -> bytes:
    return ISEE.read_bytes()


def edit(data: bytes, op: dict[str, Any]) -> tuple[dict[str, Any], bytes]:
    return core.edit(data, "pdf", {"operations": [op]}, {}, LIMITS)


def outline(data: bytes) -> dict[str, Any]:
    return core.outline(data, "pdf", LIMITS)


def fields_by_name(data: bytes) -> dict[str, dict[str, Any]]:
    return {f["name"]: f for f in outline(data)["form"]["fields"]}


def page_image(data: bytes, page: int = 1, width: int = 1190) -> Image.Image:
    item = render_pages(data, {"pages": [page], "width_px": width}, LIMITS)["images"][0]
    return Image.open(io.BytesIO(base64.b64decode(item["data_base64"]))).convert("L")


def dark_pixels(
    image: Image.Image, rect: dict[str, float], page_height: float, scale: float, inset: float = 2.0
) -> int:
    """Dark pixels inside a PDF rectangle (points, origin bottom left), borders left out."""
    x0, x1 = (rect["x"] + inset) * scale, (rect["x"] + rect["w"] - inset) * scale
    y0, y1 = (page_height - rect["y"] - rect["h"] + inset) * scale, (page_height - rect["y"] - inset) * scale
    crop = image.crop((int(x0), int(y0), int(x1), int(y1)))
    return sum(1 for p in crop.tobytes() if p < 110)


# 1 -- look_doc draws the form fields -----------------------------------------------------------------------


def test_a_filled_form_is_drawn_with_its_values() -> None:
    blank = make_form_pdf()
    _, filled = edit(blank, {"op": "fill_form", "values": {"full_name": "MMMMMMMMMMMM"}})
    rect = fields_by_name(blank)["full_name"]["rect"]
    height = float(PdfReader(io.BytesIO(blank)).pages[0].mediabox.height)
    before = dark_pixels(page_image(blank), rect, height, 2.0)
    after = dark_pixels(page_image(filled), rect, height, 2.0)
    assert before < 20 and after > 300, (before, after)  # the value is in the picture, not an empty box


def test_the_value_of_a_real_form_field_is_in_its_box() -> None:
    _, filled = edit(isee(), {"op": "fill_form", "values": {"Testo103": "A12345"}})
    rect = fields_by_name(isee())["Testo103"]["rect"]
    assert dark_pixels(page_image(isee()), rect, 841.92, 2.0) < 60  # the dotted line under it is not text
    assert dark_pixels(page_image(filled), rect, 841.92, 2.0) > 150


# 2 -- text is fitted to the box ----------------------------------------------------------------------------


def _drawn_size(widget_ap: bytes) -> float:
    found = re.search(rb"/Helv ([\d.]+) Tf", widget_ap)
    assert found
    return float(found.group(1))


@pytest.mark.parametrize("da", ["/Helv 12 Tf 0 g", "/Helv 0 Tf 0 g"])
def test_an_amount_wider_than_its_narrow_box_is_shrunk_to_fit(da: str) -> None:
    from pypdf import PdfWriter
    from pypdf.generic import NameObject, TextStringObject

    writer = PdfWriter(clone_from=io.BytesIO(isee()))
    for ref in writer.pages[0]["/Annots"]:
        if ref.get_object().get("/T") == "Testo129":
            ref.get_object()[NameObject("/DA")] = TextStringObject(da)
    buf = io.BytesIO()
    writer.write(buf)
    result, filled = edit(buf.getvalue(), {"op": "fill_form", "values": {"Testo129": "145.000,00"}})
    widget = next(
        a.get_object()
        for a in PdfReader(io.BytesIO(filled)).pages[0]["/Annots"]
        if a.get_object().get("/T") == "Testo129"
    )
    size = _drawn_size(widget["/AP"]["/N"].get_object().get_data())
    box = float(widget["/Rect"][2]) - float(widget["/Rect"][0])
    assert box < 53 and 6 <= size < 12
    assert _text_width("145.000,00", size) <= box - 4  # the glyph run is inside the box, borders included
    assert result["operations"][0]["result"]["clipped"] == []
    # and it is really drawn in full
    rect = fields_by_name(buf.getvalue())["Testo129"]["rect"]
    image = page_image(filled, width=2000)
    assert dark_pixels(image, rect, 841.92, 2000 / 595.32) > 100


def test_text_that_cannot_fit_even_at_the_smallest_size_is_reported_not_hidden() -> None:
    result, _ = edit(isee(), {"op": "fill_form", "values": {"Testo129": "145.000.000.000.000,00"}})
    assert result["operations"][0]["result"]["clipped"] == ["Testo129"]
    assert result["verify"]["ok"] is False and "cut off" in result["verify"]["problems"][0]


# 3 -- positions and labels in the outline ------------------------------------------------------------------


def test_every_field_of_the_isee_form_has_a_rect_in_points() -> None:
    fields = fields_by_name(isee())
    assert len(fields) == 40
    first = fields["Testo119"]["rect"]
    assert first["page"] == 1 and (round(first["x"]), round(first["y"])) == (59, 404)
    assert 195 < first["w"] < 200 and 12 < first["h"] < 14
    assert all(f["rect"]["w"] > 0 for f in fields.values())


def test_table_fields_know_their_row_and_column_and_the_column_header() -> None:
    fields = fields_by_name(isee())
    for rows, col, header in (
        (("Testo119", "Testo120", "Testo121"), 1, "Cognome e Nome"),
        (("Testo122", "Testo123", "Testo124"), 2, "Quote di Partecipazione"),
        (("Testo126", "Testo127", "Testo128"), 3, "Patrimonio Netto di Competenza"),
    ):
        for row, name in enumerate(rows, start=1):
            assert fields[name]["table"] == {"id": 1, "row": row, "col": col}, name
            assert fields[name]["label"] == header
    assert fields["Testo134"]["table"] == {"id": 2, "row": 1, "col": 1}
    tables = outline(isee())["form"]["tables"]
    assert [(t["id"], t["rows"], t["cols"]) for t in tables] == [(1, 3, 3), (2, 3, 3)]


def test_a_field_on_a_line_is_labelled_by_the_text_to_its_left() -> None:
    fields = fields_by_name(isee())
    assert fields["Testo103"]["label"] == "Codice Azienda"
    assert fields["Testo102"]["label"] == "CF o Partita Iva Società"
    assert "31 dicembre" in fields["Testo125"]["label"]
    assert fields["Testo104"]["label"] == "titolare della ditta individuale"
    assert "table" not in fields["Testo103"]


def test_a_field_without_text_beside_it_is_labelled_by_the_text_above() -> None:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.drawString(100, 700, "Notes for the office")
    c.acroForm.textfield(name="n1", x=100, y=660, width=200, height=20)
    c.save()
    assert fields_by_name(buf.getvalue())["n1"]["label"] == "Notes for the office"


def test_labels_are_capped() -> None:
    long = "word " * 60
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 4)
    c.drawString(20, 700, long)
    c.acroForm.textfield(name="n1", x=500, y=696, width=60, height=14)
    c.save()
    assert len(fields_by_name(buf.getvalue())["n1"]["label"]) <= 80


# 4 -- text lines in the outline, and place_text on a form without fields ------------------------------------


def make_fax_pdf() -> bytes:
    """A flat 'Fax cover sheet': labels with a drawn line after each, and a boxed message area."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(72, 780, "Fax cover sheet")
    c.setFont("Helvetica", 11)
    for i, label in enumerate(("To:", "From:", "Fax number:", "Date:", "Subject:")):
        y = 720 - i * 36
        c.drawString(72, y, label)
        c.line(150, y - 2, 420, y - 2)
    c.rect(72, 400, 350, 100)
    c.drawString(76, 488, "Message")
    c.save()
    return buf.getvalue()


def test_the_outline_lists_the_text_lines_with_positions_and_the_page_size() -> None:
    page = outline(make_fax_pdf())["pages"][0]
    assert (page["width_pt"], page["height_pt"]) == (595.3, 841.9)
    lines = {ln["text"]: ln for ln in page["lines"]}
    assert (lines["Fax number:"]["x"], lines["Fax number:"]["y"]) == (72.0, 648.0)
    assert 50 < lines["Fax number:"]["w"] < 70
    assert outline(make_form_pdf())["pages"][0]["lines"]


def test_the_text_lines_are_capped_per_page() -> None:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    for i in range(260):
        c.setFont("Helvetica", 3)
        c.drawString(20 + (i % 4) * 100, 830 - (i // 4) * 3.2, f"row {i}")
    c.save()
    assert len(outline(buf.getvalue())["pages"][0]["lines"]) == 200


def _place_next_to_labels(data: bytes) -> tuple[dict[str, Any], bytes]:
    lines = {ln["text"]: ln for ln in outline(data)["pages"][0]["lines"]}
    items = [
        {"page": 1, "x": lines[label]["x"] + lines[label]["w"] + 90, "y": lines[label]["y"] + 1, "text": text}
        for label, text in (
            ("To:", "Maria Rossi"),
            ("From:", "Paolo Viviani"),
            ("Date:", "28/10/2026"),
            ("Subject:", "Costi € 45.000,00"),
        )
    ]
    return edit(data, {"op": "place_text", "items": items})


def test_values_are_placed_next_to_labels_and_found_again() -> None:
    flat = make_fax_pdf()
    report, out = _place_next_to_labels(flat)
    assert report["verify"]["ok"] is True and report["verify"]["found_at_position"] == 4
    assert [p["text"] for p in report["operations"][0]["result"]["placed"]][-1] == "Costi € 45.000,00"
    text = PdfReader(io.BytesIO(out)).pages[0].extract_text()
    assert "Maria Rossi" in text and "Costi € 45.000,00" in text and "Fax cover sheet" in text
    # nothing else changed: the original content is still the first part of the page
    assert (
        PdfReader(io.BytesIO(out))
        .pages[0]
        .extract_text()
        .startswith(PdfReader(io.BytesIO(flat)).pages[0].extract_text()[:20])
    )


def test_placed_text_is_drawn_on_the_line_it_belongs_to() -> None:
    flat = make_fax_pdf()
    _, out = _place_next_to_labels(flat)
    lines = {ln["text"]: ln for ln in outline(flat)["pages"][0]["lines"]}
    before, after = page_image(flat), page_image(out)
    for label, filled in (("To:", True), ("From:", True), ("Fax number:", False), ("Date:", True)):
        y = lines[label]["y"]
        rect = {"x": 160, "y": y - 1, "w": 250, "h": 11}  # the stretch of line to the right of the label
        gained = dark_pixels(after, rect, 841.92, 2.0, inset=0) - dark_pixels(before, rect, 841.92, 2.0, inset=0)
        assert (gained > 60) is filled, (label, gained)


def test_place_text_refuses_what_it_cannot_draw_and_writes_nothing() -> None:
    flat = make_fax_pdf()

    def refused(items: list[dict[str, Any]]) -> str:
        with pytest.raises(PatchError) as info:
            edit(flat, {"op": "place_text", "items": items})
        assert info.value.details["nothing_written"] is True
        return str(info.value)

    assert "leave the page" in refused([{"page": 1, "x": 560, "y": 100, "text": "far too long for the margin"}])
    assert "leave the page" in refused([{"page": 1, "x": 10, "y": 900, "text": "above"}])
    assert "cannot show" in refused([{"page": 1, "x": 100, "y": 100, "text": "Привет"}])
    assert "page must be" in refused([{"page": 2, "x": 100, "y": 100, "text": "x"}])
    assert "size must be" in refused([{"page": 1, "x": 100, "y": 100, "text": "x", "size": 400}])


def test_place_text_on_a_pdf_with_fields_points_to_fill_form_unless_allowed() -> None:
    form = make_form_pdf()
    item = {"page": 1, "x": 72, "y": 500, "text": "Extra note"}
    with pytest.raises(PatchError, match="fill_form") as info:
        edit(form, {"op": "place_text", "items": [item]})
    assert info.value.reason == "has_form"
    report, out = edit(form, {"op": "place_text", "items": [item], "allow_on_form": True})
    assert report["verify"]["ok"] is True
    assert "Extra note" in PdfReader(io.BytesIO(out)).pages[0].extract_text()
    assert fields_by_name(out).keys() == fields_by_name(form).keys()  # the form is untouched


def test_place_text_and_fill_form_cannot_share_a_call() -> None:
    ops = [
        {"op": "fill_form", "values": {"full_name": "a"}},
        {"op": "place_text", "items": [{"page": 1, "x": 9, "y": 9, "text": "b"}]},
    ]
    with pytest.raises(PatchError, match="exactly one operation"):
        core.edit(make_form_pdf(), "pdf", {"operations": ops}, {}, LIMITS)


# 5 -- flatten is a copy ----------------------------------------------------------------------------------


def test_a_flatten_is_saved_as_a_new_file_unless_in_place_is_asked_for() -> None:
    values = {"full_name": "Ada Lovelace"}
    plain, _ = edit(make_form_pdf(), {"op": "fill_form", "values": values})
    assert "save_as_suffix" not in plain["operations"][0]["result"]
    copy, flat = edit(make_form_pdf(), {"op": "fill_form", "values": values, "flatten": True})
    assert copy["operations"][0]["result"]["save_as_suffix"] == "-flattened" and not fields_by_name_or_none(flat)
    inplace, _ = edit(make_form_pdf(), {"op": "fill_form", "values": values, "flatten": True, "flatten_in_place": True})
    assert "save_as_suffix" not in inplace["operations"][0]["result"]


def fields_by_name_or_none(data: bytes) -> dict[str, Any]:
    return fields_by_name(data)


# -- review round: budgets, flat outlines, crop and rotation, escaping, control characters ---------------------


def _dense(pages: int, rows: int, cols: int, lines: int) -> bytes:
    """Many small fields and many text lines (the review's probes)."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(600, 800))
    form = c.acroForm
    for p in range(pages):
        c.setFont("Helvetica", 6)
        for i in range(lines):
            c.drawString(10 + (i % 3) * 190, 790 - (i // 3) * 3.9, f"Label number {i} of page {p} ....")
        for r in range(rows):
            for k in range(cols):
                form.textfield(name=f"f{p}_{r}_{k}", x=20 + k * 9, y=780 - r * 9.5, width=8, height=8, borderWidth=0)
        c.showPage()
    c.save()
    return buf.getvalue()


def test_the_outline_of_a_page_with_thousands_of_fields_answers_in_time_with_every_field() -> None:
    data = _dense(1, 80, 60, 600)
    started = time.monotonic()
    out = outline(data)
    assert time.monotonic() - started < 10  # the worker is cut off at 20 s of CPU
    assert len(out["form"]["fields"]) == 4800 and out["form"]["tables"]
    assert all("rect" in f for f in out["form"]["fields"])


def test_the_outline_of_a_very_long_form_labels_the_first_pages_and_says_so() -> None:
    data = _dense(2000, 2, 1, 60)
    started = time.monotonic()
    out = outline(data)
    assert time.monotonic() - started < 10
    fields = out["form"]["fields"]
    assert len(fields) == 4000  # the list is complete
    assert "no label or table" in out["form"]["labels_note"]
    assert any("label" in f for f in fields[:80]) and not any("label" in f for f in fields[-80:])


def test_the_outline_is_the_same_bytes_twice() -> None:
    for data in (isee(), make_fax_pdf(), make_form_pdf()):
        assert json.dumps(outline(data), sort_keys=True) == json.dumps(outline(data), sort_keys=True)
    first = json.dumps(core.outline(isee(), "pdf", LIMITS))
    assert first == json.dumps(core.outline(isee(), "pdf", LIMITS))


def test_a_flat_pdfs_outline_offers_place_text_and_points_to_the_lines() -> None:
    out = outline(make_fax_pdf())
    assert out["operations"] == ["place_text"]
    assert "place_text" in out["form"]["note"] and "`lines`" in out["form"]["note"]
    assert outline(make_form_pdf())["operations"] == ["fill_form"]


def _fax_with(mutate: Any) -> bytes:
    writer = PdfWriter(clone_from=io.BytesIO(make_fax_pdf()))
    mutate(writer)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def test_the_crop_box_bounds_the_text_and_its_origin_is_reported() -> None:
    cropped = _fax_with(lambda w: setattr(w.pages[0], "cropbox", RectangleObject([100, 100, 500, 700])))
    page = outline(cropped)["pages"][0]
    assert (page["width_pt"], page["height_pt"], page["origin_x"], page["origin_y"]) == (400.0, 600.0, 100.0, 100.0)
    with pytest.raises(PatchError, match="leave the page"):
        edit(cropped, {"op": "place_text", "items": [{"page": 1, "x": 20, "y": 20, "text": "outside the crop"}]})
    report, _out = edit(cropped, {"op": "place_text", "items": [{"page": 1, "x": 160, "y": 648, "text": "inside"}]})
    assert report["verify"]["ok"] is True


def test_a_rotated_page_takes_text_only_next_to_a_reported_line() -> None:
    rotated = _fax_with(lambda w: w.pages[0].rotate(90))
    with pytest.raises(PatchError, match="rotated") as info:
        edit(rotated, {"op": "place_text", "items": [{"page": 1, "x": 300, "y": 300, "text": "far from any text"}]})
    assert info.value.details["problems"][0]["reason"] == "rotated_page"
    report, _ = edit(rotated, {"op": "place_text", "items": [{"page": 1, "x": 160, "y": 649, "text": "near To"}]})
    assert report["verify"]["ok"] is True


def test_a_signed_pdf_is_refused_by_place_text() -> None:
    def sign(w: PdfWriter) -> None:
        w._root_object[NameObject("/AcroForm")] = DictionaryObject(
            {NameObject("/Fields"): ArrayObject(), NameObject("/SigFlags"): NumberObject(3)}
        )

    with pytest.raises(PatchError, match="signature"):
        edit(_fax_with(sign), {"op": "place_text", "items": [{"page": 1, "x": 100, "y": 700, "text": "a"}]})


@pytest.mark.parametrize("text", ["a) Tj ET 1 0 0 RG BT /F1 50 Tf (pwn", "back\\slash) Tj (x", "a\\", "(((", "))) \\("])
def test_text_is_escaped_and_cannot_add_drawing_operators(text: str) -> None:
    flat = make_fax_pdf()
    report, out = edit(flat, {"op": "place_text", "items": [{"page": 1, "x": 100, "y": 300, "text": text}]})
    assert report["verify"]["ok"] is True
    reader = PdfReader(io.BytesIO(out))
    # the whole text is one drawn string: nothing in it was read as an operator, so the page gained exactly one
    # text fragment, equal to the text
    from cerea_documents.pdflayout import _fragments

    after = [f.raw for f in _fragments(reader.pages[0])]
    before = [f.raw for f in _fragments(PdfReader(io.BytesIO(flat)).pages[0])]
    assert len(after) == len(before) + 1 and after.count(text) == 1


def test_the_pages_own_resources_survive_a_placement() -> None:
    flat = make_fax_pdf()
    before = set(PdfReader(io.BytesIO(flat)).pages[0]["/Resources"]["/Font"].keys())
    _, out = edit(
        flat, {"op": "place_text", "items": [{"page": 1, "x": 100, "y": 300, "text": "x", "font": "Helvetica-Bold"}]}
    )
    after = set(PdfReader(io.BytesIO(out)).pages[0]["/Resources"]["/Font"].keys())
    assert before < after and {"/CrPT2"} <= after - before
    assert "Fax cover sheet" in PdfReader(io.BytesIO(out)).pages[0].extract_text()


@pytest.mark.parametrize("text", ["a\x00b", "a\x1fb", "tab\there", "bell\x07", "del\x7f"])
def test_control_characters_are_refused_in_placed_text(text: str) -> None:
    with pytest.raises(PatchError, match="control characters"):
        edit(make_fax_pdf(), {"op": "place_text", "items": [{"page": 1, "x": 100, "y": 300, "text": text}]})


def test_control_characters_are_refused_in_form_values_but_a_line_break_is_for_multiline_fields() -> None:
    with pytest.raises(PatchError, match="control characters"):
        edit(make_form_pdf(), {"op": "fill_form", "values": {"full_name": "Ada\x00 Lovelace"}})
    with pytest.raises(PatchError, match="single-line"):
        edit(make_form_pdf(), {"op": "fill_form", "values": {"full_name": "Ada\nLovelace"}})


def test_the_render_has_no_script_engine_and_no_xfa() -> None:
    import pypdfium2 as pdfium

    flags = pdfium.PDFIUM_INFO.flags
    assert "V8" not in flags and "XFA" not in flags  # a document's JavaScript can never run


def test_a_form_layer_that_will_not_start_renders_the_page_without_it(monkeypatch: pytest.MonkeyPatch) -> None:
    import pypdfium2 as pdfium

    def broken(self: Any, *args: Any, **kwargs: Any) -> None:
        raise RuntimeError("no form env")

    monkeypatch.setattr(pdfium.PdfDocument, "init_forms", broken)
    item = render_pages(make_fax_pdf(), {"pages": [1], "width_px": 400}, LIMITS)["images"][0]
    assert item["width"] == 400
