"""PowerPoint (.pptx) engine: outline, read and typed edits that rewrite only the slide, notes,
presentation and relationship parts they touch. Every other part (layouts, masters, theme, media)
is copied through byte for byte. Ported from the Cerea 0.29.0 pptx helpers.

Slide numbers in every operation are 1-based and refer to the deck as it was before the request,
whatever earlier operations in the same request did."""

from __future__ import annotations

import copy
import difflib
import re
from collections.abc import Callable
from typing import Any

from lxml import etree

from .errors import PatchError
from .images_ref import ImageSet
from .pkg import (
    OD_REL,
    Pkg,
    add_media,
    add_override,
    add_rel,
    drop_orphans,
    next_numbered,
    owner,
    parent,
    relative_target,
    relpath,
    remove_override,
)
from .xmlsafe import El, parse

FORMAT = "pptx"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
R_NS = OD_REL
P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
NSM = {"a": A_NS, "p": P_NS, "r": R_NS}
IMAGE_REL = R_NS + "/image"
SLIDE_CT = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
NOTES_CT = "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"
COPYABLE = ("/slideLayout", "/image", "/video", "/audio", "/media", "/hdphoto", "/slide")
EMU_CM = 360000
EDITABLE = re.compile(
    r"^(ppt/slides/(_rels/)?[^/]+|ppt/notesSlides/(_rels/)?[^/]+|ppt/media/[^/]+|ppt/presentation\.xml"
    r"|ppt/_rels/presentation\.xml\.rels|\[Content_Types\]\.xml|ppt/(charts|embeddings|diagrams)/.+)$"
)


def a(tag: str) -> str:
    return f"{{{A_NS}}}{tag}"


def p_(tag: str) -> str:
    return f"{{{P_NS}}}{tag}"


AP, AR, AT, ARPR, ABR = a("p"), a("r"), a("t"), a("rPr"), a("br")


# ---- structure ----------------------------------------------------------------------


def _pres(pkg: Pkg) -> str:
    for _i, typ, tgt, _m in pkg.rels(""):
        if typ.endswith("/officeDocument"):
            return tgt
    raise PatchError("this is not a PowerPoint package (it has no presentation part)")


def _slides(pkg: Pkg) -> list[tuple[El, str]]:
    """[(p:sldId element, slide part)] in deck order."""
    pres = _pres(pkg)
    rmap = {i: t for i, _typ, t, _m in pkg.rels(pres)}
    lst = pkg.tree(pres).find("p:sldIdLst", NSM)
    out = []
    for e in lst if lst is not None else []:
        rid = e.get(f"{{{R_NS}}}id") or ""
        if rid not in rmap:
            raise PatchError("a slide in the deck points at a missing relationship")
        out.append((e, rmap[rid]))
    return out


def _shapes(parent_el: El) -> list[El]:
    out: list[El] = []
    for el in parent_el:
        if el.tag in (p_("sp"), p_("pic"), p_("graphicFrame"), p_("cxnSp")):
            out.append(el)
        elif el.tag == p_("grpSp"):
            out.append(el)
            out += _shapes(el)
    return out


def _sptree(tree: El) -> El:
    sp = tree.find(".//p:spTree", NSM)
    if sp is None:
        raise PatchError("a slide has no shape tree")
    return sp


def _cnv(el: El) -> El:
    c = el.find(".//p:cNvPr", NSM)
    if c is None:
        raise PatchError("a shape has no cNvPr")
    return c


def _ptext(p: El) -> str:
    out = []
    for c in p:
        if c.tag in (AR, a("fld")):
            out.append("".join(t.text or "" for t in c.findall(AT)))
        elif c.tag == ABR:
            out.append("\n")
    return "".join(out)


def _paras(el: El) -> list[str]:
    return [_ptext(p) for p in el.iter(AP)]


def _run_format(r: El) -> dict[str, Any]:
    rpr = r.find(ARPR)
    f: dict[str, Any] = {}
    if rpr is None:
        return f
    if rpr.get("b") is not None:
        f["bold"] = rpr.get("b") in ("1", "true")
    if rpr.get("i") is not None:
        f["italic"] = rpr.get("i") in ("1", "true")
    if rpr.get("u") not in (None, "none"):
        f["underline"] = True
    if rpr.get("sz") and (rpr.get("sz") or "").isdigit():
        f["size_pt"] = int(rpr.get("sz") or 0) / 100
    clr = rpr.find("a:solidFill/a:srgbClr", NSM)
    if clr is not None:
        f["color"] = clr.get("val")
    lat = rpr.find("a:latin", NSM)
    if lat is not None:
        f["font"] = lat.get("typeface")
    return f


