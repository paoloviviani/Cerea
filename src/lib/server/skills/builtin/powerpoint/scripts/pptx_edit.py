"""pptx_edit - precise edits to a .pptx someone supplied, touching nothing else.

python-pptx load+save re-serialises every part and loses run formatting when
text spans runs. This helper rewrites only the parts it edits (lxml) and copies
the rest through byte for byte. Use generate.py for NEW decks. Slide numbers are
1-based; shape ids are those outline() prints. Duplicate/delete/reorder are in
pptx_slides.py; verify and diff_text in pptx_verify.py.

    import pptx_edit as pe
    pe.outline("/mnt/data/in.pptx")
    pe.replace_text("/mnt/data/in.pptx", "/mnt/output/out.pptx", "2025", "2026")
    pe.set_placeholder_text("/mnt/data/in.pptx", "/mnt/output/out.pptx", 1, "title", "Q3 review")
    pe.replace_image("/mnt/data/in.pptx", "/mnt/output/out.pptx", 2, 7, "/mnt/data/logo.png")

Chain edits by passing the previous output as the next source.
Licence: Apache-2.0. Original work.
"""

import copy
import os
import re
import tempfile
import time
import zipfile

from lxml import etree

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NSM = {"a": A_NS, "p": P_NS, "r": R_NS}
IMAGE_REL = R_NS + "/image"


def a(tag):
    return "{%s}%s" % (A_NS, tag)


def p_(tag):
    return "{%s}%s" % (P_NS, tag)


AP, AR, AT, ARPR, ABR = a("p"), a("r"), a("t"), a("rPr"), a("br")


class PatchError(Exception):
    """The edit was refused or the result failed verification."""


class _Pkg:
    def __init__(self, src):
        with zipfile.ZipFile(src) as z:
            bad = z.testzip()
            if bad:
                raise PatchError("%s: CRC failure in %s; the file is damaged" % (src, bad))
            self.names = [i.filename for i in z.infolist()]
            self.info = {i.filename: i for i in z.infolist()}
            self.data = {n: z.read(n) for n in self.names}
        self.trees, self.dirty = {}, set()

    def tree(self, name):
        if name not in self.trees:
            if name not in self.data:
                raise PatchError("part %s is missing; is this a .pptx?" % name)
            self.trees[name] = etree.fromstring(self.data[name])
        return self.trees[name]

    def touch(self, name):
        self.tree(name)
        self.dirty.add(name)

    def add(self, name, data):
        self.names.append(name)
        self.data[name] = data

    def remove(self, name):
        for d in (self.data, self.info, self.trees):
            d.pop(name, None)
        self.names.remove(name)
        self.dirty.discard(name)

    def save(self, dst):
        for n in self.dirty:
            m = re.match(rb"\s*<\?xml[^>]*\?>\s*", self.data[n])
            self.data[n] = (m.group(0) if m else b"") + etree.tostring(self.trees[n], encoding="UTF-8")
        os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
        fd, tmp = tempfile.mkstemp(suffix=".pptx", dir=os.path.dirname(os.path.abspath(dst)))
        os.close(fd)
        try:
            with zipfile.ZipFile(tmp, "w") as out:
                for n in self.names:  # a FRESH ZipInfo per entry: reusing the source's carries a stale CRC
                    o = self.info.get(n)
                    zi = zipfile.ZipInfo(n, date_time=o.date_time if o else time.localtime()[:6])
                    zi.compress_type = o.compress_type if o and o.compress_type in (0, 8) else zipfile.ZIP_DEFLATED
                    zi.external_attr = o.external_attr if o else 0o644 << 16
                    zi.create_system = o.create_system if o else 3
                    out.writestr(zi, self.data[n])
            os.replace(tmp, dst)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)


def _resolve(base, target):
    parts = [] if target.startswith("/") else base.split("/")[:-1]
    for s in target.lstrip("/").split("/"):
        if s == "..":
            parts and parts.pop()
        elif s != ".":
            parts.append(s)
    return "/".join(parts)


def _relpath(part):
    d, _, b = part.rpartition("/")
    return (d + "/" if d else "") + "_rels/" + b + ".rels"


