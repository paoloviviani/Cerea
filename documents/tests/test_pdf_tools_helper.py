"""The `pdf-tools` skill's helper (the sandbox route, used when the document tools are not available).

It is a single file the sandbox imports, so it is loaded here by path. Four bugs it had are pinned (each test
below fails on the old helper): only page 1 was filled, checkboxes, radios and lists were never listed (it
filtered on field types that do not exist), `flatten=True` crashed, and a field's allowed values were not
exposed. Set PDF_TOOLS_PATH to test another copy of the file (for example the old one)."""

from __future__ import annotations

import importlib.util
import io
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from pypdf import PdfReader

from cerea_documents import core
from cerea_documents.config import Limits

from .pdf_fixtures import make_form_pdf, make_plain_pdf, make_xfa_pdf, reread

REPO = Path(__file__).resolve().parents[2]
HELPER = Path(os.environ.get("PDF_TOOLS_PATH") or REPO / "src/lib/server/skills/builtin/pdf-tools/scripts/pdf_tools.py")

pytestmark = pytest.mark.skipif(not HELPER.exists(), reason="the chat's skill files are not in this checkout")


@pytest.fixture(scope="module")
def pdf_tools() -> ModuleType:
    spec = importlib.util.spec_from_file_location("pdf_tools_under_test", HELPER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def form(tmp_path: Path) -> str:
    path = tmp_path / "form.pdf"
    path.write_bytes(make_form_pdf())
    return str(path)


def fields(pdf_tools: ModuleType, path: str) -> dict[str, dict[str, Any]]:
    return {f["name"]: f for f in pdf_tools.form_fields(path)["fields"]}


def test_bug_1_fields_after_page_one_are_filled(pdf_tools: ModuleType, form: str, tmp_path: Path) -> None:
    out = str(tmp_path / "out.pdf")
    pdf_tools.fill_form(
        form, {"full_name": "Ada", "agree": True, "colour": "blue", "country": "ES", "notes": "p3"}, out
    )
    v = reread(Path(out).read_bytes())
    assert v["full_name"] == "Ada" and str(v["agree"]) == "/Si" and str(v["colour"]) == "/blue"
    assert v["country"] == "ES" and v["notes"] == "p3"  # pages 2 and 3, not only page 1


def test_bug_2_buttons_and_choices_are_listed_with_their_options(pdf_tools: ModuleType, form: str) -> None:
    f = fields(pdf_tools, form)
    assert {n: x["type"] for n, x in f.items()}.items() >= {
        "agree": "checkbox",
        "colour": "radio",
        "country": "combo",
        "topics": "list",
        "signature": "signature",
    }.items()
    assert f["agree"]["allowed"] == [True, False, "Si"]
    assert f["colour"]["allowed"] == ["red", "green", "blue"]
    assert [o["value"] for o in f["country"]["options"]] == ["IT", "FR", "ES"]
    assert f["country"]["options"][1] == {"value": "FR", "label": "France"}


def test_bug_3_flatten_works(pdf_tools: ModuleType, form: str, tmp_path: Path) -> None:
    out = str(tmp_path / "flat.pdf")
    report = pdf_tools.fill_form(
        form, {"full_name": "Ada Lovelace", "agree": True, "country": "France"}, out, flatten=True
    )
    reader = PdfReader(out)
    assert not (reader.get_fields() or {}) and report["flattened"] is True
    assert "Ada Lovelace" in reader.pages[0].extract_text() and "France" in reader.pages[2].extract_text()


def test_bug_4_a_value_outside_the_allowed_ones_is_rejected_with_them(
    pdf_tools: ModuleType, form: str, tmp_path: Path
) -> None:
    out = tmp_path / "never.pdf"
    with pytest.raises(Exception, match=r'field "colour" takes one of "red", "green", "blue", not "pink"') as ei:
        pdf_tools.fill_form(form, {"full_name": "Ada", "colour": "pink"}, str(out))
    assert type(ei.value).__name__ == "PdfFormError" and not out.exists()
    with pytest.raises(Exception, match=r'field "agree" takes true, false, "Si"'):
        pdf_tools.fill_form(form, {"agree": "yes"}, str(out))


def test_the_report_reads_the_output_back(pdf_tools: ModuleType, form: str, tmp_path: Path) -> None:
    out = str(tmp_path / "out.pdf")
    report = pdf_tools.fill_form(form, {"full_name": "Ada", "tags": ["red", "blue"], "topics": "gamma"}, out)
    assert report["path"] == out and report["rejected"] == []
    assert {f["field"]: f["value"] for f in report["filled"]} == {
        "full_name": "Ada",
        "tags": ["red", "blue"],
        "topics": "gamma",
    }
    assert "email" in report["skipped"] and "locked" not in report["skipped"]


def test_xfa_and_forms_without_fields(pdf_tools: ModuleType, tmp_path: Path) -> None:
    xfa, plain = tmp_path / "xfa.pdf", tmp_path / "plain.pdf"
    xfa.write_bytes(make_xfa_pdf())
    plain.write_bytes(make_plain_pdf())
    listing = pdf_tools.form_fields(str(xfa))
    assert listing["xfa"] is True and "XFA" in listing["note"]
    with pytest.raises(Exception, match="XFA"):
        pdf_tools.fill_form(str(xfa), {"full_name": "Ada"}, str(tmp_path / "o.pdf"))
    assert pdf_tools.form_fields(str(plain))["has_form"] is False
    with pytest.raises(Exception, match="no fillable form fields"):
        pdf_tools.fill_form(str(plain), {"x": "y"}, str(tmp_path / "o.pdf"))


def test_the_helper_and_the_service_see_the_same_form_and_make_the_same_file(
    pdf_tools: ModuleType, form: str, tmp_path: Path
) -> None:
    service = core.outline(make_form_pdf(), "pdf", Limits())["form"]
    # the service adds the label and the table place (page text), which the helper does not compute
    plain = [{k: v for k, v in f.items() if k not in ("label", "table")} for f in service["fields"]]
    assert pdf_tools.form_fields(form)["fields"] == plain
    values = {"full_name": "Ada", "agree": True, "colour": "red", "country": "ES", "tags": ["grey"]}
    out = str(tmp_path / "h.pdf")
    pdf_tools.fill_form(form, values, out)
    _, from_service = core.edit(
        Path(form).read_bytes(), "pdf", {"operations": [{"op": "fill_form", "values": values}]}, {}, Limits()
    )
    assert Path(out).read_bytes() == from_service


def test_the_helper_carries_the_services_form_code() -> None:
    """The shared code is copied, not imported: this fails when the copy is stale."""
    if HELPER != REPO / "src/lib/server/skills/builtin/pdf-tools/scripts/pdf_tools.py":
        pytest.skip("another copy of the helper is under test")
    done = subprocess.run(
        [sys.executable, str(REPO / "scripts/sync_pdf_tools.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr


def test_the_helper_is_stdlib_and_pypdf_only() -> None:
    import ast

    tree = ast.parse(HELPER.read_text())
    roots = {
        (n.module or "").split(".")[0] if isinstance(n, ast.ImportFrom) else a.name.split(".")[0]
        for n in ast.walk(tree)
        for a in (n.names if isinstance(n, ast.Import | ast.ImportFrom) else [])
    }
    assert roots <= set(sys.stdlib_module_names) | {"pypdf"}, roots
    io.BytesIO()  # (the sandbox has no other package)