def outline(pkg: Pkg) -> dict[str, Any]:
    """Slides in deck order: layout, shapes (id, name, kind, placeholder, text, position, picture part)
    and speaker notes."""
    slides = []
    for n, (_, part) in enumerate(_slides(pkg), 1):
        tree = pkg.tree(part)
        rels = pkg.rels(part)
        rmap = {i: t for i, _typ, t, _m in rels}
        layout = next((t for _i, typ, t, _m in rels if typ.endswith("/slideLayout")), None)
        notes = next((t for _i, typ, t, _m in rels if typ.endswith("/notesSlide")), None)
        shapes: list[dict[str, Any]] = []
        for el in _shapes(_sptree(tree)):
            c = _cnv(el)
            ph = el.find("./*[1]/p:nvPr/p:ph", NSM)
            kind: str | None = {"pic": "picture", "grpSp": "group", "cxnSp": "line"}.get(etree.QName(el).localname)
            if el.tag == p_("graphicFrame"):
                kind = (
                    "table"
                    if el.find(".//a:tbl", NSM) is not None
                    else ("chart" if el.find(".//{*}chart") is not None else "graphic")
                )
            kind = kind or (
                "placeholder" if ph is not None else "text" if el.find("p:txBody", NSM) is not None else "shape"
            )
            s: dict[str, Any] = {"id": int(c.get("id") or 0), "name": c.get("name"), "kind": kind}
            if ph is not None:
                s["placeholder"] = {"type": ph.get("type", "body"), "idx": int(ph.get("idx", "0"))}
            if kind == "table":
                s["text"] = [[" / ".join(_paras(tc)) for tc in tr.findall("a:tc", NSM)] for tr in el.iter(a("tr"))]
            elif el.tag == p_("sp"):
                s["text"] = _paras(el)
            if kind == "picture":
                blip = el.find(".//a:blip", NSM)
                s["image"] = rmap.get(blip.get(f"{{{R_NS}}}embed") or "") if blip is not None else None
            xf = el.find("./p:spPr/a:xfrm", NSM)
            if xf is None:
                xf = el.find("./p:xfrm", NSM)
            if xf is None:
                xf = el.find("./p:grpSpPr/a:xfrm", NSM)
            if xf is not None and xf.find("a:off", NSM) is not None and xf.find("a:ext", NSM) is not None:
                off, ext = xf.find("a:off", NSM), xf.find("a:ext", NSM)
                assert off is not None and ext is not None
                s["box"] = [int(off.get(k) or 0) for k in ("x", "y")] + [int(ext.get(k) or 0) for k in ("cx", "cy")]
            shapes.append(s)
        ntext = "\n".join(_paras(pkg.tree(notes))) if notes else ""
        lay = pkg.tree(layout).find("p:cSld", NSM) if layout else None
        slides.append(
            {
                "index": n,
                "part": part,
                "layout": lay.get("name") if lay is not None else None,
                "shapes": shapes,
                "notes": re.sub(r"^\s*\d*\s*$", "", ntext, flags=re.MULTILINE).strip(),
            }
        )
    sz = pkg.tree(_pres(pkg)).find("p:sldSz", NSM)
    out: dict[str, Any] = {"slides": slides}
    if sz is not None:
        out["slide_size_cm"] = [round(int(sz.get("cx") or 0) / EMU_CM, 2), round(int(sz.get("cy") or 0) / EMU_CM, 2)]
    return out


