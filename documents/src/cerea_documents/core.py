"""The service functions: outline, read and edit on bytes. Everything here runs inside the
sandboxed worker process, never in the HTTP process."""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from types import ModuleType
from typing import Any

from . import ENGINE, excel, powerpoint, word
from .config import Limits
from .errors import InvalidDocument, PatchError, UnsupportedFormat
from .images import inspect_image
from .images_ref import ImageSet, Img
from .pkg import Pkg
from .schemas import validate_edit, validate_read
from .verify import verify

ENGINES: dict[str, ModuleType] = {"docx": word, "xlsx": excel, "pptx": powerpoint}
_FAMILY = {
    "wordprocessingml": "docx",
    "ms-word": "docx",
    "spreadsheetml": "xlsx",
    "ms-excel": "xlsx",
    "presentationml": "pptx",
    "ms-powerpoint": "pptx",
}
ACTIVE_CONTENT = ("vbaProject.bin", "/activeX/", "/embeddings/", "oleObject")


@contextlib.contextmanager
def _structure_errors() -> Iterator[None]:
    """Documents that are well-formed XML but not what Office writes (a number that is not a number,
    a missing attribute) surface as plain Python errors in the engines; report them as a refusal."""
    try:
        yield
    except (
        ValueError,
        KeyError,
        TypeError,
        AttributeError,
        IndexError,
        AssertionError,
        OverflowError,
        ArithmeticError,
    ) as exc:
        raise InvalidDocument(
            f"the document's structure is not valid ({type(exc).__name__}: {str(exc)[:160]})",
            reason="malformed_structure",
        ) from exc


def detect_format(pkg: Pkg, filename_format: str | None = None) -> str:
    """The format from the package's own main-part content type; refuse a name/content mismatch."""
    if not pkg.has("[Content_Types].xml") or not pkg.has("_rels/.rels"):
        raise InvalidDocument(
            "the zip is not an Office package: [Content_Types].xml or _rels/.rels is missing", reason="not_office"
        )
    main = next((t for _i, typ, t, _m in pkg.rels("") if typ.endswith("/officeDocument")), None)
    if main is None:
        raise UnsupportedFormat(
            "the file is a zip but not an Office package (it has no main document part)", reason="not_office"
        )
    ctype = ""
    for o in pkg.tree("[Content_Types].xml"):
        if o.get("PartName") == "/" + main:
            ctype = o.get("ContentType") or ""
    fmt = next((f for k, f in _FAMILY.items() if k in ctype), None)
    if fmt is None:
        raise UnsupportedFormat(
            f"unsupported Office content type {ctype!r}; this service edits Word, Excel and PowerPoint files",
            reason="content_type",
        )
    if filename_format and filename_format != fmt:
        raise UnsupportedFormat(
            f"the file is named as {filename_format} but its content is a {fmt} document; send it with the right extension",
            reason="format_mismatch",
        )
    return fmt


def passed_through(pkg: Pkg) -> list[str]:
    """Macro, ActiveX and OLE parts present: never parsed or executed, copied through untouched."""
    return sorted(n for n in pkg.names if any(k in "/" + n or n.endswith(k) for k in ACTIVE_CONTENT))


def _images(raw: dict[str, bytes], limits: Limits) -> ImageSet:
    return ImageSet({name: Img(data, inspect_image(data, name, limits)) for name, data in raw.items()})


def outline(data: bytes, filename_format: str | None, limits: Limits) -> dict[str, Any]:
    with _structure_errors():
        pkg = Pkg(data, limits)
        fmt = detect_format(pkg, filename_format)
        return {"format": fmt, **ENGINES[fmt].outline(pkg), "passed_through": passed_through(pkg)}


def read(data: bytes, filename_format: str | None, body: dict[str, Any], limits: Limits) -> dict[str, Any]:
    with _structure_errors():
        pkg = Pkg(data, limits)
        fmt = detect_format(pkg, filename_format)
        validate_read(fmt, body)
        return {"format": fmt, **ENGINES[fmt].read(pkg, body["targets"])}


def edit(
    data: bytes, filename_format: str | None, body: dict[str, Any], raw_images: dict[str, bytes], limits: Limits
) -> tuple[dict[str, Any], bytes]:
    """Apply all operations or none. Returns (report, new file bytes)."""
    with _structure_errors():
        return _edit(data, filename_format, body, raw_images, limits)


def _edit(
    data: bytes, filename_format: str | None, body: dict[str, Any], raw_images: dict[str, bytes], limits: Limits
) -> tuple[dict[str, Any], bytes]:
    pkg = Pkg(data, limits)
    orig = Pkg(data, limits)  # untouched view of the source, for the verify report and the diff
    fmt = detect_format(pkg, filename_format)
    validate_edit(fmt, body, limits)
    images = _images(raw_images, limits)
    engine = ENGINES[fmt]
    ctx = engine.start(pkg, bool(body.get("track_changes")), body.get("author") or "Cerea", images)
    applied: list[dict[str, Any]] = []
    for i, op in enumerate(body["operations"]):
        _schema, fn = engine.OPS[op["op"]]
        try:
            result = fn(ctx, {k: v for k, v in op.items() if k != "op"})
        except PatchError as exc:
            exc.operation_index = i
            exc.message = f"operation {i} ({op['op']}): {exc.message}"
            exc.args = (exc.message,)
            exc.details = {
                **exc.details,
                "operation": op["op"],
                "applied_before_failure": len(applied),
                "nothing_written": True,
            }
            raise
        applied.append({"index": i, "op": op["op"], "result": result})
    finish = engine.finish(ctx) if hasattr(engine, "finish") else {}
    expected = set(pkg.changed)
    out_bytes = pkg.save()
    report, out = verify(orig, out_bytes, limits, engine, expected, fmt)
    return {
        "format": fmt,
        "engine": ENGINE,
        "operations": applied,
        "diff": engine.diff_text(orig, out),
        "verify": report,
        "passed_through": passed_through(orig),
        **finish,
    }, out_bytes


def capabilities() -> dict[str, Any]:
    formats: dict[str, Any] = {}
    for name, eng in ENGINES.items():
        formats[name] = {
            "outline": True,
            "read": True,
            "operations": sorted(eng.OPS),
            # The JSON schema of every operation: what the chat builds its tool descriptions from,
            # so the contract has one source.
            "operation_schemas": {op: eng.OPS[op][0] for op in sorted(eng.OPS)},
            "deferred_operations": list(eng.DEFERRED),
            "track_changes": name == "docx",
        }
    return {
        "engine": ENGINE,
        "formats": formats,
        "image_types": ["png", "jpeg", "gif"],
        "create": False,
        "convert": False,
    }
