"""docx_edit - precise edits to a .docx someone supplied, touching nothing else.

python-docx load+save re-serialises every part it parsed and loses character
formatting when text spans runs. This helper rewrites only the parts it edits
(body, headers, footers) with lxml and copies every other part through byte for
byte. Use python-docx for NEW documents. Needs the stdlib and lxml.

Ids come from outline(): p1.. paragraphs, t1.. tables, in body order (re-run it
after inserting). Rows and columns are 0-based. Table edits are in docx_tables.py,
verify and diff_text in docx_verify.py.

    import docx_edit as de
    de.outline("in.docx")
    de.replace_text("in.docx", "out.docx", "Acme Ltd", "Beta plc")
    de.fill_placeholders("in.docx", "out.docx", {"client": "Beta plc"})
    de.insert_paragraph_after("in.docx", "out.docx", "p4", "New text", "Heading 2")

Every edit takes track_changes=True, author="..." to write w:ins / w:del that a
reviewer can accept or reject in Word. Chain edits by passing the previous output
as the next source. Licence: Apache-2.0, as the rest of this repository.
"""

import copy
import datetime as _dt
import os
import re
import tempfile
import zipfile

from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
PLACEHOLDER = r"\{\{\s*([^{}]+?)\s*\}\}"


def w(tag):
    return "{%s}%s" % (W_NS, tag)


P, R, T, RPR, TBL, TR, TC = (w(x) for x in ("p", "r", "t", "rPr", "tbl", "tr", "tc"))
_TEXTUAL = {w(x) for x in ("rPr", "t", "tab", "br", "cr", "noBreakHyphen")}
_REV = {w(x) for x in ("ins", "del", "moveFrom", "moveTo", "rPrChange")}


class PatchError(Exception):
    """The edit was refused or the result failed verification."""


# ---- package io -------------------------------------------------------------

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
                raise PatchError("part %s is missing; is this a .docx?" % name)
            self.trees[name] = etree.fromstring(self.data[name])
        return self.trees[name]

    def touch(self, name):
        self.tree(name)
        self.dirty.add(name)

    def save(self, dst):
        for n in self.dirty:
            m = re.match(rb"\s*<\?xml[^>]*\?>\s*", self.data[n])
            self.data[n] = (m.group(0) if m else b"") + etree.tostring(self.trees[n], encoding="UTF-8")
        fd, tmp = tempfile.mkstemp(suffix=".docx", dir=os.path.dirname(os.path.abspath(dst)))
        os.close(fd)
        try:
            with zipfile.ZipFile(tmp, "w") as out:
                for n in self.names:  # a FRESH ZipInfo per entry: reusing the source's carries a stale CRC
                    o = self.info[n]
                    zi = zipfile.ZipInfo(n, date_time=o.date_time)
                    zi.compress_type = o.compress_type if o.compress_type in (0, 8) else zipfile.ZIP_DEFLATED
                    zi.external_attr, zi.create_system = o.external_attr, o.create_system
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


def _rels(pkg, part):
    d, _, b = part.rpartition("/")
    rp = (d + "/" if d else "") + "_rels/" + b + ".rels"
    if rp not in pkg.data:
        return []
    return [(r.get("Type"), r.get("Target"), r.get("TargetMode")) for r in etree.fromstring(pkg.data[rp])]


def _main(pkg):
    for typ, tgt, _ in _rels(pkg, ""):
        if typ.endswith("/officeDocument"):
            return _resolve("", tgt)
    raise PatchError("not a .docx package (no main document part)")


def _related(pkg, kind):
    main = _main(pkg)
    return [_resolve(main, t) for typ, t, m in _rels(pkg, main) if typ.endswith("/" + kind) and m != "External"]


def _content_parts(pkg):
    return [_main(pkg)] + sorted(_related(pkg, "header") + _related(pkg, "footer"))


def _styles(pkg):
    out = {}
    for part in _related(pkg, "styles"):
        for s in pkg.tree(part).findall(w("style")):
            nm = s.find(w("name"))
            sid = s.get(w("styleId"))
            out[sid] = (nm.get(w("val")) if nm is not None else sid, s.get(w("type")), s.get(w("default")) == "1")
    return out


# ---- reading ----------------------------------------------------------------

def _flat(parent):
    for el in parent:
        if el.tag in (P, TBL):
            yield el
        elif el.tag == w("sdt"):
            c = el.find(w("sdtContent"))
            if c is not None:
                yield from _flat(c)


