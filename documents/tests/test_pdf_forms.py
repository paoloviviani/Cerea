"""PDF forms in the document tools: `doc_outline` lists the fields, `doc_edit fill_form` fills them.

Every value is read back with pypdf itself (not with the code under test) and, where it matters, drawn with
PDFium (when pypdfium2 is installed) to look at the pixels."""

from __future__ import annotations

import io
from typing import Any

import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, TextStringObject
from starlette.testclient import TestClient

from cerea_documents import core, pdfform
from cerea_documents.config import Limits
from cerea_documents.errors import DocumentError, InvalidDocument, PatchError, UnsafeDocument

from .conftest import AUTH, make_client, parse_multipart, post
from .pdf_fixtures import make_form_pdf, make_plain_pdf, make_xfa_pdf, reread

LIMITS = Limits()

ALL: dict[str, Any] = {
    "full_name": "Ada Lovelace",
    "code": "ABC",
    "email": "ada@example.org",
    "agree": True,
    "colour": "green",
    "country": "France",  # by its label; stored as FR
    "topics": "beta",
    "tags": ["red", "blue"],
    "notes": "Line one\nLine two",
}


def fill(data: bytes, values: dict[str, Any], flatten: bool = False) -> tuple[dict[str, Any], bytes]:
    op: dict[str, Any] = {"op": "fill_form", "values": values}
    if flatten:
        op["flatten"] = True
    return core.edit(data, "pdf", {"operations": [op]}, {}, LIMITS)


