"""Word (.docx) engine: outline, read and typed edits that rewrite only the body, headers and
footers they touch (plus media, relationships and content types for images). Every other part is
copied through byte for byte. Ported from the Cerea 0.29.0 docx helpers."""

from __future__ import annotations

import copy
import datetime as _dt
import difflib
import re
from collections.abc import Callable, Iterator
from typing import Any

from lxml import etree

from .errors import PatchError
from .images_ref import ImageSet
from .pkg import (
    OD_REL,
    Pkg,
    add_media,
    add_rel,
    count_refs,
    drop_orphans,
    parent,
    relative_target,
    resolve,
)
from .xmlsafe import El

FORMAT = "docx"
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
PLACEHOLDER = r"\{\{\s*([^{}]+?)\s*\}\}"
IMAGE_REL = OD_REL + "/image"
EMU_PER_CM = 360000
EDITABLE = re.compile(
    r"^(word/(document|header\d*|footer\d*)\.xml|word/media/[^/]+|word/_rels/document\.xml\.rels|\[Content_Types\]\.xml)$"
)


def _attr_ids(root: El) -> list[str]:
    return [str(e.get(w("id")) or "") for e in root.iter() if e.get(w("id")) is not None]


def w(tag: str) -> str:
    return f"{{{W_NS}}}{tag}"


P, R, T, RPR, TBL, TR, TC = (w(x) for x in ("p", "r", "t", "rPr", "tbl", "tr", "tc"))
_TEXTUAL = {w(x) for x in ("rPr", "t", "tab", "br", "cr", "noBreakHyphen")}
_REV = {w(x) for x in ("ins", "del", "moveFrom", "moveTo", "rPrChange")}


# ---- structure --------------------------------------------------------------


def _main(pkg: Pkg) -> str:
    for _i, typ, tgt, _m in pkg.rels(""):
        if typ.endswith("/officeDocument"):
            return tgt
    raise PatchError("this is not a Word package (it has no main document part)")


def _related(pkg: Pkg, kind: str) -> list[str]:
    main = _main(pkg)
    return [t for _i, typ, t, m in pkg.rels(main) if typ.endswith("/" + kind) and m != "External"]


def _content_parts(pkg: Pkg) -> list[str]:
    return [_main(pkg), *sorted(_related(pkg, "header") + _related(pkg, "footer"))]


def _styles(pkg: Pkg) -> dict[str, tuple[str, str | None, bool]]:
    out: dict[str, tuple[str, str | None, bool]] = {}
    for part in _related(pkg, "styles"):
        for s in pkg.tree(part).findall(w("style")):
            nm = s.find(w("name"))
            sid = s.get(w("styleId")) or ""
            out[sid] = (
                nm.get(w("val")) or sid if nm is not None else sid,
                s.get(w("type")),
                s.get(w("default")) == "1",
            )
    return out


def _flat(parent_el: El) -> Iterator[El]:
    for el in parent_el:
        if el.tag in (P, TBL):
            yield el
        elif el.tag == w("sdt"):
            c = el.find(w("sdtContent"))
            if c is not None:
                yield from _flat(c)


def _body(pkg: Pkg) -> El:
    b = pkg.tree(_main(pkg)).find(w("body"))
    if b is None:
        raise PatchError("the main document part has no body")
    return b


def _live(r: El, p: El) -> bool:
    """True when run r belongs to paragraph p itself (not a nested one) and is not deleted."""
    for a in r.iterancestors():
        if a is p:
            return True
        if a.tag in (P, w("del"), w("moveFrom")):
            return False
    return False


def _ptext(p: El) -> str:
    out: list[str] = []
    for r in p.iter(R):
        if _live(r, p):
            for c in r:
                if c.tag == T:
                    out.append(c.text or "")
                else:
                    out.append({w("tab"): "\t", w("br"): "\n", w("cr"): "\n"}.get(c.tag, ""))
    return "".join(out)


def _pstyle(p: El, names: dict[str, tuple[str, str | None, bool]]) -> str:
    e = p.find(f"{w('pPr')}/{w('pStyle')}")
    if e is not None:
        v = e.get(w("val")) or ""
        return names.get(v, (v,))[0]
    return next((n for n, t, d in names.values() if d and t == "paragraph"), "Normal")


def _ctext(tc: El) -> str:
    return "\n".join(_ptext(p) for p in tc.findall(P))


def _blips(pkg: Pkg) -> list[El]:
    return [b for b in _body(pkg).iter(f"{{{A_NS}}}blip") if b.get(f"{{{OD_REL}}}embed")]


