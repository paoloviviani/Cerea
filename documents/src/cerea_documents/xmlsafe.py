"""The one place XML is parsed. Entities are never resolved, nothing is fetched,
and any DOCTYPE is refused (this blocks XXE and entity-expansion bombs)."""

from __future__ import annotations

import re

from lxml import etree

from .errors import InvalidDocument, UnsafeDocument

El = etree._Element

_PROLOG_SCAN = 65536
_DOCTYPE = re.compile(r"<!DOCTYPE|<!ENTITY", re.IGNORECASE)


def _parser() -> etree.XMLParser:
    return etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        huge_tree=False,
        dtd_validation=False,
        attribute_defaults=False,
    )


def _prolog_text(data: bytes) -> str:
    head = data[:_PROLOG_SCAN]
    if head.startswith((b"\xff\xfe", b"\xfe\xff")):
        return head.decode("utf-16", errors="replace")
    if head.startswith(b"\xef\xbb\xbf"):
        head = head[3:]
    return head.decode("utf-8", errors="replace")


def refuse_doctype(data: bytes, name: str = "part") -> None:
    """Raise UnsafeDocument when the document prolog declares a DOCTYPE or entity."""
    s = _prolog_text(data)
    i = 0
    n = len(s)
    while i < n:
        while i < n and s[i] in " \t\r\n":
            i += 1
        if s.startswith("<?", i):
            j = s.find("?>", i)
            i = n if j < 0 else j + 2
        elif s.startswith("<!--", i):
            j = s.find("-->", i)
            i = n if j < 0 else j + 3
        else:
            break
    if (s.startswith("<!", i) and not s.startswith("<!--", i)) or _DOCTYPE.match(s, i):
        raise UnsafeDocument(
            f"{name} declares a DOCTYPE or entities, which are refused (no external or custom entities are "
            "allowed in Office files)",
            reason="doctype",
            details={"part": name},
        )


def parse(data: bytes, name: str = "part") -> El:
    """Parse untrusted XML safely; refuse DOCTYPE; raise InvalidDocument when malformed."""
    refuse_doctype(data, name)
    try:
        root = etree.fromstring(data, _parser())
    except etree.XMLSyntaxError as exc:
        raise InvalidDocument(
            f"{name} is not well-formed XML: {exc}", reason="malformed_xml", details={"part": name}
        ) from exc
    doc = root.getroottree().docinfo
    if doc.doctype or doc.internalDTD is not None or doc.externalDTD is not None:  # type: ignore[union-attr]
        raise UnsafeDocument(f"{name} declares a DOCTYPE, which is refused", reason="doctype", details={"part": name})
    return root


def tostring(root: El) -> bytes:
    return etree.tostring(root, encoding="UTF-8")


def tostring_decl(root: El) -> bytes:
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
