"""Reproducible output: the same spec gives the same bytes. Libraries stamp 'now' into zip entries and
document properties; a fixed instant replaces both."""

from __future__ import annotations

import datetime as _dt
import io
import re
import zipfile

FIXED = _dt.datetime(2000, 1, 1, 0, 0, 0)
FIXED_ISO = "2000-01-01T00:00:00Z"
_STAMP = re.compile(rb"(<dcterms:(?:created|modified)[^>]*>)[^<]*(</dcterms:(?:created|modified)>)")


def fix_zip(blob: bytes, core_part: str | None = "docProps/core.xml") -> bytes:
    """Rewrite a zip with fixed entry dates and fixed created/modified stamps in `core_part`."""
    out = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(blob)) as zi,
        zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zo,
    ):
        for info in zi.infolist():
            data = zi.read(info.filename)
            if core_part and info.filename == core_part:
                data = _STAMP.sub(rb"\g<1>" + FIXED_ISO.encode() + rb"\g<2>", data)
            zinfo = zipfile.ZipInfo(info.filename, FIXED.timetuple()[:6])
            zinfo.compress_type = zipfile.ZIP_DEFLATED
            zinfo.external_attr = 0o600 << 16
            zinfo.create_system = 3
            zo.writestr(zinfo, data)
    return out.getvalue()
