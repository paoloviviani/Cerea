"""Forms as Acrobat and other producers really store them: repeated fields with separate widget kids, signed
files, values without appearances, rotated and screen-only widgets. Each structure is built by hand
(`pdf_fixtures.Hand`) and each test fails on the first version of the form code (which wrote no appearance for
a field whose widgets are kids, filled and flattened signed files, and drew '?' for what its font cannot show)."""

from __future__ import annotations

import io
import json
from typing import Any

import pytest
from pypdf import PdfReader
from pypdf.generic import ArrayObject, BooleanObject, DictionaryObject, NumberObject, TextStringObject

from cerea_documents import core
from cerea_documents.config import Limits
from cerea_documents.errors import PatchError

from .pdf_fixtures import Hand, _n, button_ap, make_form_pdf, make_repeated_field_pdf, make_signed_pdf, reread

LIMITS = Limits()


def fill(data: bytes, values: dict[str, Any], flatten: bool = False) -> tuple[dict[str, Any], bytes]:
    op: dict[str, Any] = {"op": "fill_form", "values": values}
    if flatten:
        op["flatten"] = True
    return core.edit(data, "pdf", {"operations": [op]}, {}, LIMITS)


def widgets(data: bytes) -> list[DictionaryObject]:
    page = PdfReader(io.BytesIO(data)).pages[0]
    return [a.get_object() for a in page.get("/Annots", []) if a.get_object().get("/Subtype") == "/Widget"]


def ap_text(widget: DictionaryObject) -> bytes:
    return bytes(widget["/AP"]["/N"].get_object().get_data())


# 1 -- a field whose widgets are separate kids ----------------------------------------------------------------


def test_every_widget_of_a_repeated_field_gets_an_appearance() -> None:
    source = make_repeated_field_pdf()
    assert [f["name"] for f in core.outline(source, "pdf", LIMITS)["form"]["fields"]] == [
        "applicant.name",
        "spouse.name",
    ]
    report, out = fill(source, {"applicant.name": "Mario Rossi", "spouse.name": "Anna"})
    assert report["verify"]["ok"] is True
    found = widgets(out)
    assert len(found) == 3 and all("/AP" in w for w in found)
    assert [b"Mario Rossi" in ap_text(w) for w in found] == [True, True, False]
    assert b"/Helv 10.00 Tf" in ap_text(found[0])  # the /DA of the grandparent is honoured
    assert b"Anna" in ap_text(found[2])
    assert reread(out)["applicant.name"] == "Mario Rossi"


def test_flatten_keeps_the_value_of_a_repeated_field() -> None:
    report, out = fill(make_repeated_field_pdf(), {"applicant.name": "Mario Rossi"}, flatten=True)
    text = PdfReader(io.BytesIO(out)).pages[0].extract_text()
    assert text.count("Mario Rossi") == 2  # both widgets of the field are drawn
    assert report["operations"][0]["result"]["flattened"] is True and widgets(out) == []


# 2 -- signed files ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("flatten", [False, True])
def test_a_signed_pdf_is_refused(flatten: bool) -> None:
    with pytest.raises(PatchError, match="would invalidate its digital signature") as ei:
        fill(make_signed_pdf(), {"nome": "Ada"}, flatten=flatten)
    assert ei.value.reason == "signed" and ei.value.details["nothing_written"] is True


def test_sigflags_alone_also_mean_signed() -> None:
    with pytest.raises(PatchError, match="digital signature"):
        fill(make_signed_pdf(with_signature_value=False), {"nome": "Ada"})


def test_the_outline_of_a_signed_pdf_never_dumps_the_signature() -> None:
    o = core.outline(make_signed_pdf(), "pdf", LIMITS)
    sig = next(f for f in o["form"]["fields"] if f["name"] == "firma")
    assert sig["value"] is None and sig["signed"] is True and sig["type"] == "signature"
    assert o["form"]["signed"] is True and "digital signature" in o["form"]["note"]
    assert o["operations"] == [] or o["operations"] == ["fill_form"]
    dump = json.dumps(o)
    assert "SECRET-SIGNATURE" not in dump and "Contents" not in dump and "ByteRange" not in dump


# 3 -- flatten and values that have no appearance ---------------------------------------------------------------