def _run_format(r: El) -> dict[str, Any]:
    rpr = r.find(RPR)
    f: dict[str, Any] = {}
    if rpr is None:
        return f

    def on(tag: str) -> bool | None:
        e = rpr.find(w(tag))
        if e is None:
            return None
        return (e.get(w("val")) or "true") not in ("0", "false", "off")

    for key, tag in (("bold", "b"), ("italic", "i"), ("strike", "strike")):
        v = on(tag)
        if v is not None:
            f[key] = v
    u = rpr.find(w("u"))
    if u is not None and u.get(w("val")) != "none":
        f["underline"] = True
    c = rpr.find(w("color"))
    if c is not None and c.get(w("val")) not in (None, "auto"):
        f["color"] = c.get(w("val"))
    sz = rpr.find(w("sz"))
    if sz is not None and (sz.get(w("val")) or "").isdigit():
        f["size_pt"] = int(sz.get(w("val")) or 0) / 2
    rf = rpr.find(w("rFonts"))
    if rf is not None and rf.get(w("ascii")):
        f["font"] = rf.get(w("ascii"))
    hl = rpr.find(w("highlight"))
    if hl is not None:
        f["highlight"] = hl.get(w("val"))
    return f


def _runs(pkg: Pkg, p: El) -> list[dict[str, Any]]:
    rels = {i: t for i, _typ, t, _m in pkg.rels(_main(pkg))}
    out: list[dict[str, Any]] = []
    for r in p.iter(R):
        if not _live(r, p):
            continue
        text = _ptext_run(r)
        if not text:
            continue
        item: dict[str, Any] = {"text": text, **_run_format(r)}
        par = r.getparent()
        if par is not None and par.tag == w("hyperlink") and par.get(f"{{{OD_REL}}}id") in rels:
            item["link"] = rels[par.get(f"{{{OD_REL}}}id") or ""]
        out.append(item)
    return out


def _ptext_run(r: El) -> str:
    out = []
    for c in r:
        if c.tag == T:
            out.append(c.text or "")
        else:
            out.append({w("tab"): "\t", w("br"): "\n", w("cr"): "\n"}.get(c.tag, ""))
    return "".join(out)


# ---- outline and read ---------------------------------------------------------


def outline(pkg: Pkg) -> dict[str, Any]:
    """Blocks in body order with ids, styles and text; images; sections; header/footer text; the
    {{placeholder}} names found; comment and tracked-change counts."""
    names = _styles(pkg)
    main = _main(pkg)
    blocks: list[dict[str, Any]] = []
    by_el: dict[int, str] = {}
    pi = ti = 0
    for el in _flat(_body(pkg)):
        b: dict[str, Any]
        if el.tag == P:
            pi += 1
            st = _pstyle(el, names)
            m = re.match(r"(?i)heading (\d)", st)
            b = {"id": f"p{pi}", "type": "heading" if m else "paragraph", "style": st, "text": _ptext(el)}
            if m:
                b["level"] = int(m.group(1))
            if el.find(f".//{{{A_NS}}}blip") is not None:
                b["has_image"] = True
        else:
            ti += 1
            rows = [[_ctext(tc) for tc in tr.findall(TC)] for tr in el.findall(TR)]
            ts = el.find(f"{w('tblPr')}/{w('tblStyle')}")
            tsv = ts.get(w("val")) if ts is not None else None
            b = {
                "id": f"t{ti}",
                "type": "table",
                "rows": len(rows),
                "cols": max([len(r) for r in rows] or [0]),
                "cells": rows,
                "style": names.get(tsv or "", (tsv,))[0] if tsv else None,
            }
        blocks.append(b)
        by_el[id(el)] = b["id"]
    hf: dict[str, dict[str, list[str]]] = {"headers": {}, "footers": {}}
    for kind in ("header", "footer"):
        for part in sorted(_related(pkg, kind)):
            hf[kind + "s"][part] = [_ptext(p) for p in pkg.tree(part).iter(P)]
    seen: list[str] = []
    for part in _content_parts(pkg):
        for p in pkg.tree(part).iter(P):
            for m2 in re.finditer(PLACEHOLDER, _ptext(p)):
                if m2.group(1).strip() not in seen:
                    seen.append(m2.group(1).strip())
    cparts = _related(pkg, "comments")
    root = pkg.tree(main)
    rels = {i: t for i, _typ, t, _m in pkg.rels(main)}
    images = []
    for n, blip in enumerate(_blips(pkg), 1):
        holder = next((a for a in blip.iterancestors() if a.tag in (f"{{{WP_NS}}}inline", f"{{{WP_NS}}}anchor")), None)
        dp = holder.find(f"{{{WP_NS}}}docPr") if holder is not None else None
        ext = holder.find(f"{{{WP_NS}}}extent") if holder is not None else None
        para = next((a for a in blip.iterancestors() if a.tag == P), None)
        images.append(
            {
                "id": f"i{n}",
                "name": dp.get("name") if dp is not None else None,
                "alt": dp.get("descr") if dp is not None else None,
                "part": rels.get(blip.get(f"{{{OD_REL}}}embed") or ""),
                "size_cm": [
                    round(int(ext.get("cx") or 0) / EMU_PER_CM, 2),
                    round(int(ext.get("cy") or 0) / EMU_PER_CM, 2),
                ]
                if ext is not None
                else None,
                "inline": holder is not None and holder.tag == f"{{{WP_NS}}}inline",
                "in_body_paragraph": by_el.get(id(para)) if para is not None else None,
            }
        )
    sections = [
        {
            "width_twips": int(s.get(w("w")) or 0),
            "height_twips": int(s.get(w("h")) or 0),
            "orientation": s.get(w("orient")) or "portrait",
        }
        for s in root.iter(w("pgSz"))
    ]
    return {
        "blocks": blocks,
        "images": images,
        "sections": sections,
        **hf,
        "placeholders": seen,
        "comments": len(pkg.tree(cparts[0]).findall(w("comment"))) if cparts else 0,
        "tracked_changes": {"ins": len(root.findall(".//" + w("ins"))), "del": len(root.findall(".//" + w("del")))},
    }


