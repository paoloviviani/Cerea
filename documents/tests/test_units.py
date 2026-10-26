"""Unit and property tests for the hardening layers: config, zip pre-checks, XML, images, fuzzing."""

from __future__ import annotations

import contextlib
import io
import zipfile
from dataclasses import replace

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from cerea_documents import core, xmlsafe
from cerea_documents.config import Limits, Settings
from cerea_documents.errors import ConfigError, DocumentError, InvalidDocument, InvalidRequest, UnsafeDocument
from cerea_documents.images import inspect_image
from cerea_documents.zipsafe import check_name, check_package

from .fixtures import jpeg, make_docx, make_pptx, make_xlsx, png, rezip

LIM = Limits()


# ---- configuration -----------------------------------------------------------------


def test_limits_default_and_env_override() -> None:
    assert Limits.from_env({}) == Limits()
    lim = Limits.from_env({"CEREA_DOCUMENTS_MAX_ZIP_ENTRIES": "10", "CEREA_DOCUMENTS_WORKER_WALL_SECONDS": "5"})
    assert lim.max_zip_entries == 10 and lim.worker_wall_seconds == 5 and lim.max_part_bytes == Limits().max_part_bytes
    with pytest.raises(ConfigError, match="must be an integer"):
        Limits.from_env({"CEREA_DOCUMENTS_MAX_RATIO": "lots"})
    with pytest.raises(ConfigError, match="at least"):
        Limits.from_env({"CEREA_DOCUMENTS_WORKER_MEMORY_BYTES": "1000"})


def test_settings_secret_rules() -> None:
    assert Settings.from_env({"CEREA_DOCUMENTS_SECRET": "x"}).secret == "x"
    with pytest.raises(ConfigError):
        Settings.from_env({}).validate()
    Settings.from_env({"CEREA_DOCUMENTS_ALLOW_NO_AUTH": "1"}).validate()


# ---- zip pre-checks -------------------------------------------------------------------


@pytest.mark.parametrize("name", ["../x", "a/../../x", "/abs", "\\win", "a\\b", "C:/x", "a\x00b", ""])
def test_check_name_refuses(name: str) -> None:
    with pytest.raises(UnsafeDocument) as ei:
        check_name(name)
    assert ei.value.reason == "path_traversal"


@pytest.mark.parametrize(
    "name", ["word/document.xml", "[Content_Types].xml", "_rels/.rels", "xl/worksheets/sheet1.xml", "a..b/c"]
)
def test_check_name_accepts(name: str) -> None:
    check_name(name)


def test_total_size_cap() -> None:
    lim = replace(LIM, max_total_bytes=300_000, max_ratio=100_000)
    data = rezip(make_docx(), {}, {"word/big.bin": bytes(range(256)) * 1500})
    with pytest.raises(UnsafeDocument) as ei:
        check_package(data, lim)
    assert ei.value.reason == "total_too_large"


def test_per_part_cap_and_entry_cap() -> None:
    with pytest.raises(UnsafeDocument) as ei:
        check_package(make_docx(), replace(LIM, max_part_bytes=1000))
    assert ei.value.reason == "part_too_large"
    with pytest.raises(UnsafeDocument) as ei:
        check_package(make_docx(), replace(LIM, max_zip_entries=3))
    assert ei.value.reason == "too_many_entries"


def test_ratio_only_applies_to_large_parts() -> None:
    small = rezip(make_docx(), {}, {"word/zeros.bin": b"\0" * 500_000})  # 500 KB of zeros: under the 1 MiB floor
    check_package(small, LIM)
    big = rezip(make_docx(), {}, {"word/zeros.bin": b"\0" * 3_000_000})
    with pytest.raises(UnsafeDocument) as ei:
        check_package(big, LIM)
    assert ei.value.reason == "zip_bomb"


def test_real_world_files_pass_the_precheck() -> None:
    for data in (make_docx(), make_xlsx(), make_pptx()[0]):
        assert check_package(data, LIM)