def fields_of(outline: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {f["name"]: f for f in outline["form"]["fields"]}


# -- doc_outline ------------------------------------------------------------------------------------------


def test_outline_lists_pages_and_every_kind_of_field() -> None:
    o = core.outline(make_form_pdf(), "pdf", LIMITS)
    assert o["format"] == "pdf" and o["page_count"] == 3
    assert [p["page"] for p in o["pages"]] == [1, 2, 3] and o["pages"][0]["width_pt"] == pytest.approx(595.3, abs=0.1)
    assert o["operations"] == ["fill_form"] and o["form"]["xfa"] is False
    f = fields_of(o)
    assert {n: x["type"] for n, x in f.items()} == {
        "full_name": "text",
        "code": "text",
        "locked": "text",
        "email": "text",
        "agree": "checkbox",
        "colour": "radio",
        "country": "combo",
        "topics": "list",
        "tags": "list",
        "notes": "text",
        "signature": "signature",
    }
    assert f["full_name"]["pages"] == [1] and f["agree"]["pages"] == [2] and f["country"]["pages"] == [3]
    assert f["code"]["max_length"] == 5
    assert f["locked"]["read_only"] is True and f["locked"]["value"] == "fixed"
    assert f["email"]["required"] is True and "required" not in f["full_name"]
    assert f["agree"]["allowed"] == [True, False, "Si"] and f["agree"]["on_state"] == "Si"
    assert f["colour"]["allowed"] == ["red", "green", "blue"] and f["colour"]["value"] == "Off"
    assert f["country"]["options"] == [
        {"value": "IT", "label": "Italy"},
        {"value": "FR", "label": "France"},
        {"value": "ES", "label": "Spain"},
    ]
    assert f["country"]["value"] == "IT"
    assert [x["value"] for x in f["topics"]["options"]] == ["alpha", "beta", "gamma"]
    assert f["tags"]["multiple"] is True and f["notes"]["multiline"] is True
    assert f["signature"]["fillable"] is False


def test_outline_of_a_pdf_without_a_form_says_so() -> None:
    o = core.outline(make_plain_pdf(), "pdf", LIMITS)
    assert o["page_count"] == 2 and o["form"]["has_form"] is False and o["form"]["fields"] == []
    assert "no fillable form fields" in o["form"]["note"] and o["operations"] == []


def test_outline_reports_xfa_as_such() -> None:
    o = core.outline(make_xfa_pdf(), "pdf", LIMITS)
    assert o["form"]["xfa"] is True and "XFA" in o["form"]["note"] and o["operations"] == []


# -- fill_form --------------------------------------------------------------------------------------------


def test_fill_form_fills_every_type_on_every_page() -> None:
    report, out = fill(make_form_pdf(), ALL)
    values = reread(out)
    assert values["full_name"] == "Ada Lovelace" and values["code"] == "ABC" and values["email"] == "ada@example.org"
    assert str(values["agree"]) == "/Si" and str(values["colour"]) == "/green"  # names, as a viewer reads them
    assert values["country"] == "FR" and values["topics"] == "beta"
    assert [str(t) for t in values["tags"]] == ["red", "blue"] and values["notes"] == "Line one\nLine two"  # type: ignore[attr-defined]
    assert values["locked"] == "fixed"  # untouched
    # the widget states a viewer draws
    reader = PdfReader(io.BytesIO(out))
    states: list[tuple[str, str]] = [
        (str(a.get_object().get("/T") or a.get_object()["/Parent"]["/T"]), str(a.get_object().get("/AS")))
        for p in reader.pages
        for a in p.get("/Annots", [])
        if a.get_object().get("/AS") is not None
    ]
    assert ("agree", "/Si") in states
    assert sorted(v for n, v in states if n == "colour") == ["/Off", "/Off", "/green"]
    v = report["verify"]
    assert v["ok"] is True and v["fields_checked"] == 9 and v["not_taken"] == [] and v["reopened_with"] == "pypdf"
    assert report["operations"][0]["result"]["skipped"] == []
    assert 'agree: "Off" -> "Si"' in report["diff"] and 'country: "IT" -> "FR"' in report["diff"]
    assert report["format"] == "pdf" and report["passed_through"] == []


def test_fill_form_accepts_the_on_state_and_off_for_a_checkbox() -> None:
    _, out = fill(make_form_pdf(), {"agree": "Si"})
    assert str(reread(out)["agree"]) == "/Si"
    _, again = fill(out, {"agree": False})
    assert str(reread(again)["agree"]) == "/Off"
    _, slash = fill(make_form_pdf(), {"agree": "/Si"})
    assert str(reread(slash)["agree"]) == "/Si"


def test_fill_form_is_deterministic_and_leaves_other_values() -> None:
    source = make_form_pdf()
    a = fill(source, {"full_name": "Ada"})[1]
    assert a == fill(source, {"full_name": "Ada"})[1]  # the same edit of the same file is the same bytes
    _, second = fill(a, {"code": "XY"})
    v = reread(second)
    assert v["full_name"] == "Ada" and v["code"] == "XY"


def test_fill_form_reports_the_fields_it_was_not_given() -> None:
    report, _ = fill(make_form_pdf(), {"full_name": "Ada"})
    result = report["operations"][0]["result"]
    assert "email" in result["skipped"] and "locked" not in result["skipped"]  # read-only is not a gap
    assert "signature" not in result["skipped"] and result["skipped_count"] == len(result["skipped"])


@pytest.mark.parametrize(
    ("values", "needle"),
    [
        ({"agree": "maybe"}, 'field "agree" takes true, false, "Si", not "maybe"'),
        ({"colour": "pink"}, 'field "colour" takes one of "red", "green", "blue", not "pink"'),
        ({"country": "Germany"}, '("Italy" (value IT), "France" (value FR), "Spain" (value ES)), not "Germany"'),
        ({"topics": "delta"}, 'field "topics" takes one of its options ("alpha", "beta", "gamma"), not "delta"'),
        ({"topics": ["alpha", "beta"]}, 'field "topics" takes one value, not a list'),
        ({"code": "ABCDEFG"}, 'field "code" takes at most 5 characters, and this has 7'),
        ({"locked": "x"}, 'field "locked" is read-only'),
        ({"signature": "x"}, 'field "signature" is a signature and cannot be filled'),
        ({"full_name": True}, 'field "full_name" needs text'),
        ({"full_name": "a\nb"}, "single-line field"),
        ({"full_nam": "x"}, 'there is no field named "full_nam"; the closest are "full_name"'),
        ({"colour": None}, 'field "colour" must have one option chosen'),
    ],
)
def test_fill_form_rejects_a_bad_value_naming_the_field_and_what_it_takes(values: dict[str, Any], needle: str) -> None:
    with pytest.raises(PatchError) as ei:
        fill(make_form_pdf(), values)
    assert needle in str(ei.value)
    err = ei.value
    assert err.operation_index == 0 and err.details["nothing_written"] is True
    assert err.details["problems"][0]["field"] == next(iter(values))


def test_fill_form_is_all_or_nothing_and_lists_every_problem() -> None:
    with pytest.raises(PatchError) as ei:
        fill(make_form_pdf(), {"full_name": "Ada", "agree": "maybe", "colour": "pink"})
    assert [p["field"] for p in ei.value.details["problems"]] == ["agree", "colour"]
    assert ei.value.details["problems"][1]["allowed"] == ["red", "green", "blue"]
    assert "2 values were not acceptable and nothing was written" in str(ei.value)


def test_fill_form_matches_a_choice_by_label_case_insensitively_and_clears_it() -> None:
    _, out = fill(make_form_pdf(), {"country": "spain", "topics": None})
    v = reread(out)
    assert v["country"] == "ES" and v["topics"] is None


def test_fill_form_flatten_bakes_the_values_in_and_removes_the_form() -> None:
    report, out = fill(make_form_pdf(), ALL, flatten=True)
    reader = PdfReader(io.BytesIO(out))
    root: Any = reader.trailer["/Root"]
    assert "/AcroForm" not in root and not (reader.get_fields() or {})
    assert all(a.get_object().get("/Subtype") != "/Widget" for p in reader.pages for a in p.get("/Annots", []))
    text = [p.extract_text() for p in reader.pages]
    assert "Ada Lovelace" in text[0] and "ada@example.org" in text[0]
    assert "France" in text[2] and "beta" in text[2] and "Line two" in text[2]
    assert "Application form - page 2" in text[1]  # the page's own content is still there
    assert report["verify"]["ok"] is True and report["verify"]["flattened"] is True
    assert report["operations"][0]["result"]["flattened"] is True
    # and it is not a form any more: filling it again says so
    with pytest.raises(PatchError, match="no fillable form fields"):
        fill(out, {"full_name": "x"})


def test_report_catches_a_value_that_did_not_take(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pdfform, "_set_button", lambda field, state: None)
    report, _ = fill(make_form_pdf(), {"full_name": "Ada", "agree": True, "colour": "blue"})
    v = report["verify"]
    assert v["ok"] is False and [r["field"] for r in v["not_taken"]] == ["agree", "colour"]
    assert v["filled"] == 1 and v["fields_checked"] == 3
    assert "field \"agree\": wanted 'Si', found 'Off'" in v["problems"][0]
    assert [f["field"] for f in report["operations"][0]["result"]["filled"]] == ["full_name"]


def test_report_catches_a_choice_that_did_not_take(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pdfform, "_set_choice", lambda writer, field, acro, stored: None)
    report, _ = fill(make_form_pdf(), {"country": "Spain", "tags": ["red", "blue"]})
    assert [r["field"] for r in report["verify"]["not_taken"]] == ["country", "tags"]
    assert report["verify"]["not_taken"][0]["found"] == "IT"


def test_xfa_and_forms_without_fields_are_refused_clearly() -> None:
    with pytest.raises(PatchError, match="XFA form") as ei:
        fill(make_xfa_pdf(), {"full_name": "Ada"})
    assert ei.value.reason == "xfa"
    with pytest.raises(PatchError, match="no fillable form fields"):
        fill(make_plain_pdf(), {"name": "Ada"})


def test_a_pdf_takes_one_operation_and_only_fill_form() -> None:
    op = {"op": "fill_form", "values": {"full_name": "a"}}
    with pytest.raises(PatchError, match="exactly one operation"):
        core.edit(make_form_pdf(), "pdf", {"operations": [op, op]}, {}, LIMITS)
    with pytest.raises(DocumentError, match=r"unknown operation 'replace_text' for pdf; available: \['fill_form'\]"):
        core.edit(
            make_form_pdf(), "pdf", {"operations": [{"op": "replace_text", "find": "a", "replace": "b"}]}, {}, LIMITS
        )
    with pytest.raises(DocumentError, match="values"):
        core.edit(make_form_pdf(), "pdf", {"operations": [{"op": "fill_form"}]}, {}, LIMITS)
    with pytest.raises(DocumentError, match="flatten"):
        core.edit(make_form_pdf(), "pdf", {"operations": [{**op, "flatten": "yes"}]}, {}, LIMITS)
    with pytest.raises(DocumentError, match="values"):
        core.edit(make_form_pdf(), "pdf", {"operations": [{"op": "fill_form", "values": {}}]}, {}, LIMITS)


def test_a_field_named_like_a_grouped_field_is_refused_not_misfilled() -> None:
    writer = PdfWriter(clone_from=io.BytesIO(make_form_pdf()))
    fields = writer._root_object["/AcroForm"]["/Fields"]
    by_name = {str(r.get_object()["/T"]): r for r in fields}
    inner = by_name["notes"].get_object()
    inner[NameObject("/T")] = TextStringObject("full_name")  # a nested field whose last part equals a top-level one
    group = DictionaryObject(
        {NameObject("/T"): TextStringObject("group"), NameObject("/Kids"): ArrayObject([by_name["notes"]])}
    )
    gref = writer._add_object(group)
    inner[NameObject("/Parent")] = gref
    fields[list(fields).index(by_name["notes"])] = gref
    buf = io.BytesIO()
    writer.write(buf)
    with pytest.raises(PatchError, match="shares its name with a field inside a group"):
        fill(buf.getvalue(), {"full_name": "Ada"})
    _, out = fill(buf.getvalue(), {"group.full_name": "inside"})  # the full name is always safe
    assert reread(out)["group.full_name"] == "inside" and reread(out)["full_name"] in (None, "")


# -- refusals ---------------------------------------------------------------------------------------------


def test_what_is_not_a_readable_pdf_is_refused() -> None:
    with pytest.raises(InvalidDocument, match="not a PDF"):
        core.outline(b"hello world", "pdf", LIMITS)
    with pytest.raises(InvalidDocument, match="cannot be read"):
        core.outline(b"%PDF-1.7\n1 0 obj\n<< garbage", "pdf", LIMITS)
    with pytest.raises(InvalidDocument, match="not a zip-based Office package"):  # a PDF named .docx
        core.outline(make_form_pdf(), "docx", LIMITS)


def test_an_encrypted_pdf_is_refused() -> None:
    writer = PdfWriter(clone_from=io.BytesIO(make_form_pdf()))
    writer.encrypt("secret", algorithm="RC4-128")
    buf = io.BytesIO()
    writer.write(buf)
    with pytest.raises(InvalidDocument, match="password-protected") as ei:
        core.outline(buf.getvalue(), "pdf", LIMITS)
    assert ei.value.reason == "encrypted"


def test_limits_on_pages_and_fields() -> None:
    with pytest.raises(UnsafeDocument, match="has 3 pages; the limit is 2") as ei:
        core.outline(make_form_pdf(), "pdf", Limits(max_pdf_pages=2))
    assert ei.value.reason == "too_many_pages"
    with pytest.raises(UnsafeDocument, match="more than 5 fields") as ei2:
        core.outline(make_form_pdf(), "pdf", Limits(max_pdf_fields=5))
    assert ei2.value.reason == "too_many_fields"


def test_a_form_whose_fields_loop_is_read_once_and_one_nested_too_deep_is_refused() -> None:
    writer = PdfWriter(clone_from=io.BytesIO(make_form_pdf()))
    fields = writer._root_object["/AcroForm"]["/Fields"]
    first = fields[0]
    first.get_object()[NameObject("/Kids")] = ArrayObject([first])  # a field that is its own kid
    buf = io.BytesIO()
    writer.write(buf)
    o = core.outline(buf.getvalue(), "pdf", LIMITS)
    assert len(o["form"]["fields"]) == 10  # the looping field is skipped, the others read

    writer = PdfWriter(clone_from=io.BytesIO(make_form_pdf()))
    root_fields = writer._root_object["/AcroForm"]["/Fields"]
    node: Any = None
    for i in range(pdfform.MAX_DEPTH + 3):
        node = DictionaryObject(
            {
                NameObject("/T"): TextStringObject(f"g{i}"),
                NameObject("/Kids"): ArrayObject([node] if node else [root_fields[0]]),
            }
        )
        node = writer._add_object(node)
    root_fields.append(node)
    buf = io.BytesIO()
    writer.write(buf)
    with pytest.raises(UnsafeDocument, match="nested more than"):
        core.outline(buf.getvalue(), "pdf", LIMITS)


# -- the HTTP service --------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def client() -> Any:
    with make_client() as c:
        yield c


def test_http_outline_and_edit_of_a_pdf(client: TestClient) -> None:
    r = post(client, "/v1/outline", "form.pdf", make_form_pdf())
    assert r.status_code == 200 and r.json()["format"] == "pdf" and len(r.json()["form"]["fields"]) == 11
    body = {"operations": [{"op": "fill_form", "values": {"full_name": "Ada Lovelace", "agree": True}}]}
    r = post(client, "/v1/edit", "form.pdf", make_form_pdf(), body)
    assert r.status_code == 200, r.text
    result, out = parse_multipart(r)
    assert result["content_type"] == "application/pdf" and result["file_name"] == "form.pdf"
    assert result["verify"]["ok"] is True and reread(out)["full_name"] == "Ada Lovelace"
    # a bad value is a 422 that names the field and what it takes
    bad = {"operations": [{"op": "fill_form", "values": {"colour": "pink"}}]}
    r = post(client, "/v1/edit", "form.pdf", make_form_pdf(), bad)
    e = r.json()["error"]
    assert (
        r.status_code == 422
        and e["code"] == "operation_failed"
        and e["details"]["problems"][0]["allowed"]
        == [
            "red",
            "green",
            "blue",
        ]
    )


def test_http_read_of_a_pdf_says_what_to_use_instead(client: TestClient) -> None:
    r = post(client, "/v1/read", "form.pdf", make_form_pdf(), {"targets": ["p1"]})
    assert r.status_code == 415 and "doc_outline" in r.json()["error"]["message"]


def test_http_pdf_is_listed_in_the_capabilities(client: TestClient) -> None:
    caps = client.get("/v1/capabilities", headers=AUTH).json()
    pdf = caps["formats"]["pdf"]
    assert pdf["outline"] is True and pdf["read"] is False and pdf["operations"] == ["fill_form"]
    assert pdf["track_changes"] is False and pdf["operation_schemas"]["fill_form"]["required"] == ["op", "values"]
    assert caps["formats"]["docx"]["read"] is True


# -- what a viewer draws ----------------------------------------------------------------------------------


def _render(data: bytes, page: int) -> Any:
    pdfium = pytest.importorskip("pypdfium2")
    doc = pdfium.PdfDocument(data)
    try:
        doc.init_forms()
    except Exception:  # - old builds without form support still draw the appearances
        pass
    return doc[page].render(scale=1.5, may_draw_forms=True).to_pil().convert("L")


def _ink(image: Any, box: tuple[float, float, float, float]) -> int:
    """Dark pixels inside a box given in PDF points of an A4 page rendered at scale 1.5."""
    x0, y0, x1, y1 = box
    crop = image.crop((int(x0 * 1.5), int((841.9 - y1) * 1.5), int(x1 * 1.5), int((841.9 - y0) * 1.5)))
    return sum(1 for px in crop.get_flattened_data() if px < 110)


@pytest.mark.parametrize("flatten", [False, True])
def test_a_viewer_shows_the_values(flatten: bool) -> None:
    pytest.importorskip("pypdfium2")
    empty, filled = make_form_pdf(), fill(make_form_pdf(), ALL, flatten=flatten)[1]
    # page 1: the full name box has text in it; the checkbox on page 2 is ticked; the radio is on "green"
    assert _ink(_render(filled, 0), (160, 716, 400, 736)) > _ink(_render(empty, 0), (160, 716, 400, 736)) + 40
    assert _ink(_render(filled, 1), (160, 718, 176, 734)) > _ink(_render(empty, 1), (160, 718, 176, 734)) + 15
    assert _ink(_render(filled, 1), (230, 668, 246, 684)) > _ink(_render(empty, 1), (230, 668, 246, 684)) + 10
    assert _ink(_render(filled, 1), (160, 668, 176, 684)) <= _ink(_render(empty, 1), (160, 668, 176, 684)) + 15
    # page 3: the combo shows its label, and the list marks its selection
    assert _ink(_render(filled, 2), (160, 716, 310, 736)) > _ink(_render(empty, 2), (160, 716, 310, 736)) + 20