def read(pkg: Pkg, targets: list[dict[str, Any]]) -> dict[str, Any]:
    slides = _slides(pkg)
    out = []
    for t in targets:
        n = t["slide"]
        if not 1 <= n <= len(slides):
            raise PatchError(f"the deck has {len(slides)} slides (1-based); slide {n!r} does not exist")
        part = slides[n - 1][1]
        shapes = []
        for el in _shapes(_sptree(pkg.tree(part))):
            if el.tag != p_("sp") and el.tag != p_("graphicFrame"):
                continue
            paras = [
                {
                    "text": _ptext(p),
                    "runs": [
                        {"text": "".join(x.text or "" for x in r.findall(AT)), **_run_format(r)} for r in p.findall(AR)
                    ],
                }
                for p in el.iter(AP)
            ]
            if any(p["text"] for p in paras):
                shapes.append({"id": int(_cnv(el).get("id") or 0), "name": _cnv(el).get("name"), "paragraphs": paras})
        notes = next((tg for _i, typ, tg, _m in pkg.rels(part) if typ.endswith("/notesSlide")), None)
        out.append(
            {"slide": n, "shapes": shapes, "notes": [p for p in _paras(pkg.tree(notes)) if p.strip()] if notes else []}
        )
    return {"targets": out}


# ---- session ------------------------------------------------------------------------------


class Session:
    def __init__(self, pkg: Pkg, images: ImageSet) -> None:
        self.pkg, self.images = pkg, images
        slides = _slides(pkg)
        self.ids: list[El] = [e for e, _ in slides]
        self.parts: list[str | None] = [p for _, p in slides]
        self.copies: list[tuple[El, int]] = []  # (sldId of a copy, original number it follows)

    def part(self, n: int) -> str:
        if not isinstance(n, int) or not 1 <= n <= len(self.ids):
            raise PatchError(f"the deck has {len(self.ids)} slides (1-based); slide {n!r} does not exist")
        p = self.parts[n - 1]
        if p is None:
            raise PatchError(f"slide {n} was deleted by an earlier operation in this request")
        return p


# ---- the run engine --------------------------------------------------------------------------


def _rtext(r: El) -> str:
    return "".join(t.text or "" for t in r.findall(AT))


def _set_rtext(r: El, text: str, special: bool = False) -> None:
    for c in list(r):
        if c.tag in (AT, ABR):
            r.remove(c)
    for i, line in enumerate(text.split("\n") if special else [text]):
        if i:
            etree.SubElement(r, ABR)
        t = etree.SubElement(r, AT)
        t.text = line


def _is_text(r: El) -> bool:
    kinds = [c.tag for c in r]
    return AT in kinds and all(k in (ARPR, AT) for k in kinds)


def _segments(p: El) -> list[list[El]]:
    segs: list[list[El]] = []
    cur: list[El] = []
    for c in p:
        if c.tag == AR and _is_text(c):
            cur.append(c)
        elif c.tag in (AR, a("fld"), ABR) and cur:
            segs.append(cur)
            cur = []
    return segs + ([cur] if cur else [])


def _split(r: El, k: int) -> El:
    t = _rtext(r)
    right = copy.deepcopy(r)
    _set_rtext(r, t[:k])
    _set_rtext(right, t[k:])
    r.addnext(right)
    return right


def _apply(seg: list[El], s: int, e: int, rep: str) -> None:
    def at(pos: int) -> tuple[int, int, int]:
        o = 0
        for i, r in enumerate(seg):
            n = len(_rtext(r))
            if o <= pos < o + n:
                return i, o, n
            o += n
        raise PatchError("internal error: match outside its runs")

    i, o, n = at(s)
    if s > o:
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
        parent(r).remove(r)


def _replace_para(p: El, rx: re.Pattern[str], rep: str) -> int:
    n = 0
    for seg in _segments(p):
        text = "".join(_rtext(r) for r in seg)
        hits = [(m.start(), m.end()) for m in rx.finditer(text) if m.end() > m.start()]
        for s, e in reversed(hits):
            _apply(seg, s, e, rep)
            n += 1
    return n


