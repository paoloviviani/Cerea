"""Hostile inputs must be refused cleanly, with the right error, without the service exceeding its limits."""

from __future__ import annotations

import io
import time
from collections.abc import Callable
from typing import Any

import pytest
from starlette.testclient import TestClient

from cerea_documents import runner

from . import hostile
from .conftest import AUTH, make_client, parse_multipart, post
from .fixtures import make_docx, make_xlsx, parts

EDIT = {"operations": [{"op": "replace_text", "find": "Acme", "replace": "Beta"}]}
CHILD_RSS_LIMIT_KB = 100 * 1024  # a worker that expanded a bomb or entities would blow far past this


def children_rss_kb() -> int:
    """The largest peak RSS any worker reported (measured by the worker itself, after exec)."""
    return runner.STATS["peak_rss_kb"]


def refused(
    client: TestClient,
    name: str,
    data: bytes,
    status: int,
    code: str,
    reason: str | None = None,
    path: str = "/v1/outline",
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    t0 = time.monotonic()
    r = post(client, path, name, data, body)
    elapsed = time.monotonic() - t0
    assert r.status_code == status, (r.status_code, r.text[:300])
    e = r.json()["error"]
    assert e["code"] == code, e
    if reason:
        assert e.get("reason") == reason, e
    assert elapsed < 20, f"refusal took {elapsed:.1f}s"
    assert "/etc/passwd" not in r.text and "root:" not in r.text
    return e


CASES: list[tuple[str, str, Callable[[], bytes], int, str, str | None]] = [
    ("xxe_docx", "a.docx", hostile.docx_xxe, 422, "unsafe_document", "doctype"),
    ("billion_laughs", "a.docx", hostile.docx_laughs, 422, "unsafe_document", "doctype"),
    ("external_dtd", "a.docx", hostile.docx_external_dtd, 422, "unsafe_document", "doctype"),
    ("xxe_xlsx", "a.xlsx", hostile.xlsx_xxe, 422, "unsafe_document", "doctype"),
    ("xxe_pptx", "a.pptx", hostile.pptx_xxe, 422, "unsafe_document", "doctype"),
    ("doctype_in_untouched_part", "a.docx", hostile.doctype_in_rels, 422, "unsafe_document", "doctype"),
    ("zip_bomb_ratio", "a.docx", hostile.zip_bomb_ratio, 422, "unsafe_document", "zip_bomb"),
    ("zip_bomb_many_parts", "a.docx", hostile.zip_bomb_total, 422, "unsafe_document", "zip_bomb"),
    ("zip_bomb_part_cap", "a.docx", hostile.zip_bomb_part_cap, 422, "unsafe_document", "part_too_large"),
    ("too_many_entries", "a.docx", hostile.zip_many_entries, 422, "unsafe_document", "too_many_entries"),
    ("path_traversal", "a.docx", hostile.path_traversal, 422, "unsafe_document", "path_traversal"),
    (
        "absolute_path",
        "a.docx",
        lambda: hostile.path_traversal("/etc/cron.d/x"),
        422,
        "unsafe_document",
        "path_traversal",
    ),
    (
        "backslash_path",
        "a.docx",
        lambda: hostile.path_traversal("word\\..\\x.xml"),
        422,
        "unsafe_document",
        "path_traversal",
    ),
    ("drive_path", "a.docx", lambda: hostile.path_traversal("C:/x.xml"), 422, "unsafe_document", "path_traversal"),
    ("duplicate_entries", "a.docx", hostile.duplicate_entries, 422, "unsafe_document", "duplicate_entry"),
    ("symlink", "a.docx", hostile.symlink_entry, 422, "unsafe_document", "symlink"),
    ("encrypted", "a.docx", hostile.encrypted_entry, 422, "unsafe_document", "encrypted"),
    ("malformed_part", "a.docx", hostile.malformed_document_xml, 422, "invalid_document", "malformed_xml"),
    ("deep_nesting", "a.docx", hostile.deep_nesting, 422, "invalid_document", "malformed_xml"),
    ("truncated_zip", "a.docx", hostile.truncated_zip, 422, "invalid_document", "not_a_package"),
    ("not_a_zip", "a.docx", hostile.not_a_zip, 422, "invalid_document", "not_a_package"),
    ("empty_file", "a.docx", lambda: b"", 422, "invalid_document", "not_a_package"),
    ("no_content_types", "a.docx", hostile.no_content_types, 422, "invalid_document", "not_office"),
    ("zip_without_office", "a.docx", hostile.zip_without_office, 422, "invalid_document", "not_office"),
]


@pytest.mark.parametrize(("name", "fname", "build", "status", "code", "reason"), CASES, ids=[c[0] for c in CASES])
def test_refused_on_outline(
    client: TestClient, name: str, fname: str, build: Callable[[], bytes], status: int, code: str, reason: str
) -> None:
    refused(client, fname, build(), status, code, reason)


@pytest.mark.parametrize(("name", "fname", "build", "status", "code", "reason"), CASES, ids=[c[0] for c in CASES])
def test_refused_on_edit(
    client: TestClient, name: str, fname: str, build: Callable[[], bytes], status: int, code: str, reason: str
) -> None:
    refused(
        client,
        fname,
        build(),
        status,
        code,
        reason,
        "/v1/edit",
        EDIT
        if fname.endswith("docx")
        else {"operations": [{"op": "set_cells", "sheet": "x", "cells": {"A1": 1}}]}
        if fname.endswith("xlsx")
        else {"operations": [{"op": "delete_slide", "slide": 1}]},
    )


def test_bad_crc_is_refused(client: TestClient) -> None:
    r = post(client, "/v1/edit", "a.docx", hostile.bad_crc(), EDIT)
    assert r.status_code in (422,) and r.json()["error"]["code"] in ("invalid_document", "operation_failed"), r.text[
        :200
    ]


def test_workers_stayed_far_below_their_memory_limit() -> None:
    """After every refusal above the largest child ever seen is still small: no bomb or entity was expanded."""
    runner.STATS["peak_rss_kb"] = 0
    with make_client() as c:
        for build in (hostile.zip_bomb_ratio, hostile.zip_bomb_total, hostile.docx_laughs, hostile.deep_nesting):
            post(c, "/v1/outline", "a.docx", build())
    assert 0 < children_rss_kb() < CHILD_RSS_LIMIT_KB, children_rss_kb()


def test_xxe_never_reads_the_file_even_if_the_refusal_were_skipped() -> None:
    """Belt and braces: parsing with our hardened parser (no DOCTYPE check) does not resolve the entity."""
    from lxml import etree

    from cerea_documents import xmlsafe

    root = etree.fromstring(hostile.XXE, xmlsafe._parser())
    assert "root:" not in etree.tostring(root).decode()


# ---- active content ------------------------------------------------------------------


def test_macro_enabled_file_passes_through_untouched(client: TestClient) -> None:
    src = hostile.docm()
    vba = parts(src)["word/vbaProject.bin"]
    r = post(client, "/v1/edit", "macro.docm", src, EDIT)
    assert r.status_code == 200, r.text[:300]
    result, out = parse_multipart(r)
    p = parts(out)
    assert p["word/vbaProject.bin"] == vba, "the macro project must be byte-identical"
    assert b"macroEnabled" in p["[Content_Types].xml"] and p["[Content_Types].xml"] == parts(src)["[Content_Types].xml"]
    assert "word/vbaProject.bin" in result["passed_through"]
    assert result["verify"]["changed"] == ["word/document.xml"]
    assert (
        result["content_type"] == "application/vnd.ms-word.document.macroEnabled.12"
        and result["file_name"] == "macro.docm"
    )
    o = post(client, "/v1/outline", "macro.docm", src).json()
    assert o["passed_through"] == ["word/vbaProject.bin"]


def test_creation_of_macros_is_impossible_no_operation_adds_active_content() -> None:
    from cerea_documents import core

    forbidden = ("vba", "macro", "activex", "ole")
    for fmt, eng in core.ENGINES.items():
        assert not [o for o in eng.OPS if any(k in o for k in forbidden)], fmt


# ---- images ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "data", "status", "reason"),
    [
        ("huge.png", hostile.huge_png(), 422, "image_pixels"),
        ("vector.png", hostile.svg_image(), 422, "image_type"),
        ("fake.png", hostile.png_signature_jpeg_body(), 422, None),
        ("txt.png", b"just text", 422, "image_type"),
        ("garbage.gif", hostile.gif_garbage(), 422, None),
    ],
)
def test_hostile_images_refused(client: TestClient, name: str, data: bytes, status: int, reason: str | None) -> None:
    body = {"operations": [{"op": "insert_image_after", "anchor": "p2", "image": name}]}
    r = post(client, "/v1/edit", "a.docx", make_docx(), body, images={name: data})
    assert r.status_code == status, r.text[:300]
    e = r.json()["error"]
    assert e["code"] == "invalid_request"
    if reason:
        assert e["reason"] == reason