def _prefilled() -> Hand:
    h = Hand()
    h.acro[_n("/NeedAppearances")] = BooleanObject(True)
    da = TextStringObject("/Helv 10 Tf 0 g")
    h.field(
        {"/T": TextStringObject("pre"), "/FT": _n("/Tx"), "/V": TextStringObject("PREFILLED"), "/DA": da},
        kids=[[100, 400, 300, 420]],
    )
    h.field({"/T": TextStringObject("x"), "/FT": _n("/Tx"), "/DA": da}, kids=[[100, 300, 300, 320]])
    h.field(
        {
            "/T": TextStringObject("city"),
            "/FT": _n("/Ch"),
            "/Ff": NumberObject(1 << 17),
            "/V": TextStringObject("MI"),
            "/DA": da,
            "/Opt": ArrayObject(
                [
                    ArrayObject([TextStringObject("TO"), TextStringObject("Torino")]),
                    ArrayObject([TextStringObject("MI"), TextStringObject("Milano")]),
                ]
            ),
        },
        rect=[100, 200, 300, 220],
    )
    return h


def test_flatten_draws_values_the_form_already_held_without_an_appearance() -> None:
    _, out = fill(_prefilled().bytes(), {"x": "new"}, flatten=True)
    text = PdfReader(io.BytesIO(out)).pages[0].extract_text()
    assert "PREFILLED" in text and "new" in text and "Milano" in text  # the combo shows its label


def test_a_value_flatten_cannot_draw_fails_the_operation() -> None:
    h = _prefilled()
    # a ticked checkbox whose widget has no appearance for its state: there is nothing to draw
    h.field({"/T": TextStringObject("cb"), "/FT": _n("/Btn"), "/V": _n("/Yes")}, rect=[100, 100, 110, 110])
    with pytest.raises(PatchError, match=r"flattening would lose the value of \"cb\"") as ei:
        fill(h.bytes(), {"x": "new"}, flatten=True)
    assert ei.value.reason == "flatten_incomplete"
    report, out = fill(h.bytes(), {"x": "new"})  # without flatten the same file is fine
    assert report["verify"]["ok"] is True and reread(out)["x"] == "new"


# 4 -- characters the font cannot show -------------------------------------------------------------------------


def test_italian_accents_and_the_euro_are_drawn() -> None:
    _, out = fill(make_form_pdf(), {"full_name": "Perché, città, €"})
    stream = ap_text(next(w for w in widgets(out) if w.get("/T") == "full_name"))
    assert b"Perch\xe9, citt\xe0, \x80" in stream and b"?" not in stream  # Windows-1252 bytes
    assert reread(out)["full_name"] == "Perché, città, €"
    _, flat = fill(make_form_pdf(), {"full_name": "Perché, città, €"}, flatten=True)
    assert "Perché, città, €" in PdfReader(io.BytesIO(flat)).pages[0].extract_text()


def test_characters_outside_the_font_are_refused_by_name() -> None:
    with pytest.raises(PatchError) as ei:
        fill(make_form_pdf(), {"full_name": "Łódź"})
    message = str(ei.value)
    assert 'field "full_name" cannot show the characters "Ł", "ź"' in message and '"ó"' not in message
    assert ei.value.details["problems"][0]["allowed"] == {"unsupported_characters": ["Ł", "ź"]}


# 5 -- a checkbox group with several on-states -------------------------------------------------------------------


def _group() -> bytes:
    h = Hand()
    h.field(
        {"/T": TextStringObject("grp"), "/FT": _n("/Btn")},
        kids=[[100, 600, 110, 610], [150, 600, 160, 610]],
        kid_extra=[{"/AP": button_ap(h, ["A"])}, {"/AP": button_ap(h, ["B"])}],
    )
    return h.bytes()


def test_true_is_refused_for_a_checkbox_with_several_on_states() -> None:
    o = core.outline(_group(), "pdf", LIMITS)
    assert o["form"]["fields"][0]["allowed"] == [False, "A", "B"]
    with pytest.raises(PatchError, match=r'has several on-states \("A", "B"\)'):
        fill(_group(), {"grp": True})
    _, out = fill(_group(), {"grp": "B"})
    assert str(reread(out)["grp"]) == "/B"


# 6 -- rotated widgets --------------------------------------------------------------------------------------------


