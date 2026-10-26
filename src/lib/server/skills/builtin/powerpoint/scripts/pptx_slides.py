"""pptx_slides - duplicate, delete and reorder slides for pptx_edit (write both
files into the working directory). Slide numbers are 1-based; every function
takes src and dst and rewrites only the slide parts, presentation.xml, its
relationships and [Content_Types].xml.

    import pptx_slides as ps
    ps.duplicate_slide("in.pptx", "out.pptx", 3)      # the copy follows slide 3
    ps.delete_slide("in.pptx", "out.pptx", 5)
    ps.reorder("in.pptx", "out.pptx", [3, 1, 2])      # new order, as old slide numbers

Licence: Apache-2.0, as the rest of this repository. Original work.
"""

import re

from lxml import etree

from pptx_edit import (NSM, P_NS, R_NS, PatchError, _drop_orphans, _pres, _relpath, _rels, _resolve, _run, _slide,
                       _slides)

SLIDE_CT = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
COPYABLE = ("/slideLayout", "/image", "/video", "/audio", "/media", "/hdphoto", "/slide")


def _next_id(pkg, rels_part_tree):
    return "rId%d" % (max([int(m.group(1)) for r in rels_part_tree for m in [re.match(r"rId(\d+)$", r.get("Id", ""))] if m] or [0]) + 1)


def _sections(root):
    return root.findall(".//{%s}section" % P14)


def _section_ids(sec):
    return sec.findall(".//{%s}sldId" % P14)


def duplicate_slide(src, dst, slide):
    """Copy slide `slide` and place the copy right after it, in the same deck
    (layout, pictures and formatting included; speaker notes are not copied).
    Refused for slides with charts, SmartArt or embedded objects, which cannot
    be shared between two slides."""
    def job(pkg):
        part = _slide(pkg, slide)
        rels = _rels(pkg, part)
        bad = [typ.rsplit("/", 1)[1] for i, typ, t, m in rels if m != "External" and not typ.endswith(COPYABLE) and not typ.endswith("/notesSlide")]
        if bad:
            raise PatchError("slide %d has %s content that cannot be duplicated safely (two slides would share one part); "
                             "rebuild that slide or ask the person to copy it in PowerPoint" % (slide, ", ".join(sorted(set(bad)))))
        n = max(int(m.group(1)) for x in pkg.names for m in [re.match(r"ppt/slides/slide(\d+)\.xml$", x)] if m) + 1
        new = "ppt/slides/slide%d.xml" % n
        pkg.add(new, pkg.data[part])
        rp = pkg.tree(_relpath(part))
        copy_rels = etree.fromstring(etree.tostring(rp))
        for r in list(copy_rels):
            if r.get("Type", "").endswith("/notesSlide"):
                copy_rels.remove(r)
        pkg.add(_relpath(new), etree.tostring(copy_rels, xml_declaration=True, encoding="UTF-8", standalone=True))
        pres = _pres(pkg)
        prt = pkg.tree(_relpath(pres))
        rid = _next_id(pkg, prt)
        rel = etree.SubElement(prt, "{%s}Relationship" % prt.nsmap[None])
        rel.set("Id", rid)
        rel.set("Type", R_NS + "/slide")
        rel.set("Target", "slides/slide%d.xml" % n)
        root = pkg.tree(pres)
        lst = root.find("p:sldIdLst", NSM)
        old = lst[slide - 1]
        sid = etree.Element("{%s}sldId" % P_NS)
        sid.set("id", str(max(int(e.get("id")) for e in lst) + 1))
        sid.set("{%s}id" % R_NS, rid)
        old.addnext(sid)
        for sec in _sections(root):  # keep the copy in the same section as the original
            for e in _section_ids(sec):
                if e.get("id") == old.get("id"):
                    twin = etree.Element(e.tag)
                    twin.set("id", sid.get("id"))
                    e.addnext(twin)
                    break
        ct = pkg.tree("[Content_Types].xml")
        o = etree.SubElement(ct, "{%s}Override" % ct.nsmap[None])
        o.set("PartName", "/" + new)
        o.set("ContentType", SLIDE_CT)
        for x in (pres, _relpath(pres), "[Content_Types].xml"):
            pkg.touch(x)
        return {"slide": slide, "new_slide": slide + 1, "part": new}

    return _run(src, dst, job)


def delete_slide(src, dst, slide):
    """Remove slide `slide`, its notes and any media or parts only it used.
    Refused when another slide has a link that jumps to it."""
    def job(pkg):
        part = _slide(pkg, slide)
        pres = _pres(pkg)
        notes = [t for i, typ, t, m in _rels(pkg, part) if typ.endswith("/notesSlide")]
        own = {_relpath(x) for x in [part, pres] + notes}
        for n in pkg.names:
            if n.endswith(".rels") and n not in own and any(t == part for i, typ, t, m in _rels(pkg, _owner(n))):
                raise PatchError("%s links to slide %d; remove that link first, then delete the slide" % (_owner(n), slide))
        root = pkg.tree(pres)
        el = root.find("p:sldIdLst", NSM)[slide - 1]
        rid = el.get("{%s}id" % R_NS)
        for e in root.iter("{%s}sldId" % P14):
            if e.get("id") == el.get("id"):
                e.getparent().remove(e)
        for e in root.iter("{%s}sld" % P_NS):  # custom shows
            if e.get("{%s}id" % R_NS) == rid:
                e.getparent().remove(e)
        el.getparent().remove(el)
        prt = pkg.tree(_relpath(pres))
        for r in list(prt):
            if r.get("Id") == rid:
                prt.remove(r)
        skip = ("/slideLayout", "/slideMaster", "/theme", "/notesMaster", "/slide")
        children = [t for n in [part] + notes for i, typ, t, m in _rels(pkg, n) if m != "External" and not typ.endswith(skip)]
        ct = pkg.tree("[Content_Types].xml")
        for n in [part] + notes:  # owned by the slide: removed with it
            for x in (n, _relpath(n)):
                if x in pkg.data:
                    pkg.remove(x)
            for o in [o for o in ct if o.get("PartName") == "/" + n]:
                ct.remove(o)
        dropped = _drop_orphans(pkg, children)
        for x in (pres, _relpath(pres), "[Content_Types].xml"):
            pkg.touch(x)
        return {"deleted": slide, "part": part, "removed_parts": [part] + notes + dropped}

    return _run(src, dst, job)


def _owner(rels_name):
    d, _, b = rels_name.rpartition("_rels/")
    return d + b[:-5]


def reorder(src, dst, order):
    """New slide order, as the current slide numbers: [3, 1, 2] puts the third
    slide first. Must list every slide once. Slides may move within a section
    but not between sections (refused, so section membership never changes)."""
    def job(pkg):
        pres = _pres(pkg)
        root = pkg.tree(pres)
        lst = root.find("p:sldIdLst", NSM)
        n = len(lst)
        if sorted(order) != list(range(1, n + 1)):
            raise PatchError("order must list each of the %d slide numbers exactly once, e.g. %s" % (n, list(range(n, 0, -1))))
        items = list(lst)
        new = [items[i - 1] for i in order]
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
                raise PatchError("this deck has sections and that order moves a slide from one section to another; "
                                 "reorder within each section, or tell the person")
            parent = members[0].getparent() if members else None
            by = {e.get("id"): e for e in members}
            for e in members:
                parent.remove(e)
            for i in chunk:
                parent.append(by[i])
            pos += len(members)
        pkg.touch(pres)
        return {"order": list(order)}

    return _run(src, dst, job)