def _rels(pkg, part):
    """[(Id, Type, resolved target or the external URL, TargetMode)]"""
    rp = _relpath(part)
    if rp not in pkg.data:
        return []
    return [(r.get("Id"), r.get("Type"), r.get("Target") if r.get("TargetMode") == "External" else _resolve(part, r.get("Target")),
             r.get("TargetMode")) for r in pkg.tree(rp)]


def _pres(pkg):
    for _, typ, tgt, _m in _rels(pkg, ""):
        if typ.endswith("/officeDocument"):
            return tgt
    raise PatchError("not a .pptx package (no presentation part)")


def _slides(pkg):
    """[(p:sldId element, slide part)] in deck order."""
    pres = _pres(pkg)
    rmap = {i: t for i, typ, t, m in _rels(pkg, pres)}
    return [(e, rmap[e.get("{%s}id" % R_NS)]) for e in pkg.tree(pres).find("p:sldIdLst", NSM)]


def _slide(pkg, n):
    slides = _slides(pkg)
    if not isinstance(n, int) or not 1 <= n <= len(slides):
        raise PatchError("the deck has %d slides (1-based); slide %r does not exist" % (len(slides), n))
    return slides[n - 1][1]


# ---- reading ----------------------------------------------------------------

def _shapes(parent):
    for el in parent:
        if el.tag in (p_("sp"), p_("pic"), p_("graphicFrame"), p_("cxnSp")):
            yield el
        elif el.tag == p_("grpSp"):
            yield el
            yield from _shapes(el)


def _cnv(el):
    return el.find(".//p:cNvPr", NSM)


def _ptext(p):
    out = []
    for c in p:
        if c.tag in (AR, a("fld")):
            out.append("".join(t.text or "" for t in c.findall(AT)))
        elif c.tag == ABR:
            out.append("\n")
    return "".join(out)


def _paras(el):
    return [_ptext(p) for p in el.iter(AP)]


def outline(path):
    """Slides in deck order: layout, shapes (id, name, kind, placeholder, text,
    position, picture part) and speaker notes."""
    pkg = _Pkg(path)
    slides = []
    for n, (_, part) in enumerate(_slides(pkg), 1):
        tree = pkg.tree(part)
        rels = _rels(pkg, part)
        rmap = {i: t for i, typ, t, m in rels}
        layout = next((t for i, typ, t, m in rels if typ.endswith("/slideLayout")), None)
        notes = next((t for i, typ, t, m in rels if typ.endswith("/notesSlide")), None)
        shapes = []
        for el in _shapes(tree.find(".//p:spTree", NSM)):
            c = _cnv(el)
            ph = el.find("./*[1]/p:nvPr/p:ph", NSM)
            kind = {"pic": "picture", "grpSp": "group", "cxnSp": "line"}.get(etree.QName(el).localname)
            if el.tag == p_("graphicFrame"):
                kind = "table" if el.find(".//a:tbl", NSM) is not None else ("chart" if el.find(".//{*}chart") is not None else "graphic")
            kind = kind or ("placeholder" if ph is not None else "text" if el.find("p:txBody", NSM) is not None else "shape")
            s = {"id": int(c.get("id")), "name": c.get("name"), "kind": kind}
            if ph is not None:
                s["placeholder"] = {"type": ph.get("type", "body"), "idx": int(ph.get("idx", 0))}
            if kind == "table":
                s["text"] = [[" / ".join(_paras(tc)) for tc in tr.findall("a:tc", NSM)] for tr in el.iter(a("tr"))]
            elif el.tag in (p_("sp"),):
                s["text"] = _paras(el)
            if kind == "picture":
                blip = el.find(".//a:blip", NSM)
                s["image"] = rmap.get(blip.get("{%s}embed" % R_NS)) if blip is not None else None
            xf = el.find("./p:spPr/a:xfrm", NSM)
            xf = xf if xf is not None else el.find("./p:xfrm", NSM)
            xf = xf if xf is not None else el.find("./p:grpSpPr/a:xfrm", NSM)
            if xf is not None and xf.find("a:off", NSM) is not None and xf.find("a:ext", NSM) is not None:
                s["box"] = [int(xf.find("a:off", NSM).get(k)) for k in ("x", "y")] + [int(xf.find("a:ext", NSM).get(k)) for k in ("cx", "cy")]
            shapes.append(s)
        ntext = "\n".join(_paras(pkg.tree(notes))) if notes else ""
        slides.append({"index": n, "part": part, "layout": layout and pkg.tree(layout).find("p:cSld", NSM).get("name"),
                       "shapes": shapes, "notes": re.sub(r"^\s*\d*\s*$", "", ntext, flags=re.M).strip()})
    return {"slides": slides}


