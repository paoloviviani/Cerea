"""An OOXML package held in memory: parts are read lazily, edited trees are rewritten,
every other part is copied through byte for byte."""

from __future__ import annotations

import io
import re
import time
import zipfile
import zlib
from typing import Any

from .config import Limits
from .errors import InvalidDocument, PatchError
from .xmlsafe import El, parse, tostring
from .zipsafe import check_package

REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
OD_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
_DECL = re.compile(rb"\s*<\?xml[^>]*\?>\s*")
DEFAULT_DECL = b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
_CACHE_MAX = 1024 * 1024


def resolve(base: str, target: str) -> str:
    """Resolve a relationship target against the part that owns it."""
    parts = [] if target.startswith("/") else base.split("/")[:-1]
    for s in target.lstrip("/").split("/"):
        if s == "..":
            if parts:
                parts.pop()
        elif s != ".":
            parts.append(s)
    return "/".join(parts)


def relpath(part: str) -> str:
    d, _, b = part.rpartition("/")
    return (d + "/" if d else "") + "_rels/" + b + ".rels"


def owner(rels_name: str) -> str:
    d, _, b = rels_name.rpartition("_rels/")
    return d + b[:-5]


class Pkg:
    def __init__(self, data: bytes, limits: Limits) -> None:
        self.limits = limits
        self.source = data
        infos = check_package(data, limits)
        self._zip = zipfile.ZipFile(io.BytesIO(data))
        self.names: list[str] = [i.filename for i in infos]
        self.info: dict[str, zipfile.ZipInfo] = {i.filename: i for i in infos}
        self._over: dict[str, bytes] = {}
        self._cache: dict[str, bytes] = {}
        self.trees: dict[str, El] = {}
        self.dirty: set[str] = set()
        self.added: set[str] = set()
        self.removed: set[str] = set()

    # -- reading ----------------------------------------------------------
    def has(self, name: str) -> bool:
        return name in self._over or (name in self.info and name not in self.removed)

    def read(self, name: str) -> bytes:
        if name in self._over:
            return self._over[name]
        if name not in self.info or name in self.removed:
            raise PatchError(f"part {name} is missing from the package; is this the right kind of file?")
        if name in self._cache:
            return self._cache[name]
        try:
            data = self._zip.read(name)
        except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError) as exc:
            raise InvalidDocument(
                f"part {name} is damaged: {exc}", reason="damaged_part", details={"part": name}
            ) from exc
        if len(data) <= _CACHE_MAX:
            self._cache[name] = data
        return data

    def tree(self, name: str) -> El:
        if name not in self.trees:
            self.trees[name] = parse(self.read(name), name)
        return self.trees[name]

    def touch(self, name: str) -> None:
        self.tree(name)
        self.dirty.add(name)

    def rels(self, part: str) -> list[tuple[str, str, str, str | None]]:
        """[(Id, Type, resolved target or the external URL, TargetMode)]"""
        rp = relpath(part)
        if not self.has(rp):
            return []
        out = []
        for r in self.tree(rp):
            if not isinstance(r.tag, str):
                continue
            ext = r.get("TargetMode") == "External"
            tgt = r.get("Target") or ""
            out.append(
                (r.get("Id") or "", r.get("Type") or "", tgt if ext else resolve(part, tgt), r.get("TargetMode"))
            )
        return out

    # -- editing ------------------------------------------------------------
    def add(self, name: str, data: bytes) -> None:
        if name in self.info and name not in self.removed:
            raise PatchError(f"internal error: part {name} already exists")
        if name not in self.names:
            self.names.append(name)
        self._over[name] = data
        self.removed.discard(name)
        self.added.add(name)

    def add_tree(self, name: str, root: El) -> None:
        self.add(name, DEFAULT_DECL + tostring(root))
        self.trees[name] = root
        self.dirty.add(name)

    def remove(self, name: str) -> None:
        for d in (self._over, self._cache, self.trees):
            d.pop(name, None)
        if name in self.names:
            self.names.remove(name)
        self.dirty.discard(name)
        if name in self.added:
            self.added.discard(name)
        else:
            self.removed.add(name)

    @property
    def changed(self) -> set[str]:
        """Parts whose bytes differ from the source, including added and removed ones."""
        return {n for n in self.dirty if n not in self.added} | self.added | self.removed

    # -- writing ------------------------------------------------------------
    def _serialise(self, name: str) -> bytes:
        old = self._over.get(name)
        if old is None:
            old = self._zip.read(name) if name in self.info else b""
        m = _DECL.match(old)
        return (m.group(0) if m else b"") + tostring(self.trees[name])

    def save(self) -> bytes:
        out = io.BytesIO()
        now = time.gmtime()[:6]
        with zipfile.ZipFile(out, "w") as zo:
            for n in self.names:
                o = self.info.get(n)
                data = self._serialise(n) if n in self.dirty else self.read(n)
                # a FRESH ZipInfo per entry: reusing the source's would carry a stale CRC and size
                zi = zipfile.ZipInfo(n, date_time=o.date_time if o else now)
                zi.compress_type = o.compress_type if o and o.compress_type in (0, 8) else zipfile.ZIP_DEFLATED
                zi.external_attr = o.external_attr if o else 0o644 << 16
                zi.create_system = o.create_system if o else 3
                zo.writestr(zi, data)
                if out.tell() > self.limits.max_output_bytes:
                    raise PatchError("the edited file would exceed the output size limit", reason="output_too_large")
        return out.getvalue()