def _live(r, p):
    """True when run r belongs to paragraph p itself (not a nested one) and is not deleted."""
    for a in r.iterancestors():
        if a is p:
            return True
        if a.tag in (P, w("del"), w("moveFrom")):
            return False
    return False


def _ptext(p):
    out = []
    for r in p.iter(R):
        if _live(r, p):
            for c in r:
                out.append(c.text or "" if c.tag == T else {w("tab"): "\t", w("br"): "\n", w("cr"): "\n"}.get(c.tag, ""))
    return "".join(out)


def _pstyle(p, names):
    e = p.find("%s/%s" % (w("pPr"), w("pStyle")))
    if e is not None:
        return names.get(e.get(w("val")), (e.get(w("val")),))[0]
    return next((n for n, t, d in names.values() if d and t == "paragraph"), "Normal")


def _ctext(tc):
    return "\n".join(_ptext(p) for p in tc.findall(P))


def outline(path):
    """Blocks in body order with ids, styles and text; header/footer text;
    the {{placeholder}} names found; comment and tracked-change counts."""
    pkg = _Pkg(path)
    names = _styles(pkg)
    main = _main(pkg)
    blocks, pi, ti = [], 0, 0
    for el in _flat(pkg.tree(main).find(w("body"))):
        if el.tag == P:
            pi += 1
            st = _pstyle(el, names)
            m = re.match(r"(?i)heading (\d)", st)
            b = {"id": "p%d" % pi, "type": "heading" if m else "paragraph", "style": st, "text": _ptext(el)}
            if m:
                b["level"] = int(m.group(1))
        else:
            ti += 1
            rows = [[_ctext(tc) for tc in tr.findall(TC)] for tr in el.findall(TR)]
            ts = el.find("%s/%s" % (w("tblPr"), w("tblStyle")))
            b = {"id": "t%d" % ti, "type": "table", "rows": len(rows), "cells": rows,
                 "cols": max([len(r) for r in rows] or [0]),
                 "style": names.get(ts.get(w("val")), (ts.get(w("val")),))[0] if ts is not None else None}
        blocks.append(b)
    hf = {"headers": {}, "footers": {}}
    seen = []
    for kind in ("header", "footer"):
        for part in sorted(_related(pkg, kind)):
            hf[kind + "s"][part] = [_ptext(p) for p in pkg.tree(part).iter(P)]
    for part in _content_parts(pkg):
        for p in pkg.tree(part).iter(P):
            for m in re.finditer(PLACEHOLDER, _ptext(p)):
                if m.group(1).strip() not in seen:
                    seen.append(m.group(1).strip())
    cparts = _related(pkg, "comments")
    root = pkg.tree(main)
    return {"blocks": blocks, **hf, "placeholders": seen,
            "comments": len(pkg.tree(cparts[0]).findall(w("comment"))) if cparts else 0,
            "tracked_changes": {"ins": len(root.findall(".//" + w("ins"))), "del": len(root.findall(".//" + w("del")))}}


# ---- the run engine ---------------------------------------------------------

class _Ctx:
    def __init__(self, pkg, track, author):
        self.tr, self.author = track, author
        self.date = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        ids = [int(v) for part in _content_parts(pkg) for v in pkg.tree(part).xpath("//@w:id", namespaces={"w": W_NS}) if v.isdigit()]
        self.n = max(ids or [0])

    def mk(self, tag):
        self.n += 1
        e = etree.Element(w(tag))
        e.set(w("id"), str(self.n))
        e.set(w("author"), self.author)
        e.set(w("date"), self.date)
        return e

    def delete_run(self, r):
        d = self.mk("del")
        r.addprevious(d)
        d.append(r)
        for t in r.iter(T):
            t.tag = w("delText")


def _rtext(r):
    return "".join(t.text or "" for t in r.findall(T))


def _set_rtext(r, text, special=False):
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


def _mk_run(rpr, text):
    r = etree.Element(R)
    if rpr is not None:
        r.append(copy.deepcopy(rpr))
    _set_rtext(r, text, True)
    return r


def _is_text(r):
    kinds = [c.tag for c in r]
    return T in kinds and all(k in (RPR, T) for k in kinds)


def _segments(p):
    """Maximal sequences of plain text runs under one parent: a match may span
    runs inside one sequence but never a tab, line break, field or drawing."""
    segs, cur, par = [], [], None
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