# ---- the run engine ---------------------------------------------------------

def _rtext(r):
    return "".join(t.text or "" for t in r.findall(AT))


def _set_rtext(r, text, special=False):
    for c in list(r):
        if c.tag in (AT, ABR):
            r.remove(c)
    for i, line in enumerate(text.split("\n") if special else [text]):
        if i:
            etree.SubElement(r, ABR)
        t = etree.SubElement(r, AT)
        t.text = line


def _is_text(r):
    kinds = [c.tag for c in r]
    return AT in kinds and all(k in (ARPR, AT) for k in kinds)


def _segments(p):
    """Maximal sequences of adjacent plain-text runs: a match may span runs
    inside one sequence but never a line break or field."""
    segs, cur = [], []
    for c in p:
        if c.tag == AR and _is_text(c):
            cur.append(c)
        elif c.tag in (AR, a("fld"), ABR) and cur:
            segs.append(cur)
            cur = []
    return segs + ([cur] if cur else [])


def _split(r, k):
    t = _rtext(r)
    right = copy.deepcopy(r)
    _set_rtext(r, t[:k])
    _set_rtext(right, t[k:])
    r.addnext(right)
    return right


def _apply(seg, s, e, rep):
    def at(pos):
        o = 0
        for i, r in enumerate(seg):
            n = len(_rtext(r))
            if o <= pos < o + n:
                return i, o, n
            o += n

    i, o, n = at(s)
    if s > o:  # isolate the match: split the run it starts in, then the run it ends in
        seg.insert(i + 1, _split(seg[i], s - o))
        i += 1
    j, o, n = at(e - 1)
    if e < o + n:
        seg.insert(j + 1, _split(seg[j], e - o))
    cov = seg[i : j + 1]  # the replacement takes the FIRST matched run's formatting
    if rep:
        _set_rtext(cov[0], rep, True)
        cov = cov[1:]
    for r in cov:
        r.getparent().remove(r)


def _replace_para(p, rx, rep):
    n = 0
    for seg in _segments(p):
        text = "".join(_rtext(r) for r in seg)
        hits = [(m.start(), m.end()) for m in rx.finditer(text) if m.end() > m.start()]
        for s, e in reversed(hits):  # right to left keeps earlier offsets valid
            _apply(seg, s, e, rep)
            n += 1
    return n


def _run(src, dst, job):
    pkg = _Pkg(src)
    rep = job(pkg)
    pkg.save(dst)
    return {**rep, "changed_parts": sorted(pkg.dirty)}


def replace_text(src, dst, find, replace, slides=None, notes=False, match_case=True):
    """Replace every occurrence of `find` on the given slides (default all),
    in text boxes, placeholders, tables and groups, keeping run formatting even
    when the match spans runs. notes=True also edits speaker notes."""
    if not find:
        raise PatchError("find must be a non-empty string")
    rx = re.compile(re.escape(find), 0 if match_case else re.I)

    def job(pkg):
        by = {}
        for n, (_, part) in enumerate(_slides(pkg), 1):
            if slides is not None and n not in slides:
                continue
            targets = [part] + [t for i, typ, t, m in _rels(pkg, part) if notes and typ.endswith("/notesSlide")]
            for tp in targets:
                k = sum(_replace_para(p, rx, replace) for p in list(pkg.tree(tp).iter(AP)))
                if k:
                    by[tp] = k
                    pkg.touch(tp)
        if not by:
            raise PatchError("no match for %r on %s. Matching is %s and cannot cross a line break or field; copy the exact "
                             "text from outline()." % (find, "slides %s" % sorted(slides) if slides else "any slide",
                                                      "case-sensitive" if match_case else "case-insensitive"))
        return {"replaced": sum(by.values()), "by_part": by}

    return _run(src, dst, job)