def _block_el(pkg: Pkg, bid: str) -> El | None:
    m = re.match(r"^([pt])(\d+)$", bid)
    if not m:
        return None
    tag = P if m.group(1) == "p" else TBL
    found = [e for e in _flat(_body(pkg)) if e.tag == tag]
    n = int(m.group(2))
    return found[n - 1] if 1 <= n <= len(found) else None


def read(pkg: Pkg, targets: list[str]) -> dict[str, Any]:
    """Exact content of the blocks named by `targets` (ids from outline())."""
    out: list[dict[str, Any]] = []
    names = _styles(pkg)
    for t in targets:
        el = _block_el(pkg, t)
        if el is None:
            raise PatchError(_no_block(pkg, t))
        if el.tag == P:
            out.append(
                {"id": t, "type": "paragraph", "style": _pstyle(el, names), "text": _ptext(el), "runs": _runs(pkg, el)}
            )
        else:
            rows = [
                [
                    {"text": _ctext(tc), "runs": [r for p in tc.findall(P) for r in _runs(pkg, p)]}
                    for tc in tr.findall(TC)
                ]
                for tr in el.findall(TR)
            ]
            out.append({"id": t, "type": "table", "rows": rows})
    return {"targets": out}


def _no_block(pkg: Pkg, bid: str) -> str:
    if not re.match(r"^[pt]\d+$", str(bid)):
        return f"bad block id {bid!r}; use ids from the outline such as p3 or t1"
    flat = list(_flat(_body(pkg)))
    np_, nt = sum(1 for e in flat if e.tag == P), sum(1 for e in flat if e.tag == TBL)
    return f"no block {bid!r}: the document has paragraphs p1..p{np_} and tables t1..t{nt}; read the outline"


# ---- edit session -----------------------------------------------------------------