def op_replace_text(ctx: Session, args: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    find, rep, slides = args["find"], args["replace"], args.get("slides")
    match_case = args.get("match_case", True)
    rx = re.compile(re.escape(find), 0 if match_case else re.IGNORECASE)
    wanted = [(n, ctx.part(n)) for n in slides] if slides is not None else [(0, part) for _e, part in _slides(pkg)]
    by: dict[str, int] = {}
    for _n, part in wanted:
        targets = [part] + [t for _i, typ, t, _m in pkg.rels(part) if args.get("notes") and typ.endswith("/notesSlide")]
        for tp in targets:
            k = sum(_replace_para(p, rx, rep) for p in list(pkg.tree(tp).iter(AP)))
            if k:
                by[tp] = k
                pkg.touch(tp)
    if not by:
        raise PatchError(
            f"no match for {find!r} on {'slides ' + str(sorted(slides)) if slides else 'any slide'}. Matching is "
            f"{'case-sensitive' if match_case else 'case-insensitive'} and cannot cross a line break or field; "
            "copy the exact text from the outline."
        )
    return {"replaced": sum(by.values()), "by_part": by}


def _set_lines(tx: El, lines: list[str]) -> None:
    paras = tx.findall(AP)
    tp = next((p for p in paras if p.find(AR) is not None), paras[0])
    rpr = tp.find(f"{AR}/{ARPR}")
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
            if end is not None:
                end.addprevious(r)
            else:
                np_.append(r)
        tx.append(np_)


def _txbody(sp: El) -> El:
    tx = sp.find("p:txBody", NSM)
    if tx is None:
        tx = etree.SubElement(sp, p_("txBody"))
        etree.SubElement(tx, a("bodyPr"))
        etree.SubElement(tx, a("lstStyle"))
        etree.SubElement(tx, AP)
    return tx


def _lines(text: Any) -> list[str]:
    return [str(x) for x in text] if isinstance(text, list) else str(text).split("\n")


def op_set_placeholder_text(ctx: Session, args: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    slide, placeholder = args["slide"], args["placeholder"]
    lines = _lines(args["text"])
    part = ctx.part(slide)
    hits: list[El] = []
    found: list[str] = []
    for el in _shapes(_sptree(pkg.tree(part))):
        ph = el.find("./*[1]/p:nvPr/p:ph", NSM)
        if ph is not None and el.tag == p_("sp"):
            typ, idx = ph.get("type", "body"), int(ph.get("idx", "0"))
            found.append(f"{typ} (idx {idx})")
            if (
                (placeholder == idx)
                if isinstance(placeholder, int)
                else (typ == placeholder or (placeholder == "title" and typ == "ctrTitle"))
            ):
                hits.append(el)
    if len(hits) != 1:
        raise PatchError(
            f"{'no' if not hits else 'several'} placeholder {placeholder!r} on slide {slide}; this slide has: {', '.join(found) or 'none'}"
        )
    _set_lines(_txbody(hits[0]), lines)
    pkg.touch(part)
    return {"slide": slide, "paragraphs": len(lines)}


# ---- pictures ---------------------------------------------------------------------------------


def _add_image_part(ctx: Session, part: str, img: Any) -> tuple[str, str]:
    media = add_media(ctx.pkg, "ppt/media", img.data, img.info.ext, img.info.content_type)
    rid = add_rel(ctx.pkg, part, IMAGE_REL, relative_target(part, media))
    return media, rid


def op_replace_image(ctx: Session, args: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    slide, shape, fit = args["slide"], args["shape"], args.get("fit", "cover")
    img = ctx.images.get(args["image"])
    part = ctx.part(slide)
    tree = pkg.tree(part)
    pic = next((e for e in _shapes(_sptree(tree)) if e.tag == p_("pic") and _cnv(e).get("id") == str(shape)), None)
    if pic is None:
        raise PatchError(
            f"no picture with id {shape!r} on slide {slide}; pictures here: "
            f"{[e_.get('id') for e_ in tree.iterfind('.//p:pic/p:nvPicPr/p:cNvPr', NSM)]}"
        )
    if pic.find(".//{*}svgBlip") is not None:
        raise PatchError("this picture carries an SVG variant; replacing it is not supported")
    blip = pic.find(".//a:blip", NSM)
    if blip is None:
        raise PatchError("this picture has no image reference")
    old = blip.get(f"{{{R_NS}}}embed")
    old_target = next((t for i, _typ, t, _m in pkg.rels(part) if i == old), None)
    media, rid = _add_image_part(ctx, part, img)
    rt = pkg.tree(relpath(part))
    blip.set(f"{{{R_NS}}}embed", rid)
    bf = parent(blip)
    for c in bf.findall("a:srcRect", NSM):
        bf.remove(c)
    xf = pic.find("./p:spPr/a:xfrm/a:ext", NSM)
    cropped = False
    if fit == "cover" and xf is not None and int(xf.get("cx") or 0) and int(xf.get("cy") or 0):
        ia, ba = img.info.width / img.info.height, int(xf.get("cx") or 1) / int(xf.get("cy") or 1)
        if abs(ia - ba) > 0.001:
            side = int((1 - (ba / ia if ia > ba else ia / ba)) / 2 * 100000)
            sr = etree.Element(a("srcRect"))
            for k in ("l", "r") if ia > ba else ("t", "b"):
                sr.set(k, str(side))
            blip.addnext(sr)
            cropped = True
    if not any(v == old for e in tree.iter() for k, v in e.attrib.items() if str(k).startswith(f"{{{R_NS}}}")):
        for r in list(rt):
            if r.get("Id") == old:
                rt.remove(r)
    pkg.touch(part)
    pkg.touch(relpath(part))
    dropped = drop_orphans(pkg, [old_target])
    return {"slide": slide, "shape": shape, "image": media, "cropped": cropped, "removed_media": dropped}


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")


def op_insert_image(ctx: Session, args: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    slide = args["slide"]
    img = ctx.images.get(args["image"])
    part = ctx.part(slide)
    sz = pkg.tree(_pres(pkg)).find("p:sldSz", NSM)
    sw, sh = (int(sz.get("cx") or 0), int(sz.get("cy") or 0)) if sz is not None else (9144000, 6858000)
    box = args.get("box", {})
    aspect = img.info.width / img.info.height
    w_ = int(box["width"] * EMU_CM) if "width" in box else None
    h_ = int(box["height"] * EMU_CM) if "height" in box else None
    if w_ is None and h_ is None:  # fit inside 80% of the slide
        w_ = int(min(sw * 0.8, sh * 0.8 * aspect))
    if w_ is None:
        w_ = int((h_ or 1) * aspect)
    if h_ is None:
        h_ = int(w_ / aspect)
    x = int(box["x"] * EMU_CM) if "x" in box else (sw - w_) // 2
    y = int(box["y"] * EMU_CM) if "y" in box else (sh - h_) // 2
    media, rid = _add_image_part(ctx, part, img)
    tree = pkg.tree(part)
    tree_sp = _sptree(tree)
    pid = max([int(e.get("id") or 0) for e in tree.iter(p_("cNvPr")) if (e.get("id") or "").isdigit()] or [0]) + 1
    xml = (
        f'<p:pic xmlns:p="{P_NS}" xmlns:a="{A_NS}" xmlns:r="{R_NS}"><p:nvPicPr>'
        f'<p:cNvPr id="{pid}" name="Picture {pid}" descr="{_esc(args.get("alt", ""))}"/>'
        '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
        f'<p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w_}" cy="{h_}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    )
    pic = parse(xml.encode(), "picture")
    ext = tree_sp.find("p:extLst", NSM)
    if ext is not None:
        ext.addprevious(pic)
    else:
        tree_sp.append(pic)
    pkg.touch(part)
    return {"slide": slide, "shape": pid, "image": media, "box_cm": [round(v / EMU_CM, 2) for v in (x, y, w_, h_)]}


# ---- slides -------------------------------------------------------------------------------------


def _sections(root: El) -> list[El]:
    return root.findall(f".//{{{P14}}}section")


def _section_ids(sec: El) -> list[El]:
    return sec.findall(f".//{{{P14}}}sldId")


def op_duplicate_slide(ctx: Session, args: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    slide = args["slide"]
    part = ctx.part(slide)
    rels = pkg.rels(part)
    bad = [
        typ.rsplit("/", 1)[1]
        for _i, typ, _t, m in rels
        if m != "External" and not typ.endswith(COPYABLE) and not typ.endswith("/notesSlide")
    ]
    if bad:
        raise PatchError(
            f"slide {slide} has {', '.join(sorted(set(bad)))} content that cannot be duplicated safely (two slides would "
            "share one part); rebuild that slide or ask the person to copy it in PowerPoint"
        )
    n = next_numbered(pkg, r"ppt/slides/slide(\d+)\.xml$")
    new = f"ppt/slides/slide{n}.xml"
    pkg.add(new, pkg.read(part))
    rp = pkg.tree(relpath(part))
    copy_rels = etree.fromstring(etree.tostring(rp))
    for r in list(copy_rels):
        if (r.get("Type") or "").endswith("/notesSlide"):
            copy_rels.remove(r)
    pkg.add(relpath(new), etree.tostring(copy_rels, xml_declaration=True, encoding="UTF-8", standalone=True))
    pres = _pres(pkg)
    rid = add_rel(pkg, pres, R_NS + "/slide", relative_target(pres, new))
    root = pkg.tree(pres)
    lst = root.find("p:sldIdLst", NSM)
    assert lst is not None
    old = ctx.ids[slide - 1]
    sid = etree.Element(p_("sldId"))
    sid.set("id", str(max(int(e.get("id") or 0) for e in lst) + 1))
    sid.set(f"{{{R_NS}}}id", rid)
    after = old
    for el, src_n in ctx.copies:  # keep several copies of one slide in the order they were made
        if src_n == slide and el.getparent() is lst:
            after = el
    after.addnext(sid)
    for sec in _sections(root):  # keep the copy in the same section as the original
        for e in _section_ids(sec):
            if e.get("id") == after.get("id"):
                twin = etree.Element(e.tag)
                twin.set("id", sid.get("id") or "")
                e.addnext(twin)
                break
    add_override(pkg, new, SLIDE_CT)
    pkg.touch(pres)
    ctx.copies.append((sid, slide))
    position = [e for e in lst].index(sid) + 1
    return {"slide": slide, "new_slide_position": position, "part": new}


def op_delete_slide(ctx: Session, args: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    slide = args["slide"]
    part = ctx.part(slide)
    pres = _pres(pkg)
    root = pkg.tree(pres)
    lst = root.find("p:sldIdLst", NSM)
    assert lst is not None
    if len(lst) <= 1:
        raise PatchError("the deck would be left with no slides; a presentation needs at least one")
    notes = [t for _i, typ, t, _m in pkg.rels(part) if typ.endswith("/notesSlide")]
    own = {relpath(x) for x in [part, pres, *notes]}
    for n in pkg.names:
        if n.endswith(".rels") and n not in own and any(t == part for _i, _typ, t, _m in pkg.rels(owner(n))):
            raise PatchError(f"{owner(n)} links to slide {slide}; remove that link first, then delete the slide")
    el = ctx.ids[slide - 1]
    rid = el.get(f"{{{R_NS}}}id")
    for e in list(root.iter(f"{{{P14}}}sldId")):
        if e.get("id") == el.get("id"):
            parent(e).remove(e)
    for e in list(root.iter(p_("sld"))):  # custom shows
        if e.get(f"{{{R_NS}}}id") == rid:
            parent(e).remove(e)
    parent(el).remove(el)
    prt = pkg.tree(relpath(pres))
    for r in list(prt):
        if r.get("Id") == rid:
            prt.remove(r)
    skip = ("/slideLayout", "/slideMaster", "/theme", "/notesMaster", "/slide")
    children = [
        t for n in [part, *notes] for _i, typ, t, m in pkg.rels(n) if m != "External" and not typ.endswith(skip)
    ]
    for n in [part, *notes]:  # owned by the slide: removed with it
        for x in (n, relpath(n)):
            if pkg.has(x):
                pkg.remove(x)
        remove_override(pkg, n)
    dropped = drop_orphans(pkg, list(children))
    for x in (pres, relpath(pres), "[Content_Types].xml"):
        pkg.touch(x)
    ctx.parts[slide - 1] = None
    return {"deleted": slide, "part": part, "removed_parts": [part, *notes, *dropped]}


def op_reorder_slides(ctx: Session, args: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    order: list[int] = args["order"]
    pres = _pres(pkg)
    root = pkg.tree(pres)
    lst = root.find("p:sldIdLst", NSM)
    assert lst is not None
    present = [n for n, e in enumerate(ctx.ids, 1) if e.getparent() is lst]
    if sorted(order) != present:
        raise PatchError(
            f"order must list each remaining slide number exactly once: {present} (slide numbers are those of the original deck); "
            f"got {order}"
        )
    new: list[El] = [el for el, src in ctx.copies if src == 0 and el.getparent() is lst]  # added as the first slide
    for n in order:
        new.append(ctx.ids[n - 1])
        new += [el for el, src in ctx.copies if src == n and el.getparent() is lst]  # copies stay behind their source
    items = list(lst)
    for e in items:
        lst.remove(e)
    for e in new:
        lst.append(e)
    ids = [e.get("id") for e in new]
    pos = 0
    for sec in _sections(root):
        members = _section_ids(sec)
        chunk = ids[pos : pos + len(members)]
        if set(chunk) != {e.get("id") for e in members}:
            raise PatchError(
                "this deck has sections and that order moves a slide from one section to another; reorder within "
                "each section, or tell the person"
            )
        par = members[0].getparent() if members else None
        by = {e.get("id"): e for e in members}
        for e in members:
            if par is not None:
                par.remove(e)
        for i in chunk:
            if par is not None:
                par.append(by[i])
        pos += len(members)
    pkg.touch(pres)
    return {"order": list(order)}


def _notes_master(pkg: Pkg) -> str | None:
    return next((t for _i, typ, t, _m in pkg.rels(_pres(pkg)) if typ.endswith("/notesMaster")), None)


_NOTES_XML = (
    f'<p:notes xmlns:a="{A_NS}" xmlns:r="{R_NS}" xmlns:p="{P_NS}"><p:cSld><p:spTree>'
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>'
    '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>'
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"
)


def op_set_notes(ctx: Session, args: dict[str, Any]) -> dict[str, Any]:
    slide = args["slide"]
    lines = _lines(args["text"])
    created = write_notes(ctx.pkg, ctx.part(slide), lines, slide)
    return {"slide": slide, "paragraphs": len(lines), "notes_page_created": created}


def write_notes(pkg: Pkg, part: str, lines: list[str], slide: Any) -> bool:
    """Put `lines` on the notes page of the slide part `part` (creating the page when the deck has a notes master);
    returns whether the page was created."""
    notes = next((t for _i, typ, t, _m in pkg.rels(part) if typ.endswith("/notesSlide")), None)
    created = False
    if notes is None:
        master = _notes_master(pkg)
        if master is None:
            raise PatchError(
                "this deck has no notes master, so a notes page cannot be created safely; add notes in PowerPoint once, "
                "or edit a slide that already has notes"
            )
        n = next_numbered(pkg, r"ppt/notesSlides/notesSlide(\d+)\.xml$")
        notes = f"ppt/notesSlides/notesSlide{n}.xml"
        pkg.add_tree(notes, parse(_NOTES_XML.encode(), "notes"))
        add_override(pkg, notes, NOTES_CT)
        add_rel(pkg, notes, R_NS + "/notesMaster", relative_target(notes, master))
        add_rel(pkg, notes, R_NS + "/slide", relative_target(notes, part))
        add_rel(pkg, part, R_NS + "/notesSlide", relative_target(part, notes))
        created = True
    tree = pkg.tree(notes)
    body = next(
        (
            el
            for el in _shapes(_sptree(tree))
            if el.tag == p_("sp")
            and (ph := el.find("./*[1]/p:nvPr/p:ph", NSM)) is not None
            and ph.get("type") == "body"
        ),
        None,
    )
    if body is None:
        raise PatchError(f"the notes page of slide {slide} has no body placeholder to put text in")
    _set_lines(_txbody(body), lines)
    pkg.touch(notes)
    return created


def _schema(props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"op": {"type": "string"}, **props},
        "required": ["op", *required],
        "additionalProperties": False,
    }


_SLIDE = {"type": "integer", "minimum": 1}
_TEXT = {"anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]}
_CM = {"type": "number", "minimum": 0, "maximum": 1000}
_SLIDE_SPEC = {"type": "object", "description": "one slide, exactly as doc_create takes it in `slides`"}


def _slide_ops() -> Any:
    """The whole-slide operations build with python-pptx; it is loaded only when one is used."""
    from . import slide_ops

    return slide_ops


OPS: dict[str, tuple[dict[str, Any], Callable[[Session, dict[str, Any]], dict[str, Any]]]] = {
    "replace_text": (
        _schema(
            {
                "find": {"type": "string", "minLength": 1},
                "replace": {"type": "string"},
                "slides": {"type": "array", "items": _SLIDE, "minItems": 1},
                "notes": {"type": "boolean"},
                "match_case": {"type": "boolean"},
            },
            ["find", "replace"],
        ),
        op_replace_text,
    ),
    "set_placeholder_text": (
        _schema(
            {
                "slide": _SLIDE,
                "placeholder": {"anyOf": [{"type": "integer", "minimum": 0}, {"type": "string", "minLength": 1}]},
                "text": _TEXT,
            },
            ["slide", "placeholder", "text"],
        ),
        op_set_placeholder_text,
    ),
    "replace_image": (
        _schema(
            {
                "slide": _SLIDE,
                "shape": {"type": "integer", "minimum": 0},
                "image": {"type": "string"},
                "fit": {"enum": ["cover", "stretch"]},
            },
            ["slide", "shape", "image"],
        ),
        op_replace_image,
    ),
    "insert_image": (
        _schema(
            {
                "slide": _SLIDE,
                "image": {"type": "string"},
                "box": {
                    "type": "object",
                    "properties": {
                        "x": _CM,
                        "y": _CM,
                        "width": {**_CM, "exclusiveMinimum": 0},
                        "height": {**_CM, "exclusiveMinimum": 0},
                    },
                    "additionalProperties": False,
                },
                "alt": {"type": "string"},
            },
            ["slide", "image"],
        ),
        op_insert_image,
    ),
    "duplicate_slide": (_schema({"slide": _SLIDE}, ["slide"]), op_duplicate_slide),
    "delete_slide": (_schema({"slide": _SLIDE}, ["slide"]), op_delete_slide),
    "reorder_slides": (
        _schema({"order": {"type": "array", "items": _SLIDE, "minItems": 1}}, ["order"]),
        op_reorder_slides,
    ),
    "set_notes": (_schema({"slide": _SLIDE, "text": _TEXT}, ["slide", "text"]), op_set_notes),
    "replace_slide": (
        _schema({"slide": _SLIDE, "spec": _SLIDE_SPEC}, ["slide", "spec"]),
        lambda ctx, args: _slide_ops().op_replace_slide(ctx, args),
    ),
    "add_slide": (
        _schema(
            {"after": {"type": "integer", "minimum": 0, "description": "0: first"}, "spec": _SLIDE_SPEC},
            ["after", "spec"],
        ),
        lambda ctx, args: _slide_ops().op_add_slide(ctx, args),
    ),
    "update_shape": (
        _schema(
            {
                "slide": _SLIDE,
                "shape": {"type": "integer", "minimum": 0},
                "x_cm": _CM,
                "y_cm": _CM,
                "w_cm": _CM,
                "h_cm": _CM,
            },
            ["slide", "shape"],
        ),
        lambda ctx, args: _slide_ops().op_update_shape(ctx, args),
    ),
}
DEFERRED = ["insert_chart", "insert_image into a picture placeholder"]


def start(pkg: Pkg, track: bool, author: str, images: ImageSet) -> Session:
    if track:
        raise PatchError("track_changes is only available for Word documents")
    return Session(pkg, images)


def finish(ctx: Session) -> dict[str, Any]:
    return {}


def _diff_lines(pkg: Pkg) -> list[str]:
    o = outline(pkg)
    out = ["order: " + ", ".join(s["part"].rsplit("/", 1)[1] for s in o["slides"])]
    for s in o["slides"]:
        name = s["part"].rsplit("/", 1)[1]
        for sh in s["shapes"]:
            txt = sh.get("text")
            txt = " | ".join(" / ".join(r) for r in txt) if sh["kind"] == "table" else " / ".join(txt or [])
            if sh.get("image"):
                txt = "[picture {}]".format(sh["image"].rsplit("/", 1)[1])
            if txt:
                out.append(f"{name} #{sh['id']} {sh['name']}: {txt}")
        if s["notes"]:
            out.append(f"{name} notes: " + s["notes"].replace("\n", " / "))
    return out


def diff_text(a_: Pkg, b_: Pkg) -> list[str]:
    d = [
        x
        for x in difflib.unified_diff(_diff_lines(a_), _diff_lines(b_), lineterm="", n=0)
        if not x.startswith(("---", "+++", "@@"))
    ]
    return [x[0] + " " + x[1:] for x in d]


def summary(pkg: Pkg) -> dict[str, Any]:
    return {"slides": len(_slides(pkg))}