def test_a_rotated_choice_and_text_widget_get_swapped_dimensions_and_a_matrix() -> None:
    h = Hand()
    mk = DictionaryObject({_n("/R"): NumberObject(90)})
    h.field(
        {
            "/T": TextStringObject("c"),
            "/FT": _n("/Ch"),
            "/Ff": NumberObject(1 << 17),
            "/MK": mk,
            "/Opt": ArrayObject([TextStringObject("Sì"), TextStringObject("No")]),
        },
        rect=[100, 100, 120, 300],
    )
    h.field({"/T": TextStringObject("t"), "/FT": _n("/Tx"), "/MK": mk}, rect=[200, 100, 220, 300])
    _, out = fill(h.bytes(), {"c": "Sì", "t": "ruotato"})
    for w in widgets(out):
        stream = w["/AP"]["/N"].get_object()
        assert [float(x) for x in stream["/BBox"]] == [0, 0, 200, 20]  # the drawing is landscape, the widget portrait
        assert [float(x) for x in stream["/Matrix"]] == [0, 1, -1, 0, 20, 0]
    assert b"ruotato" in ap_text(widgets(out)[1])


# 7 -- NeedAppearances -------------------------------------------------------------------------------------------


def test_need_appearances_is_not_set_when_every_widget_has_an_appearance() -> None:
    _, out = fill(make_repeated_field_pdf(), {"applicant.name": "x", "spouse.name": "y"})
    acro = PdfReader(io.BytesIO(out)).trailer["/Root"]["/AcroForm"]  # type: ignore[index]
    assert "/NeedAppearances" not in acro
    assert all("/AP" in w for w in widgets(out))
    # a flag the source already had is the source's own and stays
    _, kept = fill(_prefilled().bytes(), {"x": "y"})
    assert PdfReader(io.BytesIO(kept)).trailer["/Root"]["/AcroForm"]["/NeedAppearances"] == True  # type: ignore[index] # noqa: E712


# 8 -- screen-only widgets ---------------------------------------------------------------------------------------


def test_flatten_leaves_out_a_widget_without_the_print_flag_and_does_not_call_it_lost() -> None:
    h = Hand()
    h.field({"/T": TextStringObject("shown"), "/FT": _n("/Tx")}, rect=[100, 700, 300, 720])
    h.field({"/T": TextStringObject("screen"), "/FT": _n("/Tx")}, rect=[100, 600, 300, 620], flags=0)
    report, out = fill(h.bytes(), {"shown": "VISIBLE", "screen": "SCREENONLY"}, flatten=True)
    text = PdfReader(io.BytesIO(out)).pages[0].extract_text()
    assert "VISIBLE" in text and "SCREENONLY" not in text
    assert report["verify"]["ok"] is True


# 9 -- required fields left empty --------------------------------------------------------------------------------


def test_the_report_lists_required_fields_left_empty() -> None:
    report, _ = fill(make_form_pdf(), {"full_name": "Ada"})
    assert report["operations"][0]["result"]["required_missing"] == ["email"]
    report, _ = fill(make_form_pdf(), {"email": "a@b.it"})
    assert report["operations"][0]["result"]["required_missing"] == []


# 10 -- unnamed widget kids next to named ones -------------------------------------------------------------------


def test_unnamed_widget_kids_of_a_field_that_also_has_named_kids_are_kept() -> None:
    h = Hand()
    parent = h.field({"/T": TextStringObject("addr"), "/FT": _n("/Tx")}, kids=[[100, 700, 300, 720]])
    sub = h.w._add_object(
        DictionaryObject({_n("/T"): TextStringObject("zip"), _n("/Parent"): parent, _n("/FT"): _n("/Tx")})
    )
    sub_widget = h.widget(sub, [100, 650, 200, 670])
    sub.get_object()[_n("/Kids")] = ArrayObject([sub_widget])
    parent.get_object()[_n("/Kids")].append(sub)
    o = core.outline(h.bytes(), "pdf", LIMITS)
    assert sorted(f["name"] for f in o["form"]["fields"]) == ["addr", "addr.zip"]
    _, out = fill(h.bytes(), {"addr": "Via Roma 1", "addr.zip": "10100"})
    found = widgets(out)
    assert all("/AP" in w for w in found) and len(found) == 2