def set_placeholder_text(src, dst, slide, placeholder, text):
    """Set a placeholder's text, one paragraph per line (or pass a list),
    keeping the first paragraph's and run's formatting. `placeholder` is its
    idx (int) or its type ("title", "body", "subTitle", ...) as outline() shows."""
    lines = list(text) if isinstance(text, (list, tuple)) else str(text).split("\n")

    def job(pkg):
        part = _slide(pkg, slide)
        hits, found = [], []
        for el in _shapes(pkg.tree(part).find(".//p:spTree", NSM)):
            ph = el.find("./*[1]/p:nvPr/p:ph", NSM)
            if ph is not None and el.tag == p_("sp"):
                typ, idx = ph.get("type", "body"), int(ph.get("idx", 0))
                found.append("%s (idx %d)" % (typ, idx))
                if (placeholder == idx) if isinstance(placeholder, int) else (typ == placeholder or (placeholder == "title" and typ == "ctrTitle")):
                    hits.append(el)
        if len(hits) != 1:
            raise PatchError("%s placeholder %r on slide %d; this slide has: %s" % ("no" if not hits else "several", placeholder, slide, ", ".join(found) or "none"))
        sp = hits[0]
        tx = sp.find("p:txBody", NSM)
        if tx is None:
            tx = etree.SubElement(sp, p_("txBody"))
            etree.SubElement(tx, a("bodyPr"))
            etree.SubElement(tx, a("lstStyle"))
            etree.SubElement(tx, AP)
        paras = tx.findall(AP)
        tp = next((p for p in paras if p.find(AR) is not None), paras[0])
        rpr = tp.find("%s/%s" % (AR, ARPR))
        for p in paras:
            tx.remove(p)
        for line in lines:
            np_ = copy.deepcopy(tp)
            for c in list(np_):
                if c.tag not in (a("pPr"), a("endParaRPr")):
                    np_.remove(c)
            if line:
                r = etree.Element(AR)
                if rpr is not None:
                    r.append(copy.deepcopy(rpr))
                _set_rtext(r, line)
                end = np_.find(a("endParaRPr"))
                (end.addprevious(r) if end is not None else np_.append(r))
            tx.append(np_)
        pkg.touch(part)
        return {"slide": slide, "paragraphs": len(lines)}

    return _run(src, dst, job)


# ---- pictures ---------------------------------------------------------------