def _split(r, k):
    t = _rtext(r)
    right = copy.deepcopy(r)
    _set_rtext(r, t[:k])
    _set_rtext(right, t[k:])
    r.addnext(right)
    return right


def _apply(ctx, seg, s, e, rep):
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
    cov = seg[i : j + 1]
    rpr = cov[0].find(RPR)  # the replacement takes the FIRST matched run's formatting, as Word does
    if ctx.tr:
        for r in cov:
            ctx.delete_run(r)
        if rep:
            ins = ctx.mk("ins")
            ins.append(_mk_run(rpr, rep))
            cov[-1].getparent().addnext(ins)
    else:
        if rep:
            _set_rtext(cov[0], rep, True)
            cov = cov[1:]
        for r in cov:
            r.getparent().remove(r)


def _replace_para(ctx, p, rx, fn):
    n = 0
    for seg in _segments(p):
        text = "".join(_rtext(r) for r in seg)
        hits = []
        for m in rx.finditer(text):
            rep = fn(m) if m.end() > m.start() else None
            if rep is not None:
                hits.append((m.start(), m.end(), rep))
        for s, e, rep in reversed(hits):  # right to left keeps earlier offsets valid
            _apply(ctx, seg, s, e, rep)
            n += 1
    return n


def _scope_roots(pkg, scope):
    if scope in ("all", "body", "headers", "footers"):
        parts = {"all": _content_parts(pkg), "body": [_main(pkg)],
                 "headers": _related(pkg, "header"), "footers": _related(pkg, "footer")}[scope]
        return [(n, pkg.tree(n)) for n in parts]
    return [(_main(pkg), _block(pkg, scope))]


def _sweep(pkg, ctx, scope, rx, fn):
    by = {}
    for part, root in _scope_roots(pkg, scope):
        n = sum(_replace_para(ctx, p, rx, fn) for p in list(root.iter(P)))
        if n:
            by[part] = n
            pkg.touch(part)
    return by


def _run(src, dst, track, author, job):
    pkg = _Pkg(src)
    rep = job(pkg, _Ctx(pkg, track, author))
    pkg.save(dst)
    return {**rep, "changed_parts": sorted(pkg.dirty), "tracked": bool(track)}


def replace_text(src, dst, find, replace, scope="all", track_changes=False, author="Cerea", match_case=True):
    """Replace every occurrence of `find`, keeping run formatting even when the
    match spans runs. scope: "all" (body, tables, headers, footers), "body",
    "headers", "footers", or a block id such as "p3" / "t1"."""
    if not find:
        raise PatchError("find must be a non-empty string")
    rx = re.compile(re.escape(find), 0 if match_case else re.I)

    def job(pkg, ctx):
        by = _sweep(pkg, ctx, scope, rx, lambda m: replace)
        if not by:
            raise PatchError("no match for %r in scope %r. Matching is %s and cannot cross a tab, line break, field or "
                             "image; copy the exact text from outline()." % (find, scope, "case-sensitive" if match_case else "case-insensitive"))
        return {"replaced": sum(by.values()), "by_part": by}

    return _run(src, dst, track_changes, author, job)


def fill_placeholders(src, dst, mapping, scope="all", track_changes=False, author="Cerea", pattern=PLACEHOLDER, strict=False):
    """Fill {{name}} placeholders (spaces inside the braces allowed) from
    `mapping`, in body, tables, headers and footers. Placeholders with no key
    are left alone and listed in "unfilled"; keys never found in "missing"."""
    values = {str(k).strip(): "" if v is None else str(v) for k, v in mapping.items()}
    seen, filled = [], {}

    def fn(m):
        name = m.group(1).strip()
        seen.append(name)
        if name in values:
            filled[name] = filled.get(name, 0) + 1
            return values[name]
        return None

    def job(pkg, ctx):
        by = _sweep(pkg, ctx, scope, re.compile(pattern), fn)
        missing, unfilled = sorted(set(values) - set(filled)), sorted(set(seen) - set(values))
        if not filled or (strict and (missing or unfilled)):
            raise PatchError("placeholders not filled: found %s in scope %r, mapping has %s%s" % (
                sorted(set(seen)) or "none", scope, sorted(values), "; strict mode refuses leftovers" if filled else ""))
        return {"filled": filled, "missing": missing, "unfilled": unfilled, "by_part": by}

    return _run(src, dst, track_changes, author, job)


# ---- blocks, paragraphs, tables --------------------------------------------

