from __future__ import annotations

from typing import Any

import pytest

from cerea_documents import core
from cerea_documents.config import Limits
from cerea_documents.errors import DocumentError, PatchError

from .fixtures import parts

LIMITS = Limits()


def do_edit(
    data: bytes,
    ops: list[dict[str, Any]],
    *,
    fmt: str,
    images: dict[str, bytes] | None = None,
    track: bool = False,
    author: str | None = None,
    limits: Limits = LIMITS,
) -> tuple[dict[str, Any], bytes]:
    body: dict[str, Any] = {"operations": ops}
    if track:
        body["track_changes"] = True
    if author:
        body["author"] = author
    return core.edit(data, fmt, body, images or {}, limits)


def refuses(
    data: bytes, ops: list[dict[str, Any]], needle: str, *, fmt: str, images: dict[str, bytes] | None = None
) -> DocumentError:
    with pytest.raises(DocumentError) as ei:
        do_edit(data, ops, fmt=fmt, images=images)
    assert needle in str(ei.value), f"{needle!r} not in {str(ei.value)!r}"
    return ei.value


def untouched(src: bytes, dst: bytes, allowed: set[str]) -> int:
    a, b = parts(src), parts(dst)
    bad = [n for n in a if n in b and n not in allowed and a[n] != b[n]]
    assert not bad, f"untouched parts changed: {bad}"
    assert all(n in b for n in a if n not in allowed), "an untouched part was lost"
    return len(a)


__all__ = ["LIMITS", "PatchError", "do_edit", "refuses", "untouched"]
