"""Hostile fixtures. Each builder returns bytes that must be refused cleanly."""

from __future__ import annotations

import io
import struct
import zipfile
import zlib

from .fixtures import make_docx, make_pptx, make_xlsx, parts, rezip

XXE = (
    b'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
    b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>'
)
LAUGHS = (
    b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">'
    + b"".join(
        b'<!ENTITY lol%d "%s">' % (i, b"".join(b"&lol%d;" % (i - 1 if i > 1 else 0) for _ in range(10)))
        for i in range(1, 10)
    ).replace(b"&lol0;", b"&lol;")
    + b']><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lol9;</w:t></w:r></w:p></w:body></w:document>'
)
EXTERNAL = (
    b'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY % remote SYSTEM "http://127.0.0.1:9/evil.dtd">%remote;]>'
    b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'
)


def with_part(data: bytes, part: str, content: bytes) -> bytes:
    return rezip(data, {part: content})


def docx_xxe() -> bytes:
    return with_part(make_docx(), "word/document.xml", XXE)


def docx_laughs() -> bytes:
    return with_part(make_docx(), "word/document.xml", LAUGHS)


def docx_external_dtd() -> bytes:
    return with_part(make_docx(), "word/document.xml", EXTERNAL)


def xlsx_xxe() -> bytes:
    return with_part(make_xlsx(), "xl/worksheets/sheet3.xml", XXE.replace(b"w:document", b"worksheet"))


def pptx_xxe() -> bytes:
    src, _ = make_pptx()
    return with_part(src, "ppt/slides/slide1.xml", XXE.replace(b"w:document", b"p:sld"))


def doctype_in_rels() -> bytes:
    """A DOCTYPE in a part the operation never touches must still be refused up front."""
    return with_part(make_docx(), "word/styles.xml", XXE)


def _zip(entries: list[tuple[str, bytes]], deflate: bool = True) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED if deflate else zipfile.ZIP_STORED) as z:
        for n, b in entries:
            z.writestr(n, b)
    return out.getvalue()


def zip_bomb_ratio(mib: int = 20) -> bytes:
    """One part of zeros, small enough for the per-part cap but compressing ~1000:1."""
    return rezip(make_docx(), {"word/document.xml": b"\0" * (mib * 1024 * 1024)})


def zip_bomb_total() -> bytes:
    """Many parts, each under the per-part cap, expanding past the total cap."""
    return rezip(make_docx(), {}, {f"word/bomb{i}.bin": b"\0" * (30 * 1024 * 1024) for i in range(10)})


def zip_bomb_part_cap() -> bytes:
    return rezip(make_docx(), {"word/document.xml": b"\0" * (40 * 1024 * 1024)})


def zip_many_entries(n: int = 6000) -> bytes:
    return rezip(make_docx(), {}, {f"word/e{i}.xml": b"<a/>" for i in range(n)})


def path_traversal(name: str = "../../evil.xml") -> bytes:
    out = io.BytesIO()
    src = make_docx()
    with zipfile.ZipFile(io.BytesIO(src)) as zi, zipfile.ZipFile(out, "w") as zo:
        for i in zi.infolist():
            zo.writestr(i.filename, zi.read(i.filename))
        zo.writestr(zipfile.ZipInfo(name), b"x")
    return out.getvalue()


def duplicate_entries() -> bytes:
    import warnings

    out = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with zipfile.ZipFile(io.BytesIO(make_docx())) as zi, zipfile.ZipFile(out, "w") as zo:
            for i in zi.infolist():
                zo.writestr(i.filename, zi.read(i.filename))
            zo.writestr("word/document.xml", b"<w:document/>")
    return out.getvalue()


def symlink_entry() -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(make_docx())) as zi, zipfile.ZipFile(out, "w") as zo:
        for i in zi.infolist():
            zo.writestr(i.filename, zi.read(i.filename))
        link = zipfile.ZipInfo("word/link")
        link.create_system = 3
        link.external_attr = (0o120777) << 16
        zo.writestr(link, b"/etc/passwd")
    return out.getvalue()


def encrypted_entry() -> bytes:
    """Set the 'encrypted' flag on one entry's local and central headers."""
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(make_docx())) as zi, zipfile.ZipFile(out, "w") as zo:
        for i in zi.infolist():
            zo.writestr(i.filename, zi.read(i.filename))
        zo.writestr("word/secret.xml", b"x")
    d = bytearray(out.getvalue())
    name = b"word/secret.xml"
    local = d.index(b"PK\x03\x04", d.index(name) - 30)
    d[local + 6] |= 1
    cen = d.rindex(b"PK\x01\x02", 0, d.rindex(name))
    d[cen + 8] |= 1
    return bytes(d)


def docm() -> bytes:
    """A macro-enabled document: a garbage vbaProject.bin that must never be parsed."""
    src = make_docx()
    p = parts(src)
    ct = p["[Content_Types].xml"].decode()
    ct = ct.replace(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "application/vnd.ms-word.document.macroEnabled.main+xml",
    ).replace("<Default ", '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Default ', 1)
    rels = (
        p["word/_rels/document.xml.rels"]
        .decode()
        .replace(
            "</Relationships>",
            '<Relationship Id="rIdVBA" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
        )
    )
    return rezip(
        src,
        {"[Content_Types].xml": ct.encode(), "word/_rels/document.xml.rels": rels.encode()},
        {"word/vbaProject.bin": b"\xd0\xcf\x11\xe0 not really OLE, never parsed \x00\xff" * 40},
    )


def malformed_document_xml() -> bytes:
    return with_part(make_docx(), "word/document.xml", b"<w:document><w:body><w:p></w:body>")


def truncated_zip() -> bytes:
    d = make_docx()
    return d[: len(d) // 2]


def not_a_zip() -> bytes:
    return b"%PDF-1.7 this is not an office file" * 10


def no_content_types() -> bytes:
    return rezip(make_docx(), {"[Content_Types].xml": None})


def zip_without_office() -> bytes:
    return _zip([("hello.txt", b"hi")])


def deep_nesting() -> bytes:
    depth = 5000
    xml = (
        b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        + b"<w:sdt><w:sdtContent>" * depth
        + b"</w:sdtContent></w:sdt>" * depth
        + b"</w:body></w:document>"
    )
    return with_part(make_docx(), "word/document.xml", xml)


def bad_crc() -> bytes:
    d = bytearray(make_docx())
    # flip a byte inside the first stored/deflated entry's data area (after its 30-byte header + name)
    name_len = struct.unpack("<H", d[26:28])[0]
    extra = struct.unpack("<H", d[28:30])[0]
    pos = 30 + name_len + extra + 3
    d[pos] ^= 0xFF
    return bytes(d)


def png_header(w: int, h: int) -> bytes:
    def chunk(t: bytes, d: bytes) -> bytes:
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00" * 16))
        + chunk(b"IEND", b"")
    )


def huge_png() -> bytes:
    return png_header(60000, 60000)  # 3.6 billion pixels declared in a few dozen bytes


def svg_image() -> bytes:
    return b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'


def png_signature_jpeg_body() -> bytes:
    return b"\x89PNG\r\n\x1a\n" + b"\xff\xd8\xff" * 10


def gif_garbage() -> bytes:
    return b"GIF89a" + b"\x00" * 3
