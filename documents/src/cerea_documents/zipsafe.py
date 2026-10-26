"""Pre-checks on the zip container, before any part is parsed."""

from __future__ import annotations

import io
import re
import stat
import zipfile
import zlib

from .config import Limits
from .errors import InvalidDocument, UnsafeDocument
from .xmlsafe import refuse_doctype

_DRIVE = re.compile(r"^[A-Za-z]:")
_SMALL = 1024 * 1024  # parts under 1 MiB are exempt from the per-part ratio test
_XML_SUFFIXES = (".xml", ".rels")


def check_name(name: str) -> None:
    """Refuse absolute paths, traversal, backslashes, drive letters and control characters."""
    bad = None
    if not name or "\x00" in name or any(ord(c) < 32 for c in name):
        bad = "empty or contains control characters"
    elif name.startswith(("/", "\\")) or _DRIVE.match(name):
        bad = "is an absolute path"
    elif "\\" in name:
        bad = "contains a backslash"
    elif ".." in name.split("/"):
        bad = "contains a '..' segment"
    if bad:
        raise UnsafeDocument(
            f"the package contains an entry whose name {bad}: {name!r}",
            reason="path_traversal",
            details={"entry": name},
        )


def check_package(data: bytes, limits: Limits) -> list[zipfile.ZipInfo]:
    """Validate the container; return its entries. Reads nothing beyond each XML part's prolog."""
    if len(data) > limits.max_request_bytes:
        raise UnsafeDocument("the file is larger than the allowed upload size", reason="oversized")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError, OSError, EOFError) as exc:
        raise InvalidDocument(
            "the file is not a zip-based Office package (.docx, .xlsx or .pptx) or is damaged",
            reason="not_a_package",
        ) from exc
    with z:
        infos = z.infolist()
        if len(infos) > limits.max_zip_entries:
            raise UnsafeDocument(
                f"the package has {len(infos)} entries; the limit is {limits.max_zip_entries}",
                reason="too_many_entries",
                details={"entries": len(infos), "limit": limits.max_zip_entries},
            )
        seen: set[str] = set()
        total = 0
        for i in infos:
            check_name(i.filename)
            key = i.filename.casefold()
            if key in seen:
                raise UnsafeDocument(
                    f"the package lists {i.filename!r} more than once",
                    reason="duplicate_entry",
                    details={"entry": i.filename},
                )
            seen.add(key)
            mode = (i.external_attr >> 16) & 0xFFFF
            if i.create_system == 3 and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise UnsafeDocument(
                    f"{i.filename!r} is a symbolic link or special file",
                    reason="symlink",
                    details={"entry": i.filename},
                )
            if i.flag_bits & 0x1:
                raise UnsafeDocument(
                    f"{i.filename!r} is encrypted; password-protected files are not supported", reason="encrypted"
                )
            if i.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise UnsafeDocument(f"{i.filename!r} uses an unsupported compression method", reason="compression")
            if i.file_size > limits.max_part_bytes:
                raise UnsafeDocument(
                    f"{i.filename!r} is {i.file_size} bytes uncompressed; the per-part limit is {limits.max_part_bytes}",
                    reason="part_too_large",
                    details={"entry": i.filename, "size": i.file_size, "limit": limits.max_part_bytes},
                )
            if i.file_size > _SMALL and i.file_size > limits.max_ratio * max(i.compress_size, 1):
                raise UnsafeDocument(
                    f"{i.filename!r} expands by more than {limits.max_ratio}x; this looks like a zip bomb",
                    reason="zip_bomb",
                    details={"entry": i.filename},
                )
            total += i.file_size
            if total > limits.max_total_bytes:
                raise UnsafeDocument(
                    f"the package expands to more than {limits.max_total_bytes} bytes; refusing",
                    reason="total_too_large",
                    details={"limit": limits.max_total_bytes},
                )
        if total > _SMALL and total > limits.max_ratio * max(len(data), 1):
            raise UnsafeDocument(
                f"the package expands by more than {limits.max_ratio}x overall; this looks like a zip bomb",
                reason="zip_bomb",
            )
        for i in infos:  # every XML part's prolog: no DOCTYPE anywhere, so no library downstream ever sees one
            if i.filename.endswith(_XML_SUFFIXES) and i.file_size:
                try:
                    with z.open(i) as f:
                        head = f.read(8192)
                except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError, OSError) as exc:
                    raise InvalidDocument(
                        f"{i.filename!r} cannot be read from the package: {exc}",
                        reason="damaged_part",
                        details={"entry": i.filename},
                    ) from exc
                refuse_doctype(head, i.filename)
    return infos