class Session:
    def __init__(self, pkg: Pkg, track: bool, author: str, images: ImageSet) -> None:
        self.pkg, self.tr, self.author, self.images = pkg, track, author, images
        self.date = _dt.datetime.now(_dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        ids = [int(v) for part in _content_parts(pkg) for v in _attr_ids(pkg.tree(part)) if v.isdigit()]
        self.n = max(ids or [0])
        # ids refer to the document as it was before this request, whatever earlier operations did
        self._blocks: dict[str, El | None] = {}
        np_ = nt = 0
        for el in _flat(_body(pkg)):
            if el.tag == P:
                np_ += 1
                self._blocks[f"p{np_}"] = el
            else:
                nt += 1
                self._blocks[f"t{nt}"] = el
        self.counts = (np_, nt)

    def mk(self, tag: str) -> El:
        self.n += 1
        e = etree.Element(w(tag))
        e.set(w("id"), str(self.n))
        e.set(w("author"), self.author)
        e.set(w("date"), self.date)
        return e

    def delete_run(self, r: El) -> None:
        d = self.mk("del")
        r.addprevious(d)
        d.append(r)
        for t in r.iter(T):
            t.tag = w("delText")

    def block(self, bid: str) -> El:
        if bid not in self._blocks:
            raise PatchError(
                f"no block {bid!r}: the document has paragraphs p1..p{self.counts[0]} and tables t1..t{self.counts[1]}; "
                "ids come from the outline of the original file"
            )
        el = self._blocks[bid]
        if el is None:
            raise PatchError(f"block {bid!r} was deleted by an earlier operation in this request")
        return el

    def paragraph(self, bid: str) -> El:
        el = self.block(bid)
        if el.tag != P:
            raise PatchError(f"{bid!r} is a table; use set_table_cell or add_table_row")
        return el

    def table(self, bid: str) -> El:
        el = self.block(bid)
        if el.tag != TBL:
            raise PatchError(f"{bid!r} is a paragraph, not a table")
        return el

    def touch_main(self) -> None:
        self.pkg.touch(_main(self.pkg))


# ---- the run engine ------------------------------------------------------------------


def _rtext(r: El) -> str:
    return "".join(t.text or "" for t in r.findall(T))


def _set_rtext(r: El, text: str, special: bool = False) -> None:
    for c in list(r):
        if c.tag in (T, w("tab"), w("br")):
            r.remove(c)
    for piece in re.split(r"(\n|\t)", text) if special else [text]:
        if piece == "\n":
            etree.SubElement(r, w("br"))
        elif piece == "\t":
            etree.SubElement(r, w("tab"))
        elif piece:
            t = etree.SubElement(r, T)
            t.text = piece
            t.set(XML_SPACE, "preserve")


def _mk_run(rpr: El | None, text: str) -> El:
    r = etree.Element(R)
    if rpr is not None:
        r.append(copy.deepcopy(rpr))
    _set_rtext(r, text, True)
    return r


def _is_text(r: El) -> bool:
    kinds = [c.tag for c in r]
    return T in kinds and all(k in (RPR, T) for k in kinds)


def _segments(p: El) -> list[list[El]]:
    """Maximal sequences of plain text runs under one parent: a match may span runs inside one
    sequence but never a tab, line break, field or drawing."""
    segs: list[list[El]] = []
    cur: list[El] = []
    par: El | None = None
    for r in p.iter(R):
        if not _live(r, p):
            continue
        if _is_text(r):
            if cur and r.getparent() is not par:
                segs.append(cur)
                cur = []
            cur.append(r)
            par = r.getparent()
        elif cur:
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


def _apply(ctx: Session, seg: list[El], s: int, e: int, rep: str) -> None:
    def at(pos: int) -> tuple[int, int, int]:
        o = 0
        for i, r in enumerate(seg):
            n = len(_rtext(r))
            if o <= pos < o + n:
                return i, o, n
            o += n
        raise PatchError("internal error: match outside its runs")

    i, o, n = at(s)
    if s > o:  # isolate the match: split the run it starts in, then the run it ends in
        seg.insert(i + 1, _split(seg[i], s - o))
        i += 1
    j, o, n = at(e - 1)
    if e < o + n:
        seg.insert(j + 1, _split(seg[j], e - o))
    cov = seg[i : j + 1]
    rpr = cov[0].find(RPR)  # the replacement takes the FIRST matched run's formatting, as Word does
    if ctx.tr:
        for r in cov:
            ctx.delete_run(r)
        if rep:
            ins = ctx.mk("ins")
            ins.append(_mk_run(rpr, rep))
            parent(cov[-1]).addnext(ins)
    else:
        if rep:
            _set_rtext(cov[0], rep, True)
            cov = cov[1:]
        for r in cov:
            parent(r).remove(r)


def _replace_para(ctx: Session, p: El, rx: re.Pattern[str], fn: Callable[[re.Match[str]], str | None]) -> int:
    n = 0
    for seg in _segments(p):
        text = "".join(_rtext(r) for r in seg)
        hits: list[tuple[int, int, str]] = []
        for m in rx.finditer(text):
            rep = fn(m) if m.end() > m.start() else None
            if rep is not None:
                hits.append((m.start(), m.end(), rep))
        for s, e, rep in reversed(hits):  # right to left keeps earlier offsets valid
            _apply(ctx, seg, s, e, rep)
            n += 1
    return n


def _scope_roots(ctx: Session, scope: str) -> list[tuple[str, El]]:
    pkg = ctx.pkg
    if scope in ("all", "body", "headers", "footers"):
        parts = {
            "all": _content_parts(pkg),
            "body": [_main(pkg)],
            "headers": _related(pkg, "header"),
            "footers": _related(pkg, "footer"),
        }[scope]
        return [(n, pkg.tree(n)) for n in parts]
    return [(_main(pkg), ctx.block(scope))]


def _sweep(ctx: Session, scope: str, rx: re.Pattern[str], fn: Callable[[re.Match[str]], str | None]) -> dict[str, int]:
    by: dict[str, int] = {}
    for part, root in _scope_roots(ctx, scope):
        n = sum(_replace_para(ctx, p, rx, fn) for p in list(root.iter(P)))
        if n:
            by[part] = n
            ctx.pkg.touch(part)
    return by


def op_replace_text(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    find, replace, scope = a["find"], a["replace"], a.get("scope", "all")
    match_case = a.get("match_case", True)
    rx = re.compile(re.escape(find), 0 if match_case else re.IGNORECASE)
    by = _sweep(ctx, scope, rx, lambda m: replace)
    if not by:
        raise PatchError(
            f"no match for {find!r} in scope {scope!r}. Matching is {'case-sensitive' if match_case else 'case-insensitive'} "
            "and cannot cross a tab, line break, field or image; copy the exact text from the outline."
        )
    return {"replaced": sum(by.values()), "by_part": by}


def op_fill_placeholders(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    scope, strict = a.get("scope", "all"), a.get("strict", False)
    values = {str(k).strip(): "" if v is None else str(v) for k, v in a["values"].items()}
    seen: list[str] = []
    filled: dict[str, int] = {}

    def fn(m: re.Match[str]) -> str | None:
        name = m.group(1).strip()
        seen.append(name)
        if name in values:
            filled[name] = filled.get(name, 0) + 1
            return values[name]
        return None

    by = _sweep(ctx, scope, re.compile(PLACEHOLDER), fn)
    missing, unfilled = sorted(set(values) - set(filled)), sorted(set(seen) - set(values))
    if not filled or (strict and (missing or unfilled)):
        raise PatchError(
            f"placeholders not filled: found {sorted(set(seen)) or 'none'} in scope {scope!r}, "
            f"values has {sorted(values)}" + ("; strict mode refuses leftovers" if filled else "")
        )
    return {"filled": filled, "missing": missing, "unfilled": unfilled, "by_part": by}


# ---- paragraphs ----------------------------------------------------------------------


def _para_rpr(p: El) -> El | None:
    e = p.find(f"{w('pPr')}/{RPR}")
    if e is None:
        return None
    e = copy.deepcopy(e)
    for c in list(e):
        if c.tag in _REV:
            e.remove(c)
    return e


def _add_run(ctx: Session, p: El, rpr: El | None, text: str, before: El | None = None) -> None:
    run = _mk_run(rpr, text)
    if ctx.tr:
        ins = ctx.mk("ins")
        ins.append(run)
        run = ins
    if before is not None:
        before.addprevious(run)
    else:
        p.append(run)


def _set_text(ctx: Session, p: El, text: str, fallback: El | None = None) -> None:
    """Replace a paragraph's text, keeping the first run's formatting."""
    runs = [r for r in p.iter(R) if _live(r, p) and all(c.tag in _TEXTUAL for c in r)]
    rpr = next((r.find(RPR) for r in runs if r.find(RPR) is not None), None)
    if rpr is None:
        rpr = _para_rpr(p)
    if rpr is None:
        rpr = fallback
    first = runs[0] if runs else None
    if ctx.tr:
        for r in runs:
            ctx.delete_run(r)
        first = None
    if text:
        _add_run(ctx, p, rpr, text, first)
    if not ctx.tr:
        for r in runs:
            parent(r).remove(r)


def op_set_paragraph_text(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    p = ctx.paragraph(a["paragraph"])
    _set_text(ctx, p, a["text"])
    ctx.touch_main()
    return {"paragraph": a["paragraph"]}


def _ppr(p: El) -> El:
    ppr = p.find(w("pPr"))
    if ppr is None:
        ppr = etree.Element(w("pPr"))
        p.insert(0, ppr)
    return ppr


def _mark_inserted(ctx: Session, p: El) -> None:
    """The new paragraph mark is itself a tracked insertion."""
    ppr = _ppr(p)
    mark = ppr.find(RPR)
    if mark is None:
        mark = etree.SubElement(ppr, RPR)
    mark.append(ctx.mk("ins"))


def _new_paragraph(ctx: Session, anchor: El, style: str | None) -> tuple[El, El | None]:
    """A new empty paragraph shaped after `anchor`; returns it and the run formatting to use."""
    new = etree.Element(P)
    rpr: El | None = None
    if anchor.tag == P:
        if anchor.find(w("pPr")) is not None and not style:
            ppr = copy.deepcopy(anchor.find(w("pPr")))
            assert ppr is not None
            for c in list(ppr):
                if c.tag in (w("sectPr"), RPR, w("pPrChange")):
                    ppr.remove(c)
            new.append(ppr)
        rpr = next((r.find(RPR) for r in anchor.iter(R) if r.find(RPR) is not None), None)
    if style:
        styles = _styles(ctx.pkg)
        names = {n.lower(): sid for sid, (n, t, _d) in styles.items() if t == "paragraph"}
        sid = names.get(style.lower()) or (style if style in styles else None)
        if sid is None:
            raise PatchError(
                f"no paragraph style {style!r}; available: {sorted(n for _s, (n, t, _d) in styles.items() if t == 'paragraph')}"
            )
        ppr = _ppr(new)
        for c in ppr.findall(w("pStyle")):
            ppr.remove(c)
        ps = etree.Element(w("pStyle"))
        ps.set(w("val"), sid)
        ppr.insert(0, ps)
        rpr = None
    if ctx.tr:
        _mark_inserted(ctx, new)
    return new, rpr


def op_insert_paragraph_after(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    anchor = ctx.block(a["anchor"])
    new, rpr = _new_paragraph(ctx, anchor, a.get("style"))
    if a["text"]:
        _add_run(ctx, new, rpr, a["text"])
    anchor.addnext(new)
    ctx.touch_main()
    return {"after": a["anchor"]}


def _release_rids(ctx: Session, rids: set[str]) -> list[str]:
    """Drop relationships (and orphaned media) that the main part no longer references."""
    main = _main(ctx.pkg)
    root = ctx.pkg.tree(main)
    rp = ctx.pkg.tree(main.rpartition("/")[0] + "/_rels/" + main.rpartition("/")[2] + ".rels")
    cands: list[str | None] = []
    for rid in rids:
        if count_refs(root, rid) == 0:
            for r in list(rp):
                if r.get("Id") == rid and r.get("Type") == IMAGE_REL:
                    cands.append(resolve(main, r.get("Target") or ""))
                    rp.remove(r)
    if cands:
        ctx.pkg.touch(main.rpartition("/")[0] + "/_rels/" + main.rpartition("/")[2] + ".rels")
    return drop_orphans(ctx.pkg, cands)


def op_delete_paragraph(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    bid = a["paragraph"]
    p = ctx.paragraph(bid)
    if p.find(f"{w('pPr')}/{w('sectPr')}") is not None:
        raise PatchError(f"{bid} carries a section break; deleting it would merge two sections. Edit its text instead.")
    nxt = p.getnext()
    prv = p.getprevious()
    if prv is not None and prv.tag == TBL and (nxt is None or nxt.tag == w("sectPr")):
        raise PatchError(
            f"{bid} is the paragraph that closes the document after a table; Word needs it. Edit its text instead."
        )
    rids = {b.get(f"{{{OD_REL}}}embed") or "" for b in p.iter(f"{{{A_NS}}}blip")}
    removed_media: list[str] = []
    if ctx.tr:
        for r in [r for r in p.iter(R) if _live(r, p)]:
            ctx.delete_run(r)
        mark = _ppr(p).find(RPR)
        if mark is None:
            mark = etree.SubElement(_ppr(p), RPR)
        mark.append(ctx.mk("del"))
    else:
        parent(p).remove(p)
        ctx._blocks[bid] = None
        removed_media = _release_rids(ctx, rids)
    ctx.touch_main()
    return {"paragraph": bid, "removed_media": removed_media}


# ---- tables ---------------------------------------------------------------------------


def _cell(ctx: Session, table: str, row: int, col: int) -> tuple[El, list[El], El]:
    tbl = ctx.table(table)
    rows = tbl.findall(TR)
    if not 0 <= row < len(rows):
        raise PatchError(f"{table} has {len(rows)} rows (0-based); row {row} does not exist")
    cells = rows[row].findall(TC)
    if not 0 <= col < len(cells):
        raise PatchError(f"{table} row {row} has {len(cells)} cells (0-based); column {col} does not exist")
    return tbl, rows, cells[col]


def _first_rpr(tc: El) -> El | None:
    for r in tc.iter(R):
        if r.find(RPR) is not None:
            return r.find(RPR)
    return None


def op_set_table_cell(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    table, row, col = a["table"], a["row"], a["col"]
    _tbl, rows, tc = _cell(ctx, table, row, col)
    above = rows[row - 1].findall(TC) if row else []
    fb = _first_rpr(above[col]) if col < len(above) else None
    ps = tc.findall(P)
    for extra in ps[1:]:
        if ctx.tr:
            _set_text(ctx, extra, "")
        else:
            tc.remove(extra)
    _set_text(ctx, ps[0], a["text"], fb)
    ctx.touch_main()
    return {"cell": f"{table} r{row} c{col}"}


def op_add_table_row(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    table, values, after = a["table"], a["values"], a.get("after")
    tbl = ctx.table(table)
    rows = tbl.findall(TR)
    idx = len(rows) - 1 if after is None else after
    if not 0 <= idx < len(rows):
        raise PatchError(f"{table} has {len(rows)} rows (0-based); row {after} does not exist")
    new = copy.deepcopy(rows[idx])
    tcs = new.findall(TC)
    if len(values) > len(tcs):
        raise PatchError(f"row has {len(tcs)} cells but {len(values)} values were given (merged cells count once)")
    for e in new.iter():
        for k in [k for k in e.attrib if str(k).endswith(("}paraId", "}textId"))]:
            del e.attrib[k]
    for e in list(new.iter(w("ins"), w("del"))):
        pe = e.getparent()
        if pe is not None and pe.tag == w("trPr"):
            pe.remove(e)
    for i, tc in enumerate(tcs):
        ps = tc.findall(P)
        for extra in ps[1:]:
            tc.remove(extra)
        rpr = _first_rpr(tc)
        rpr = copy.deepcopy(rpr) if rpr is not None else _para_rpr(ps[0])
        for c in list(ps[0]):
            if c.tag != w("pPr"):
                ps[0].remove(c)
        if i < len(values) and values[i] not in (None, ""):
            _add_run(ctx, ps[0], rpr, str(values[i]))
    if ctx.tr:
        trpr = new.find(w("trPr"))
        if trpr is None:
            trpr = etree.Element(w("trPr"))
            pre = new.find(w("tblPrEx"))
            if pre is not None:
                pre.addnext(trpr)
            else:
                new.insert(0, trpr)
        trpr.append(ctx.mk("ins"))
    rows[idx].addnext(new)
    ctx.touch_main()
    return {"row": idx + 1, "table": table}


# ---- images ---------------------------------------------------------------------------


def _docpr_id(root: El) -> int:
    ids = [int(e.get("id") or 0) for e in root.iter(f"{{{WP_NS}}}docPr") if (e.get("id") or "").isdigit()]
    return max(ids or [0]) + 1


def _drawing(rid: str, cx: int, cy: int, pid: int, name: str, alt: str) -> El:
    xml = (
        f'<w:drawing xmlns:w="{W_NS}" xmlns:wp="{WP_NS}" xmlns:a="{A_NS}" xmlns:pic="{PIC_NS}" xmlns:r="{OD_REL}">'
        f'<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/>'
        f'<wp:docPr id="{pid}" name="{_esc(name)}" descr="{_esc(alt)}"/>'
        '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        f'<pic:pic><pic:nvPicPr><pic:cNvPr id="{pid}" name="{_esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>'
        f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
        "</a:graphicData></a:graphic></wp:inline></w:drawing>"
    )
    from .xmlsafe import parse

    return parse(xml.encode(), "drawing")


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def op_insert_image_after(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    img = ctx.images.get(a["image"])
    anchor = ctx.block(a["anchor"])
    main = _main(pkg)
    aspect = img.info.width / img.info.height
    wcm: float | None = a.get("width_cm")
    hcm: float | None = a.get("height_cm")
    if wcm is None and hcm is None:
        wcm = min(img.info.width / 96 * 2.54, 15.0)
    if wcm is None:
        wcm = (hcm or 1.0) * aspect
    if hcm is None:
        hcm = wcm / aspect
    cx, cy = max(1, int(wcm * EMU_PER_CM)), max(1, int(hcm * EMU_PER_CM))
    media = add_media(pkg, "word/media", img.data, img.info.ext, img.info.content_type)
    rid = add_rel(pkg, main, IMAGE_REL, relative_target(main, media))
    root = pkg.tree(main)
    run = etree.Element(R)
    run.append(_drawing(rid, cx, cy, _docpr_id(root), a["image"], a.get("alt", "")))
    new, _ = _new_paragraph(ctx, anchor, None)
    ppr = new.find(w("pPr"))
    if ppr is not None:  # a copied paragraph style (a heading, a list) is wrong for a picture
        for c in list(ppr):
            if c.tag != RPR:
                ppr.remove(c)
    if ctx.tr:
        ins = ctx.mk("ins")
        ins.append(run)
        new.append(ins)
    else:
        new.append(run)
    anchor.addnext(new)
    last = new
    if a.get("caption"):
        styles = _styles(pkg)
        cap = etree.Element(P)
        if any(sid == "Caption" for sid in styles):
            ps = etree.SubElement(etree.SubElement(cap, w("pPr")), w("pStyle"))
            ps.set(w("val"), "Caption")
        if ctx.tr:
            _mark_inserted(ctx, cap)
        _add_run(ctx, cap, None, a["caption"])
        new.addnext(cap)
        last = cap
    ctx.touch_main()
    return {
        "after": a["anchor"],
        "part": media,
        "size_cm": [round(wcm, 2), round(hcm, 2)],
        "last_block_is_caption": last is not new,
    }


def op_replace_image(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    img = ctx.images.get(a["image"])
    blips = _blips(pkg)
    m = re.match(r"^i(\d+)$", a["image_id"])
    n = int(m.group(1)) if m else 0
    if not 1 <= n <= len(blips):
        raise PatchError(
            f"no image {a['image_id']!r}: the document has images i1..i{len(blips)}"
            if blips
            else "the document has no images to replace"
        )
    blip = blips[n - 1]
    holder = next((x for x in blip.iterancestors() if x.tag in (f"{{{WP_NS}}}inline", f"{{{WP_NS}}}anchor")), None)
    bpar = blip.getparent()
    if bpar is None or bpar.tag != f"{{{PIC_NS}}}blipFill":
        raise PatchError(
            f"{a['image_id']} is not a plain picture (it is part of a shape or a chart); it cannot be replaced"
        )
    if bpar.find(".//{*}svgBlip") is not None or blip.find(".//{*}svgBlip") is not None:
        raise PatchError("this picture carries an SVG variant; replacing it is not supported")
    main = _main(pkg)
    old = blip.get(f"{{{OD_REL}}}embed") or ""
    media = add_media(pkg, "word/media", img.data, img.info.ext, img.info.content_type)
    rid = add_rel(pkg, main, IMAGE_REL, relative_target(main, media))
    blip.set(f"{{{OD_REL}}}embed", rid)
    bf = parent(blip)
    for c in bf.findall(f"{{{A_NS}}}srcRect"):
        bf.remove(c)
    cropped = False
    ext = holder.find(f"{{{WP_NS}}}extent") if holder is not None else None
    if a.get("fit", "cover") == "cover" and ext is not None and int(ext.get("cx") or 0) and int(ext.get("cy") or 0):
        ia, ba = img.info.width / img.info.height, int(ext.get("cx") or 1) / int(ext.get("cy") or 1)
        if abs(ia - ba) > 0.001:
            side = int((1 - (ba / ia if ia > ba else ia / ba)) / 2 * 100000)
            sr = etree.Element(f"{{{A_NS}}}srcRect")
            for k in ("l", "r") if ia > ba else ("t", "b"):
                sr.set(k, str(side))
            blip.addnext(sr)
            cropped = True
    pkg.touch(main)
    dropped = _release_rids(ctx, {old})
    return {"image": a["image_id"], "part": media, "cropped": cropped, "removed_media": dropped}


OPS: dict[str, tuple[dict[str, Any], Callable[[Session, dict[str, Any]], dict[str, Any]]]] = {}


def _schema(props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"op": {"type": "string"}, **props},
        "required": ["op", *required],
        "additionalProperties": False,
    }


_SCOPE = {"type": "string", "pattern": r"^(all|body|headers|footers|[pt][0-9]+)$", "default": "all"}
_STR = {"type": "string"}
_PID = {"type": "string", "pattern": r"^p[0-9]+$"}
_BID = {"type": "string", "pattern": r"^[pt][0-9]+$"}
_TID = {"type": "string", "pattern": r"^t[0-9]+$"}
_IDX = {"type": "integer", "minimum": 0}
_CM = {"type": "number", "exclusiveMinimum": 0, "maximum": 60}
OPS.update(
    {
        "replace_text": (
            _schema(
                {
                    "find": {"type": "string", "minLength": 1},
                    "replace": _STR,
                    "scope": _SCOPE,
                    "match_case": {"type": "boolean"},
                },
                ["find", "replace"],
            ),
            op_replace_text,
        ),
        "fill_placeholders": (
            _schema(
                {
                    "values": {
                        "type": "object",
                        "minProperties": 1,
                        "additionalProperties": {"type": ["string", "number", "boolean", "null"]},
                    },
                    "scope": _SCOPE,
                    "strict": {"type": "boolean"},
                },
                ["values"],
            ),
            op_fill_placeholders,
        ),
        "set_paragraph_text": (
            _schema({"paragraph": _PID, "text": _STR}, ["paragraph", "text"]),
            op_set_paragraph_text,
        ),
        "insert_paragraph_after": (
            _schema({"anchor": _BID, "text": _STR, "style": _STR}, ["anchor", "text"]),
            op_insert_paragraph_after,
        ),
        "delete_paragraph": (_schema({"paragraph": _PID}, ["paragraph"]), op_delete_paragraph),
        "set_table_cell": (
            _schema({"table": _TID, "row": _IDX, "col": _IDX, "text": _STR}, ["table", "row", "col", "text"]),
            op_set_table_cell,
        ),
        "add_table_row": (
            _schema(
                {
                    "table": _TID,
                    "values": {"type": "array", "items": {"type": ["string", "number", "null"]}},
                    "after": _IDX,
                },
                ["table", "values"],
            ),
            op_add_table_row,
        ),
        "insert_image_after": (
            _schema(
                {"anchor": _BID, "image": _STR, "width_cm": _CM, "height_cm": _CM, "alt": _STR, "caption": _STR},
                ["anchor", "image"],
            ),
            op_insert_image_after,
        ),
        "replace_image": (
            _schema(
                {
                    "image_id": {"type": "string", "pattern": r"^i[0-9]+$"},
                    "image": _STR,
                    "fit": {"enum": ["cover", "stretch"]},
                },
                ["image_id", "image"],
            ),
            op_replace_image,
        ),
    }
)
DEFERRED = ["add_comment", "insert_chart"]


def start(pkg: Pkg, track: bool, author: str, images: ImageSet) -> Session:
    return Session(pkg, track, author, images)


# ---- diff -----------------------------------------------------------------------------


def _texts(pkg: Pkg) -> dict[str, list[str]]:
    return {n: [_ptext(p) for p in pkg.tree(n).iter(P)] for n in _content_parts(pkg)}


def diff_text(a: Pkg, b: Pkg) -> list[str]:
    """Lines describing what changed in the text, grouped by part: "- old" / "+ new"."""
    ta, tb = _texts(a), _texts(b)
    out: list[str] = []
    for part in sorted(set(ta) | set(tb)):
        d = [
            x
            for x in difflib.unified_diff(ta.get(part, []), tb.get(part, []), lineterm="", n=0)
            if not x.startswith(("---", "+++", "@@"))
        ]
        if d:
            out += [part + ":"] + [x[0] + " " + x[1:] for x in d]
    images_a, images_b = len(_blips(a)), len(_blips(b))
    if images_a != images_b:
        out.append(f"images: {images_a} -> {images_b}")
    return out


def summary(pkg: Pkg) -> dict[str, Any]:
    root = pkg.tree(_main(pkg))
    return {"tracked": {"ins": len(root.findall(".//" + w("ins"))), "del": len(root.findall(".//" + w("del")))}}