# ---- XML -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "xml",
    [
        b'<?xml version="1.0"?><!DOCTYPE a><a/>',
        b'<?xml version="1.0"?><!-- c --><!doctype a [<!ENTITY e "x">]><a>&e;</a>',
        b"<!DOCTYPE a SYSTEM 'http://evil/x.dtd'><a/>",
        b"\xef\xbb\xbf<!DOCTYPE a><a/>",
        '<?xml version="1.0"?><!DOCTYPE a><a/>'.encode("utf-16"),
    ],
)
def test_doctype_variants_are_refused(xml: bytes) -> None:
    with pytest.raises(UnsafeDocument) as ei:
        xmlsafe.parse(xml)
    assert ei.value.reason == "doctype"


def test_doctype_text_inside_content_is_fine() -> None:
    root = xmlsafe.parse(b"<a><![CDATA[<!DOCTYPE x>]]></a>")
    assert root.text == "<!DOCTYPE x>"


def test_undefined_entities_and_garbage_are_invalid_not_expanded() -> None:
    for bad in (b"<a>&xxe;</a>", b"<a", b"", b"\xff\xfe\x00"):
        with pytest.raises(DocumentError):
            xmlsafe.parse(bad)


# ---- images -----------------------------------------------------------------------------------


def test_valid_images_accepted() -> None:
    assert inspect_image(png(10, 5, (1, 2, 3)), "a.png", LIM).ext == "png"
    info = inspect_image(jpeg(20, 10), "a.jpg", LIM)
    assert (info.ext, info.width, info.height) == ("jpeg", 20, 10)
    from PIL import Image

    buf = io.BytesIO()
    Image.new("P", (4, 4)).save(buf, "GIF")
    assert inspect_image(buf.getvalue(), "a.gif", LIM).content_type == "image/gif"


@pytest.mark.parametrize("data", [b"", b"x" * 100, b"\x89PNG\r\n\x1a\n", b"GIF89a", b"\xff\xd8\xff"])
def test_broken_images_refused(data: bytes) -> None:
    with pytest.raises(InvalidRequest):
        inspect_image(data, "a.png", LIM)


# ---- fuzz: parsers only ever refuse with a DocumentError ----------------------------------------


@settings(max_examples=150, deadline=None)
@given(st.binary(max_size=400))
def test_random_bytes_as_xml(data: bytes) -> None:
    with contextlib.suppress(DocumentError):
        xmlsafe.parse(data)


@settings(max_examples=100, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(st.binary(max_size=2000))
def test_random_bytes_as_package(data: bytes) -> None:
    for fn in (lambda: core.outline(data, None, LIM), lambda: check_package(data, LIM)):
        with contextlib.suppress(DocumentError):
            fn()


_BASE = {"docx": make_docx(), "xlsx": make_xlsx(), "pptx": make_pptx()[0]}


@settings(
    max_examples=60, deadline=None, suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture]
)
@given(st.sampled_from(sorted(_BASE)), st.integers(min_value=0), st.integers(min_value=0, max_value=255), st.booleans())
def test_mutated_documents_are_refused_cleanly_or_still_work(fmt: str, pos: int, byte: int, in_xml: bool) -> None:
    """Flip one byte anywhere (or inside a main XML part) and outline it: success or a DocumentError, never a crash."""
    data = _BASE[fmt]
    if in_xml:
        main = {"docx": "word/document.xml", "xlsx": "xl/workbook.xml", "pptx": "ppt/presentation.xml"}[fmt]
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            part = bytearray(z.read(main))
        part[pos % len(part)] = byte
        data = rezip(data, {main: bytes(part)})
    else:
        b = bytearray(data)
        b[pos % len(b)] = byte
        data = bytes(b)
    probe = {
        "docx": {"op": "replace_text", "find": "Acme", "replace": "Beta"},
        "xlsx": {"op": "set_cells", "sheet": "T2.4", "cells": {"B2": 1}},
        "pptx": {"op": "set_notes", "slide": 1, "text": "n"},
    }[fmt]
    for fn in (lambda: core.outline(data, fmt, LIM), lambda: core.edit(data, fmt, {"operations": [probe]}, {}, LIM)):
        with contextlib.suppress(DocumentError):
            fn()


def test_invalid_document_is_a_document_error() -> None:
    assert issubclass(InvalidDocument, DocumentError)