# -- [Content_Types].xml and relationship helpers ---------------------------------


def ensure_default(pkg: Pkg, ext: str, ctype: str) -> None:
    ct = pkg.tree("[Content_Types].xml")
    for d in ct:
        if isinstance(d.tag, str) and d.tag.endswith("}Default") and (d.get("Extension") or "").lower() == ext:
            return
    from lxml import etree

    d = etree.Element(f"{{{CT_NS}}}Default")
    d.set("Extension", ext)
    d.set("ContentType", ctype)
    ct.insert(0, d)
    pkg.touch("[Content_Types].xml")


def add_override(pkg: Pkg, part: str, ctype: str) -> None:
    from lxml import etree

    ct = pkg.tree("[Content_Types].xml")
    o = etree.SubElement(ct, f"{{{CT_NS}}}Override")
    o.set("PartName", "/" + part)
    o.set("ContentType", ctype)
    pkg.touch("[Content_Types].xml")


def remove_override(pkg: Pkg, part: str) -> None:
    ct = pkg.tree("[Content_Types].xml")
    for o in [o for o in ct if o.get("PartName") == "/" + part]:
        ct.remove(o)
        pkg.touch("[Content_Types].xml")


def next_rid(rels_root: El) -> str:
    nums = [int(m.group(1)) for r in rels_root for m in [re.match(r"rId(\d+)$", r.get("Id") or "")] if m]
    return f"rId{max(nums or [0]) + 1}"


def add_rel(pkg: Pkg, part: str, rtype: str, target: str) -> str:
    """Add a relationship from `part` (creating its .rels part when absent); return its Id."""
    from lxml import etree

    rp = relpath(part)
    if not pkg.has(rp):
        pkg.add_tree(rp, etree.Element(f"{{{REL_NS}}}Relationships", nsmap={None: REL_NS}))  # type: ignore[dict-item]
    root = pkg.tree(rp)
    rid = next_rid(root)
    r = etree.SubElement(root, f"{{{REL_NS}}}Relationship")
    r.set("Id", rid)
    r.set("Type", rtype)
    r.set("Target", target)
    pkg.touch(rp)
    return rid


def relative_target(part: str, target: str) -> str:
    """The Target string for `target` as seen from `part`'s directory."""
    base = part.split("/")[:-1]
    tgt = target.split("/")
    i = 0
    while i < len(base) and i < len(tgt) - 1 and base[i] == tgt[i]:
        i += 1
    return "/".join([".."] * (len(base) - i) + tgt[i:])


def next_numbered(pkg: Pkg, pattern: str) -> int:
    """max N + 1 over parts matching `pattern` (a regex with one numeric group)."""
    rx = re.compile(pattern)
    return max([int(m.group(1)) for x in pkg.names for m in [rx.match(x)] if m] or [0]) + 1


def drop_orphans(pkg: Pkg, candidates: list[str | None]) -> list[str]:
    """Remove parts (with their .rels and content-type override) that no relationship
    points at any more, following what they pointed at in turn."""
    gone: list[str] = []
    todo = list(candidates)
    while todo:
        c = todo.pop()
        if not c or not pkg.has(c):
            continue
        refs = {t for n in pkg.names if n.endswith(".rels") for _i, _t, t, m in pkg.rels(owner(n)) if m != "External"}
        if c in refs:
            continue
        todo += [t for _i, _t, t, m in pkg.rels(c) if m != "External"]
        for n in (c, relpath(c)):
            if pkg.has(n):
                pkg.remove(n)
        remove_override(pkg, c)
        gone.append(c)
    return gone


def attr_any(el: El, suffix: str) -> Any:
    for k, v in el.attrib.items():
        if str(k).endswith(suffix):
            return v
    return None


def parent(el: El) -> El:
    p = el.getparent()
    if p is None:
        raise PatchError("internal error: element without a parent")
    return p


def add_media(pkg: Pkg, folder: str, data: bytes, ext: str, ctype: str) -> str:
    """Store an image as <folder>/imageN.<ext> and register its content type; return the part name."""
    n = next_numbered(pkg, re.escape(folder) + r"/image(\d+)\.")
    name = f"{folder}/image{n}.{ext}"
    pkg.add(name, data)
    ensure_default(pkg, ext, ctype)
    return name


def count_refs(root: El, rid: str) -> int:
    """How many relationship-id attributes in `root` equal `rid`."""
    return sum(1 for e in root.iter() for k, v in e.attrib.items() if str(k).startswith(f"{{{OD_REL}}}") and v == rid)