def test_image_byte_limit() -> None:
    with make_client(max_image_bytes=50) as c:
        body = {"operations": [{"op": "insert_image_after", "anchor": "p2", "image": "a.png"}]}
        from .fixtures import png

        r = post(c, "/v1/edit", "a.docx", make_docx(), body, images={"a.png": png(200, 200, (1, 2, 3))})
        assert r.status_code == 422 and r.json()["error"]["reason"] == "image_too_large"


def test_pixel_limit_is_configurable() -> None:
    with make_client(max_image_pixels=100) as c:
        from .fixtures import png

        body = {"operations": [{"op": "insert_image_after", "anchor": "p2", "image": "a.png"}]}
        r = post(c, "/v1/edit", "a.docx", make_docx(), body, images={"a.png": png(20, 20, (1, 2, 3))})
        assert r.status_code == 422 and r.json()["error"]["reason"] == "image_pixels"


# ---- oversized requests ---------------------------------------------------------------------


def test_oversized_request_is_refused_before_reading_it() -> None:
    with make_client(max_request_bytes=1024 * 1024) as c:
        r = post(c, "/v1/outline", "a.docx", b"A" * (2 * 1024 * 1024))
        assert r.status_code == 413 and r.json()["error"]["code"] == "too_large"


def test_oversized_streamed_request_without_content_length() -> None:
    """A chunked body that lies about (or omits) its length is cut off at the limit."""
    import asyncio

    from cerea_documents.api import create_app
    from cerea_documents.config import Limits, Settings

    app = create_app(Settings(secret="s", limits=Limits(max_request_bytes=100_000)))
    sent: list[dict[str, Any]] = []
    head = b'--zz\r\nContent-Disposition: form-data; name="file"; filename="a.docx"\r\n\r\n'
    chunks = [head + b"x" * 60_000, b"x" * 60_000, b""]

    async def receive() -> dict[str, Any]:
        c = chunks.pop(0)
        return {"type": "http.request", "body": c, "more_body": bool(chunks)}

    async def send(m: dict[str, Any]) -> None:
        sent.append(m)

    scope = {
        "type": "http", "method": "POST", "path": "/v1/outline", "raw_path": b"/v1/outline", "query_string": b"", "root_path": "",
        "headers": [(b"content-type", b"multipart/form-data; boundary=zz"), (b"x-cerea-documents-secret", b"s"), (b"transfer-encoding", b"chunked")],
        "scheme": "http", "server": ("t", 80), "client": ("c", 1), "http_version": "1.1",
    }  # fmt: skip
    asyncio.run(app(scope, receive, send))  # type: ignore[arg-type]
    start = next(m for m in sent if m["type"] == "http.response.start")
    assert start["status"] == 413