def _image_info(b):
    """(extension, content type, width, height) from the bytes; png, jpeg, gif."""
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png", "image/png", int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big")
    if b[:4] == b"GIF8":
        return "gif", "image/gif", int.from_bytes(b[6:8], "little"), int.from_bytes(b[8:10], "little")
    if b[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(b):
            if b[i] != 0xFF:
                i += 1
                continue
            m = b[i + 1]
            if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                return "jpeg", "image/jpeg", int.from_bytes(b[i + 7 : i + 9], "big"), int.from_bytes(b[i + 5 : i + 7], "big")
            i += 2 + int.from_bytes(b[i + 2 : i + 4], "big")
    raise PatchError("the image is not a PNG, JPEG or GIF (or is damaged); convert it first")


def replace_image(src, dst, slide, shape, image, fit="cover"):
    """Swap the picture `shape` (id from outline()) on `slide` for `image` (a
    path or bytes), keeping its size, position, rotation and effects. fit="cover"
    crops the new image to the old frame's shape (no distortion), "stretch"
    squeezes it in. The old media file is removed when nothing else uses it."""
    if fit not in ("cover", "stretch"):
        raise PatchError("fit must be 'cover' or 'stretch'")
    blob = image if isinstance(image, (bytes, bytearray)) else open(image, "rb").read()
    ext, ctype, w_, h_ = _image_info(blob)

    def job(pkg):
        part = _slide(pkg, slide)
        tree = pkg.tree(part)
        pic = next((e for e in _shapes(tree.find(".//p:spTree", NSM)) if e.tag == p_("pic") and _cnv(e).get("id") == str(shape)), None)
        if pic is None:
            raise PatchError("no picture with id %r on slide %d; pictures here: %s" % (shape, slide, [
                e_.get("id") for e_ in tree.iterfind(".//p:pic/p:nvPicPr/p:cNvPr", NSM)]))
        if pic.find(".//{*}svgBlip") is not None:
            raise PatchError("this picture carries an SVG variant; replacing it is not supported")
        blip = pic.find(".//a:blip", NSM)
        old = blip.get("{%s}embed" % R_NS)
        old_target = next((t for i, typ, t, m in _rels(pkg, part) if i == old), None)
        n = max([int(m.group(1)) for x in pkg.names for m in [re.match(r"ppt/media/image(\d+)\.", x)] if m] or [0]) + 1
        media = "ppt/media/image%d.%s" % (n, ext)
        pkg.add(media, blob)
        ct = pkg.tree("[Content_Types].xml")
        if not any(d.get("Extension", "").lower() == ext for d in ct if d.tag.endswith("}Default")):
            d = etree.Element("{%s}Default" % ct.nsmap[None])
            d.set("Extension", ext)
            d.set("ContentType", ctype)
            ct.insert(0, d)
            pkg.touch("[Content_Types].xml")
        rt = pkg.tree(_relpath(part))
        rid = "rId%d" % (max([int(m.group(1)) for r in rt for m in [re.match(r"rId(\d+)$", r.get("Id", ""))] if m] or [0]) + 1)
        rel = etree.SubElement(rt, "{%s}Relationship" % rt.nsmap[None])
        rel.set("Id", rid)
        rel.set("Type", IMAGE_REL)
        rel.set("Target", "../media/image%d.%s" % (n, ext))
        blip.set("{%s}embed" % R_NS, rid)
        bf = blip.getparent()
        for c in bf.findall("a:srcRect", NSM):
            bf.remove(c)
        xf = pic.find("./p:spPr/a:xfrm/a:ext", NSM)
        cropped = False
        if fit == "cover" and xf is not None and int(xf.get("cx")) and int(xf.get("cy")):
            ia, ba = w_ / h_, int(xf.get("cx")) / int(xf.get("cy"))
            if abs(ia - ba) > 0.001:
                side = int((1 - (ba / ia if ia > ba else ia / ba)) / 2 * 100000)
                sr = etree.Element(a("srcRect"))
                for k in (("l", "r") if ia > ba else ("t", "b")):
                    sr.set(k, str(side))
                blip.addnext(sr)
                cropped = True
        if not any(v == old for e in tree.iter() for k, v in e.attrib.items() if k.startswith("{%s}" % R_NS)):
            for r in list(rt):
                if r.get("Id") == old:
                    rt.remove(r)
        pkg.touch(part)
        pkg.touch(_relpath(part))
        dropped = _drop_orphans(pkg, [old_target])
        return {"slide": slide, "shape": shape, "image": media, "cropped": cropped, "removed_media": dropped}

    return _run(src, dst, job)


def _owner(rels_name):
    d, _, b = rels_name.rpartition("_rels/")
    return d + b[:-5]


def _drop_orphans(pkg, candidates):
    """Remove parts (with their .rels and content-type override) that no
    relationship points at any more, following what they pointed at in turn."""
    gone, todo = [], list(candidates)
    while todo:
        c = todo.pop()
        refs = {t for n in pkg.names if n.endswith(".rels") for i, typ, t, m in _rels(pkg, _owner(n)) if m != "External"}
        if not c or c not in pkg.data or c in refs:
            continue
        todo += [t for i, typ, t, m in _rels(pkg, c) if m != "External"]
        for n in (c, _relpath(c)):
            if n in pkg.data:
                pkg.remove(n)
        ct = pkg.tree("[Content_Types].xml")
        for o in [o for o in ct if o.get("PartName") == "/" + c]:
            ct.remove(o)
            pkg.touch("[Content_Types].xml")
        gone.append(c)
    return gone