def _block(pkg, bid):
    m = re.match(r"^([pt])(\d+)$", str(bid))
    if not m:
        raise PatchError("bad block id %r; use ids from outline() such as p3 or t1" % (bid,))
    tag = P if m.group(1) == "p" else TBL
    found = [e for e in _flat(pkg.tree(_main(pkg)).find(w("body"))) if e.tag == tag]
    if not 1 <= int(m.group(2)) <= len(found):
        raise PatchError("no block %r: the document has %d of that kind; run outline()" % (bid, len(found)))
    return found[int(m.group(2)) - 1]


def _para_rpr(p):
    e = p.find("%s/%s" % (w("pPr"), RPR))
    if e is None:
        return None
    e = copy.deepcopy(e)
    for c in list(e):
        if c.tag in _REV:
            e.remove(c)
    return e


def _add_run(ctx, p, rpr, text, before=None):
    run = _mk_run(rpr, text)
    if ctx.tr:
        ins = ctx.mk("ins")
        ins.append(run)
        run = ins
    if before is not None:
        before.addprevious(run)
    else:
        p.append(run)


def _set_text(ctx, p, text, fallback=None):
    """Replace a paragraph's text, keeping the first run's formatting."""
    runs = [r for r in p.iter(R) if _live(r, p) and all(c.tag in _TEXTUAL for c in r)]
    rpr = next((r.find(RPR) for r in runs if r.find(RPR) is not None), None)
    rpr = rpr if rpr is not None else (_para_rpr(p) if _para_rpr(p) is not None else fallback)
    first = runs[0] if runs else None
    if ctx.tr:
        for r in runs:
            ctx.delete_run(r)
        first = None
    if text:
        _add_run(ctx, p, rpr, text, first)
    for r in runs if not ctx.tr else []:
        r.getparent().remove(r)


def set_paragraph_text(src, dst, para, text, track_changes=False, author="Cerea"):
    """Replace the whole text of paragraph `para` (e.g. "p3"), keeping its formatting."""
    def job(pkg, ctx):
        p = _block(pkg, para)
        if p.tag != P:
            raise PatchError("%r is a table; use set_table_cell" % para)
        _set_text(ctx, p, text)
        pkg.touch(_main(pkg))
        return {"paragraph": para}

    return _run(src, dst, track_changes, author, job)


def insert_paragraph_after(src, dst, anchor, text, style=None, track_changes=False, author="Cerea"):
    """Insert a paragraph after block `anchor` (a paragraph or a table). With
    style=None it copies the anchor paragraph's paragraph and run formatting;
    style is a style NAME such as "Heading 2" or "List Bullet"."""
    def job(pkg, ctx):
        a = _block(pkg, anchor)
        new = etree.Element(P)
        rpr = None
        if a.tag == P:
            if a.find(w("pPr")) is not None and not style:
                ppr = copy.deepcopy(a.find(w("pPr")))
                for c in list(ppr):
                    if c.tag in (w("sectPr"), RPR, w("pPrChange")):
                        ppr.remove(c)
                new.append(ppr)
            rpr = next((r.find(RPR) for r in a.iter(R) if r.find(RPR) is not None), None)
        if style:
            names = {n.lower(): sid for sid, (n, t, d) in _styles(pkg).items() if t == "paragraph"}
            sid = names.get(style.lower()) or (style if style in _styles(pkg) else None)
            if sid is None:
                raise PatchError("no paragraph style %r; available: %s" % (style, sorted(n for sid, (n, t, d) in _styles(pkg).items() if t == "paragraph")))
            ppr = new.find(w("pPr"))
            if ppr is None:
                ppr = etree.Element(w("pPr"))
                new.insert(0, ppr)
            for c in ppr.findall(w("pStyle")):
                ppr.remove(c)
            ps = etree.Element(w("pStyle"))
            ps.set(w("val"), sid)
            ppr.insert(0, ps)
            rpr = None
        if ctx.tr:  # the new paragraph mark is itself a tracked insertion
            ppr = new.find(w("pPr"))
            if ppr is None:
                ppr = etree.Element(w("pPr"))
                new.insert(0, ppr)
            mark = etree.Element(RPR)
            mark.append(ctx.mk("ins"))
            ppr.append(mark)
        if text:
            _add_run(ctx, new, rpr, text)
        a.addnext(new)
        pkg.touch(_main(pkg))
        return {"after": anchor}

    return _run(src, dst, track_changes, author, job)