def test_oversized_json_body_and_operation_count() -> None:
    with make_client(max_body_bytes=2000, max_operations=3) as c:
        big = {"operations": [{"op": "replace_text", "find": "a", "replace": "x" * 5000}]}
        r = post(c, "/v1/edit", "a.docx", make_docx(), big)
        assert r.status_code == 413 and r.json()["error"]["reason"] == "body_size"
        many = {"operations": [{"op": "replace_text", "find": "a", "replace": "b"}] * 4}
        r = post(c, "/v1/edit", "a.docx", make_docx(), many)
        assert r.status_code == 422 and "operations" in r.json()["error"]["message"]


def test_too_many_images_and_duplicate_image_names(client: TestClient) -> None:
    from .fixtures import png

    imgs = {f"i{n}.png": png(5, 5, (n, n, n)) for n in range(25)}
    r = post(
        client,
        "/v1/edit",
        "a.docx",
        make_docx(),
        {"operations": [{"op": "insert_image_after", "anchor": "p1", "image": "i1.png"}]},
        images=imgs,
    )
    assert r.status_code in (400, 413, 422)
    r = client.post(
        "/v1/edit",
        files=[
            ("file", ("a.docx", make_docx())),
            ("image", ("x.png", png(5, 5, (1, 1, 1)))),
            ("image", ("x.png", png(5, 5, (2, 2, 2)))),
        ],
        data={"body": '{"operations":[{"op":"insert_image_after","anchor":"p1","image":"x.png"}]}'},
        headers=AUTH,
    )
    assert r.status_code == 422 and "two images are named" in r.json()["error"]["message"]


def test_oversized_package_is_refused_by_the_zip_layer() -> None:
    from cerea_documents import core
    from cerea_documents.config import Limits
    from cerea_documents.errors import UnsafeDocument

    with pytest.raises(UnsafeDocument, match="larger than the allowed upload"):
        core.outline(make_xlsx(), "xlsx", Limits(max_request_bytes=1000))


_ = io
