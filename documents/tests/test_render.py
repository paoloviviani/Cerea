"""look_doc's service side: pages of a PDF as images (`POST /v1/render`, render.py, PDFium)."""

from __future__ import annotations

import base64
import io
import subprocess
import sys
from dataclasses import replace
from typing import Any

import pytest
from PIL import Image
from pypdf import PdfWriter
from reportlab.pdfgen import canvas
from starlette.testclient import TestClient

from cerea_documents import runner
from cerea_documents.config import Limits
from cerea_documents.errors import InvalidDocument, InvalidRequest, ResourceLimit

from .conftest import make_client, post
from .pdf_fixtures import make_form_pdf, make_plain_pdf

MiB = 1024 * 1024


def make_deck_pdf(pages: int, size: tuple[float, float] = (960, 540)) -> bytes:
    """A landscape 16:9 'deck': page n carries the big number n and a red bar, so a page can be told from another."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=size)
    for n in range(1, pages + 1):
        c.setFillColorRGB(0.8, 0.1, 0.1)
        c.rect(0, 0, size[0], 40, stroke=0, fill=1)
        c.setFillColorRGB(0, 0, 0)
        c.setFont("Helvetica-Bold", 200)
        c.drawString(size[0] / 3, size[1] / 3, str(n))
        c.showPage()
    c.save()
    return buf.getvalue()


def render(c: TestClient, pdf: bytes, body: dict[str, Any]) -> Any:
    return post(c, "/v1/render", "a.pdf", pdf, body)


def decode(item: dict[str, Any]) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(item["data_base64"])))


def test_renders_the_pages_with_count_size_and_format(client: TestClient) -> None:
    r = render(client, make_deck_pdf(3), {"max_side_px": 1200})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["page_count"] == 3 and [i["page"] for i in out["images"]] == [1, 2, 3]
    for item in out["images"]:
        img = decode(item)
        assert (img.width, img.height) == (item["width"], item["height"])
        assert max(img.size) == 1200 and img.size == (1200, 675)  # the longest side, 16:9 kept
        assert item["format"] in ("png", "jpeg") and item["content_type"] == f"image/{item['format']}"
        assert img.format == item["format"].upper()
    # a slide of flat colour and text is smaller as PNG; the service picks the smaller of the two
    assert out["images"][0]["format"] == "png"


def test_a_page_is_fitted_to_the_width(client: TestClient) -> None:
    out = render(client, make_plain_pdf(), {"width_px": 1000, "pages": [2]}).json()
    (item,) = out["images"]
    assert out["page_count"] == 2 and item["page"] == 2 and item["width"] == 1000 and 1400 <= item["height"] <= 1430


def test_selects_the_pages_asked_for_in_the_order_asked(client: TestClient) -> None:
    out = render(client, make_deck_pdf(4), {"max_side_px": 400, "pages": [3, 1]}).json()
    assert [i["page"] for i in out["images"]] == [3, 1] and out["page_count"] == 4
    # different pages really are different pictures
    assert decode(out["images"][0]).tobytes() != decode(out["images"][1]).tobytes()


def test_default_is_the_first_pages_up_to_the_cap(client: TestClient) -> None:
    out = render(client, make_deck_pdf(9), {"max_side_px": 300}).json()
    assert [i["page"] for i in out["images"]] == [1, 2, 3, 4, 5, 6] and out["page_count"] == 9


def test_the_cap_refuses_more_pages_than_allowed(client: TestClient) -> None:
    r = render(client, make_deck_pdf(9), {"max_side_px": 300, "pages": [1, 2, 3, 4, 5, 6, 7]})
    assert r.status_code == 422 and r.json()["error"]["reason"] == "too_many_render_pages"
    assert "at most 6" in r.json()["error"]["message"]


def test_a_page_that_does_not_exist_is_refused_with_the_count(client: TestClient) -> None:
    r = render(client, make_deck_pdf(2), {"max_side_px": 300, "pages": [3]})
    err = r.json()["error"]
    assert r.status_code == 422 and err["reason"] == "page_out_of_range" and err["details"]["page_count"] == 2
    assert render(client, make_deck_pdf(2), {"max_side_px": 300, "pages": [0]}).status_code == 422


@pytest.mark.parametrize(
    "body",
    [{}, {"width_px": 500, "max_side_px": 500}, {"width_px": 0}, {"width_px": "9"}, {"max_side_px": 500, "extra": 1}],
)
def test_a_bad_size_or_unknown_field_is_refused(client: TestClient, body: dict[str, Any]) -> None:
    assert render(client, make_deck_pdf(1), body).status_code == 422


def test_an_image_larger_than_the_ceiling_is_refused(client: TestClient) -> None:
    r = render(client, make_deck_pdf(1), {"max_side_px": 5000})
    assert r.status_code == 422 and r.json()["error"]["reason"] == "too_large_image"


def test_a_very_tall_page_is_kept_inside_the_ceiling(client: TestClient) -> None:
    out = render(client, make_deck_pdf(1, size=(200, 14400)), {"width_px": 1000}).json()
    assert max(out["images"][0]["width"], out["images"][0]["height"]) <= Limits().max_render_px


def test_a_degenerate_page_is_refused_not_drawn_as_a_sliver(client: TestClient) -> None:
    strip = make_deck_pdf(1, size=(14400, 1))
    r = render(client, strip, {"width_px": 1000})
    assert r.status_code == 422 and r.json()["error"]["reason"] == "page_too_small"
    assert r.json()["error"]["details"]["page"] == 1
    # an ordinary small page still draws
    assert render(client, make_deck_pdf(1, size=(200, 100)), {"width_px": 200}).status_code == 200


def test_an_encrypted_pdf_is_refused(client: TestClient) -> None:
    w = PdfWriter(clone_from=io.BytesIO(make_plain_pdf()))
    w.encrypt("user-secret", "owner-secret")
    buf = io.BytesIO()
    w.write(buf)
    r = render(client, buf.getvalue(), {"max_side_px": 300})
    assert r.status_code == 422 and r.json()["error"]["reason"] == "encrypted"
    assert "encrypted" in r.json()["error"]["message"]


def test_a_file_that_is_not_a_pdf_is_refused(client: TestClient) -> None:
    assert render(client, b"PK\x03\x04 not a pdf", {"max_side_px": 300}).json()["error"]["reason"] == "not_a_pdf"
    r = render(client, b"%PDF-1.7\nthis is not a real pdf", {"max_side_px": 300})
    assert r.status_code == 422 and r.json()["error"]["reason"] == "damaged"


def test_needs_the_shared_secret() -> None:
    c = make_client()
    r = c.post("/v1/render", files=[("file", ("a.pdf", make_deck_pdf(1), "application/pdf"))], data={"body": "{}"})
    assert r.status_code == 401


def test_a_form_pdf_renders_with_its_page_count(client: TestClient) -> None:
    out = render(client, make_form_pdf(), {"width_px": 800, "pages": [1, 2, 3]}).json()
    assert out["page_count"] == 3 and len(out["images"]) == 3


def test_the_render_limits_are_in_the_capabilities(client: TestClient) -> None:
    from .conftest import AUTH

    caps = client.get("/v1/capabilities", headers=AUTH).json()
    assert caps["render"]["formats"] == ["pdf"]
    assert caps["limits"]["max_render_pages"] == 6 and caps["limits"]["max_render_px"] == 2000


def test_the_memory_cap_holds_on_a_render_that_is_far_too_big() -> None:
    # The ceiling is lifted so an A4 page could be drawn 30,000 px wide (about 5 GB of bitmap): the worker's
    # address-space cap must stop it with the service's own refusal, not crash it or take the host's memory.
    big = replace(Limits(), max_render_px=40_000, worker_memory_bytes=1536 * MiB, worker_wall_seconds=60)
    with pytest.raises(ResourceLimit) as ei:
        import asyncio

        asyncio.run(
            runner.run_job(
                "render",
                make_plain_pdf(),
                filename_format="pdf",
                body={"width_px": 30_000},
                images={},
                limits=big,
            )
        )
    assert ei.value.status == 413


def test_the_default_ceiling_keeps_a_huge_page_small() -> None:
    import asyncio

    huge = make_deck_pdf(1, size=(14400, 14400))
    res = asyncio.run(
        runner.run_job("render", huge, filename_format="pdf", body={"width_px": 2000}, images={}, limits=Limits())
    )
    assert res.result["images"][0]["width"] == 2000
    assert runner.STATS["peak_rss_kb"] < 400 * 1024


def test_pdfium_is_not_imported_by_the_core_worker_path() -> None:
    code = (
        "import sys, cerea_documents.core, cerea_documents.api, cerea_documents.runner, cerea_documents.worker, "
        "cerea_documents.create, cerea_documents.pdfops; "
        "bad = [m for m in sys.modules if m.split('.')[0] in ('pypdfium2', 'pypdfium2_raw')]; "
        "assert not bad, bad; assert 'cerea_documents.render' not in sys.modules"
    )
    done = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr


def test_the_render_errors_are_service_errors() -> None:
    from cerea_documents import render as r

    with pytest.raises(InvalidDocument):
        r.render_pages(b"nope", {"width_px": 100}, Limits())
    with pytest.raises(InvalidRequest):
        r.check_body({"pages": []}, Limits())
