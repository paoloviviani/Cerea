"""Whole-slide edits of a PowerPoint file: `replace_slide`, `add_slide` and `update_shape`.

A slide is built by the same builder as `doc_create` (the same validation, bounds and fit checks, the same
wording) into the deck's own master and layouts, and the finished slide part is moved into the package. Every
other part is left as it was; only the slide's own part, its relationships, the media and charts it owns,
and (for a new slide) the presentation's slide list change.

A deck carries no copy of the spec's `theme`, so what the builder needs is read back from the file: the slide
size, the master's title style, the theme's fonts and accent, the colour most body text uses, the background most
slides share, and whether the other slides carry slide numbers. A value that cannot be recovered takes the
default and is named in the result (`theme_from_file.defaults`)."""

from __future__ import annotations

import copy
import io
import json
import re
from collections import Counter
from typing import Any

from lxml import etree

from .errors import InvalidRequest, PatchError
from .pkg import (
    REL_NS,
    Pkg,
    add_override,
    add_rel,
    drop_orphans,
    ensure_default,
    next_numbered,
    relative_target,
    relpath,
)
from .powerpoint import (
    NSM,
    R_NS,
    SLIDE_CT,
    Session,
    _cnv,
    _lines,
    _pres,
    _section_ids,
    _sections,
    _shapes,
    _slides,
    _sptree,
    a,
    p_,
    write_notes,
)
from .spec import validate_spec
from .theme import DEFAULT_COLORS, Theme
from .xmlsafe import El

EMU_CM = 360_000
EDGE_EMU = 3_600  # 0.01 cm
DEFAULT_LAYOUTS = (
    "Title Slide", "Title and Content", "Section Header", "Two Content", "Comparison", "Title Only", "Blank",
    "Content with Caption", "Picture with Caption", "Title and Vertical Text", "Vertical Title and Text",
)  # fmt: skip
LAYOUT_REL = R_NS + "/slideLayout"
MASTER_REL = R_NS + "/slideMaster"
THEME_REL = R_NS + "/theme"
NOTES_REL = R_NS + "/notesSlide"
SLIDE_REL = R_NS + "/slide"


# ---- reading the deck's style back from the file -------------------------------------------------


def _master(pkg: Pkg) -> str:
    found = next((t for _i, typ, t, _m in pkg.rels(_pres(pkg)) if typ == MASTER_REL), None)
    if found is None:
        raise PatchError("the deck has no slide master")
    return found


def _layouts(pkg: Pkg, master: str) -> list[tuple[str, str]]:
    """[(part, layout name)] in the master's own order."""
    out = []
    for e in pkg.tree(master).findall("p:sldLayoutIdLst/p:sldLayoutId", NSM):
        rid = e.get(f"{{{R_NS}}}id")
        part = next((t for i, typ, t, _m in pkg.rels(master) if i == rid and typ == LAYOUT_REL), None)
        if part:
            c = pkg.tree(part).find("p:cSld", NSM)
            out.append((part, (c.get("name") if c is not None else "") or ""))
    return out


def _bg_of(tree: El) -> dict[str, Any] | None:
    """A slide's own solid or two-colour gradient background as a spec `background`; None otherwise."""
    pr = tree.find("p:cSld/p:bg/p:bgPr", NSM)
    if pr is None:
        return None
    solid = pr.find("a:solidFill/a:srgbClr", NSM)
    if solid is not None:
        return {"color": solid.get("val")}
    stops = pr.findall("a:gradFill/a:gsLst/a:gs/a:srgbClr", NSM)
    if len(stops) == 2:
        lin = pr.find("a:gradFill/a:lin", NSM)
        ang = int(lin.get("ang") or 5_400_000) / 60_000 if lin is not None else 90
        return {"gradient": [s.get("val") for s in stops], "angle": ang}
    return None


def recover_theme(pkg: Pkg, spec: dict[str, Any]) -> tuple[Theme, str, dict[str, Any]]:
    """The theme to build a slide with, read from the file: (theme, "built-in" | "template", what was recovered)."""
    master = _master(pkg)
    mtree = pkg.tree(master)
    layouts = _layouts(pkg, master)
    title = mtree.find("p:txStyles/p:titleStyle/a:lvl1pPr", NSM)
    rpr = title.find("a:defRPr", NSM) if title is not None else None
    builtin = (
        tuple(n for _p, n in layouts) == DEFAULT_LAYOUTS
        and title is not None
        and title.get("algn") == "l"
        and rpr is not None
        and rpr.get("b") in ("0", "1")
    )
    slides = _slides(pkg)
    trees = [pkg.tree(part) for _e, part in slides]
    numbered = any(f.get("type") == "slidenum" for t in trees for f in t.iter(a("fld")) if f.getparent() is not None)
    found: list[str] = []
    defaults: list[str] = []
    if not builtin:
        t = Theme(template="the deck's own styles", slide_numbers=numbered)
        found.append("the deck's own master, layouts and theme (used as they are)")
        return t, "template", {"style": "template", "recovered": found, "defaults": defaults}
    t = Theme(slide_numbers=numbered)
    th = next((x for _i, typ, x, _m in pkg.rels(master) if typ == THEME_REL), None)
    if th is not None:
        root = pkg.tree(th)
        for tag, attr in (("majorFont", "heading_font"), ("minorFont", "body_font")):
            lat = root.find(f".//a:fontScheme/a:{tag}/a:latin", NSM)
            if lat is not None and lat.get("typeface"):
                setattr(t, attr, lat.get("typeface") or "")
        accent = root.find(".//a:clrScheme/a:accent1/a:srgbClr", NSM)
        if accent is not None and accent.get("val"):
            t.colors["accent"] = (accent.get("val") or "").upper()
            for dep in ("link", "table_header_fill"):
                t.colors[dep] = t.colors["accent"]
        found.append("fonts and accent from the theme")
    if rpr is not None:
        sz = rpr.get("sz")
        if sz and sz.isdigit():
            t.heading_sizes[1] = int(sz) / 100
            t.explicit.add("heading_size_h1")
        t.heading_bold = rpr.get("b") == "1"
        fill = rpr.find("a:solidFill/a:srgbClr", NSM)
        if fill is not None and fill.get("val"):
            t.colors["heading"] = (fill.get("val") or "").upper()
            t.explicit.add("color_heading")
        found.append("title size, weight and colour from the master")
    runs: Counter[str] = Counter()
    for tree in trees:
        for sp in tree.iter(p_("sp")):
            ph = sp.find("p:nvSpPr/p:nvPr/p:ph", NSM)
            box = sp.find("p:nvSpPr/p:cNvSpPr", NSM)
            if (ph is None and (box is None or box.get("txBox") != "1")) or (
                ph is not None and ph.get("type") in ("title", "ctrTitle", "sldNum")
            ):
                continue
            for c in sp.iterfind(".//a:r/a:rPr/a:solidFill/a:srgbClr", NSM):
                runs[(c.get("val") or "").upper()] += 1
    if runs:
        t.colors["text"] = runs.most_common(1)[0][0]
        t.explicit.add("color_text")
        found.append("text colour (the one most body text uses)")
    else:
        defaults.append(f"text colour {DEFAULT_COLORS['text']} (no body text in the deck to read it from)")
    if numbered:
        muted = next(
            (
                c.get("val")
                for tree in trees
                for f in tree.iter(a("fld"))
                if f.get("type") == "slidenum"
                for c in f.iterfind("a:rPr/a:solidFill/a:srgbClr", NSM)
            ),
            None,
        )
        if muted:
            t.colors["muted"] = muted.upper()
        found.append("slide numbers (the other slides have them)")
    bgs = Counter(json.dumps(b, sort_keys=True) for tree in trees if (b := _bg_of(tree)))
    if bgs:
        t.slide_background = json.loads(bgs.most_common(1)[0][0])
        found.append("background (the one most slides share)")
    else:
        defaults.append("background (no slide has a solid or gradient background to copy; the master's is used)")
    if any(b.get("type") == "table" for key in ("body", "body_right") for b in spec.get(key) or []):
        defaults.append("table style banded (not recorded in the file)")
    return t, "built-in", {"style": "built-in", "recovered": found, "defaults": defaults}


# ---- moving a built slide into the package --------------------------------------------------------


def _content_type(src: Pkg, part: str) -> tuple[bool, str]:
    """(is an override, content type) of a part of `src`."""
    ext = part.rsplit(".", 1)[-1].lower()
    default = ""
    for e in src.tree("[Content_Types].xml"):
        if not isinstance(e.tag, str):
            continue
        if e.get("PartName") == "/" + part:
            return True, e.get("ContentType") or ""
        if e.tag.endswith("}Default") and (e.get("Extension") or "").lower() == ext:
            default = e.get("ContentType") or ""
    return False, default


def _free_name(dst: Pkg, part: str) -> str:
    folder, _, base = part.rpartition("/")
    stem, ext = re.match(r"^(.*?)\d*(\.[^.]+)$", base).groups()  # type: ignore[union-attr]
    n = next_numbered(dst, re.escape(folder) + "/" + re.escape(stem) + r"(\d+)" + re.escape(ext) + "$")
    return f"{folder}/{stem}{n}{ext}"


def _rels_root(src: Pkg, part: str, where: str, mapping: dict[str, str], skip: tuple[str, ...] = ()) -> El:
    """The relationships of `src`'s `part` as they read from `where`, with internal targets renamed by `mapping`."""
    root = etree.Element(f"{{{REL_NS}}}Relationships", nsmap={None: REL_NS})  # type: ignore[dict-item]
    for r in src.tree(relpath(part)) if src.has(relpath(part)) else []:
        if not isinstance(r.tag, str) or (r.get("Type") or "") in skip:
            continue
        new = etree.SubElement(root, r.tag, {str(k): str(v) for k, v in r.attrib.items()})
        if r.get("TargetMode") != "External":
            target = next(t for i, _typ, t, _m in src.rels(part) if i == r.get("Id"))
            new.set("Target", relative_target(where, mapping[target]))
    return root


def _adopt(dst: Pkg, src: Pkg, part: str, mapping: dict[str, str]) -> str:
    """Copy `part` of `src` into `dst` under a free name, with the parts it points at; return the new name."""
    if part in mapping:
        return mapping[part]
    new = _free_name(dst, part)
    mapping[part] = new
    for _i, _typ, target, mode in src.rels(part):
        if mode != "External":
            _adopt(dst, src, target, mapping)
    dst.add(new, src.read(part))
    override, ctype = _content_type(src, part)
    if override:
        add_override(dst, new, ctype)
    elif ctype:
        ensure_default(dst, part.rsplit(".", 1)[-1].lower(), ctype)
    if src.has(relpath(part)):
        dst.add_tree(relpath(new), _rels_root(src, part, new, mapping))
    return new


def _layout_name(pkg: Pkg, part: str) -> str:
    c = pkg.tree(part).find("p:cSld", NSM)
    return (c.get("name") if c is not None else "") or ""


def _layout_for(dst: Pkg, src: Pkg, src_layout: str) -> str:
    """The deck's layout that the built slide used (the builder keeps the deck's layouts, so same name and place)."""
    name = _layout_name(src, src_layout)
    if dst.has(src_layout) and _layout_name(dst, src_layout) == name:
        return src_layout
    for part, lname in _layouts(dst, _master(dst)):
        if lname == name:
            return part
    raise PatchError(f"the layout {name!r} of the new slide is not in the deck")


def _link(ctx: Session, new: str, after: int) -> int:
    """Add the slide part `new` to the deck after slide `after` (0: first); return its 1-based position."""
    pkg = ctx.pkg
    pres = _pres(pkg)
    rid = add_rel(pkg, pres, SLIDE_REL, relative_target(pres, new))
    root = pkg.tree(pres)
    lst = root.find("p:sldIdLst", NSM)
    assert lst is not None
    sid = etree.Element(p_("sldId"))
    sid.set("id", str(max([int(e.get("id") or 0) for e in lst] + [255]) + 1))
    sid.set(f"{{{R_NS}}}id", rid)
    if after == 0:
        lst.insert(0, sid)
        first = _sections(root)[:1]
        if first and _section_ids(first[0]):
            twin = etree.Element(_section_ids(first[0])[0].tag)
            twin.set("id", sid.get("id") or "")
            _section_ids(first[0])[0].addprevious(twin)
    else:
        prev = ctx.ids[after - 1]
        for el, src_n in ctx.copies:  # several copies of one slide stay in the order they were made
            if src_n == after and el.getparent() is lst:
                prev = el
        prev.addnext(sid)
        for sec in _sections(root):  # in the same section as the slide it follows
            for e in _section_ids(sec):
                if e.get("id") == prev.get("id"):
                    twin = etree.Element(e.tag)
                    twin.set("id", sid.get("id") or "")
                    e.addnext(twin)
                    break
    add_override(pkg, new, SLIDE_CT)
    pkg.touch(pres)
    ctx.copies.append((sid, after))
    return list(lst).index(sid) + 1


# ---- building -------------------------------------------------------------------------------------


def _remap(exc: InvalidRequest | PatchError, label: str) -> PatchError:
    """The builder's own wording, with the slide named the way the request names it."""
    msg = re.sub(r"slides\[0\]", label, exc.message)
    return PatchError(msg, reason=getattr(exc, "reason", None), details=dict(exc.details))


def _build(ctx: Session, spec: dict[str, Any], position: int, label: str) -> tuple[Pkg, str, dict[str, Any], list[str]]:
    """Build `spec` as slide `position` (1-based) of a one-slide copy of the deck; return (that file, the slide's
    part in it, what was recovered from the deck, the builder's notes)."""
    from .make_pptx import PptxBuilder

    pkg = ctx.pkg
    try:
        checked = validate_spec("pptx", {"slides": [spec]}, pkg.limits)
    except InvalidRequest as exc:
        raise _remap(exc, label) from exc
    one = checked["slides"][0]
    theme, style, info = recover_theme(pkg, one)
    own = {k: v for k, v in one.items() if k != "notes"}  # notes are written through the notes engine below
    builder = PptxBuilder(
        {"slides": [own], "size": "16:9"},
        ctx.images,
        theme,
        pkg.source,
        file_style="builtin" if style == "built-in" else "template",
    )
    try:
        builder._check_shape_bounds()
        number: str | bool = str(position) if theme.slide_numbers and position > 1 else False
        builder.slide(position - 1, own, where=label, number=number)
    except InvalidRequest as exc:
        raise _remap(exc, label) from exc
    buf = io.BytesIO()
    builder.prs.save(buf)
    built = Pkg(buf.getvalue(), pkg.limits)
    part = _slides(built)[-1][1]
    return built, part, info, list(builder.notes)


def _install(ctx: Session, built: Pkg, built_part: str, dst_part: str, keep: tuple[str, ...]) -> list[str | None]:
    """Make `dst_part` the built slide: its XML, and relationships that point at the deck's layout and at the media
    and charts the slide owns (copied). `keep` are the old relationship types to carry over (the notes page).
    Returns the parts the old slide owned, to be dropped when nothing else uses them."""
    pkg = ctx.pkg
    old = [t for _i, typ, t, m in pkg.rels(dst_part) if m != "External" and typ not in (LAYOUT_REL, NOTES_REL)]
    mapping: dict[str, str] = {}
    for _i, typ, target, mode in built.rels(built_part):
        if mode == "External":
            continue
        mapping[target] = _layout_for(pkg, built, target) if typ == LAYOUT_REL else _adopt(pkg, built, target, mapping)
    root = _rels_root(built, built_part, dst_part, mapping)
    for r in pkg.tree(relpath(dst_part)) if pkg.has(relpath(dst_part)) else []:
        if isinstance(r.tag, str) and (r.get("Type") or "") in keep:
            nums = [int(m.group(1)) for x in root for m in [re.match(r"rId(\d+)$", x.get("Id") or "")] if m]
            kept = etree.SubElement(root, r.tag, {str(k): str(v) for k, v in r.attrib.items()})
            kept.set("Id", f"rId{max(nums or [0]) + 1}")
    rp = relpath(dst_part)
    if pkg.has(rp):
        pkg.trees[rp] = root
        pkg.dirty.add(rp)
    else:
        pkg.add_tree(rp, root)
    pkg.trees[dst_part] = copy.deepcopy(built.tree(built_part))
    pkg.dirty.add(dst_part)
    return list(old)


def _result(ctx: Session, part: str, spec: dict[str, Any], notes: list[str], info: dict[str, Any]) -> list[str]:
    """Write the spec's speaker notes (the builder writes none) and return the notes to report."""
    if spec.get("notes"):
        try:
            write_notes(ctx.pkg, part, _lines(spec["notes"]), part)
        except PatchError as exc:
            notes.append(f"the speaker notes were not saved: {exc.message}")
    return notes


def op_replace_slide(ctx: Session, args: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    n, spec = args["slide"], args["spec"]
    part = ctx.part(n)
    lst = pkg.tree(_pres(pkg)).find("p:sldIdLst", NSM)
    position = list(lst).index(ctx.ids[n - 1]) + 1 if lst is not None and ctx.ids[n - 1].getparent() is lst else n
    built, built_part, info, notes = _build(ctx, spec, position, f"slide {n}")
    old = _install(ctx, built, built_part, part, (NOTES_REL,))
    drop_orphans(pkg, old)
    notes = _result(ctx, part, spec, notes, info)
    return {"slide": n, "theme_from_file": info, **({"notes": notes} if notes else {})}


def op_add_slide(ctx: Session, args: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    after, spec = args["after"], args["spec"]
    if after:
        ctx.part(after)
    elif after < 0:
        raise PatchError("`after` is a slide number, or 0 to put the slide first")
    if len(_slides(pkg)) >= pkg.limits.max_slides:
        raise PatchError(f"the deck already has {pkg.limits.max_slides} slides, the most this service writes")
    label = f"the new slide (after slide {after})" if after else "the new slide (first)"
    built, built_part, info, notes = _build(ctx, spec, after + 1, label)
    new = f"ppt/slides/slide{next_numbered(pkg, r'ppt/slides/slide(\d+)\.xml$')}.xml"
    pkg.add_tree(new, copy.deepcopy(built.tree(built_part)))
    _install(ctx, built, built_part, new, ())
    position = _link(ctx, new, after)
    notes = _result(ctx, new, spec, notes, info)
    return {"new_slide_position": position, "part": new, "theme_from_file": info, **({"notes": notes} if notes else {})}


# ---- moving or resizing one shape -----------------------------------------------------------------


def op_update_shape(ctx: Session, args: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    slide, shape = args["slide"], args["shape"]
    part = ctx.part(slide)
    tree = pkg.tree(part)
    el = next((e for e in _shapes(_sptree(tree)) if _cnv(e).get("id") == str(shape)), None)
    if el is None:
        ids = [e.get("id") for e in tree.iterfind(".//p:cNvPr", NSM)]
        raise PatchError(f"no shape with id {shape!r} on slide {slide}; ids here: {ids}")
    xf = el.find("./p:spPr/a:xfrm", NSM)
    if xf is None:
        xf = el.find("./p:xfrm", NSM)
    if xf is None:
        xf = el.find("./p:grpSpPr/a:xfrm", NSM)
    wanted = {k: args[k] for k in ("x_cm", "y_cm", "w_cm", "h_cm") if k in args}
    if not wanted:
        raise PatchError("give at least one of x_cm, y_cm, w_cm and h_cm")
    off = xf.find("a:off", NSM) if xf is not None else None
    ext = xf.find("a:ext", NSM) if xf is not None else None
    if off is None or ext is None:
        if len(wanted) < 4:
            raise PatchError(
                f"shape {shape} takes its place from the layout; give x_cm, y_cm, w_cm and h_cm together to place it"
            )
        sp_pr = el.find("./p:spPr", NSM)
        if sp_pr is None:
            raise PatchError(f"shape {shape} cannot be given a position")
        xf = etree.Element(a("xfrm"))
        off, ext = etree.SubElement(xf, a("off")), etree.SubElement(xf, a("ext"))
        sp_pr.insert(0, xf)
    box = {
        "x": int(off.get("x") or 0), "y": int(off.get("y") or 0),
        "w": int(ext.get("cx") or 0), "h": int(ext.get("cy") or 0),
    }  # fmt: skip
    for k, v in wanted.items():
        box[k[0]] = round(float(v) * EMU_CM)
    sz = pkg.tree(_pres(pkg)).find("p:sldSz", NSM)
    sw, sh = (int(sz.get("cx") or 0), int(sz.get("cy") or 0)) if sz is not None else (0, 0)
    has_text = any((t.text or "").strip() for t in el.iter(a("t")))
    if sw and sh:
        bad = (
            box["x"] < -EDGE_EMU
            or box["y"] < -EDGE_EMU
            or box["x"] + box["w"] > sw + EDGE_EMU
            or box["y"] + box["h"] > sh + EDGE_EMU
            if has_text
            else box["x"] + box["w"] < EMU_CM // 2
            or box["y"] + box["h"] < EMU_CM // 2
            or box["x"] > sw - EMU_CM // 2
            or box["y"] > sh - EMU_CM // 2
        )
        if bad:
            raise PatchError(
                f"the new box ({box['x'] / EMU_CM:.2f}, {box['y'] / EMU_CM:.2f}, {box['w'] / EMU_CM:.2f} x "
                f"{box['h'] / EMU_CM:.2f} cm) reaches outside the slide, which is {sw / EMU_CM:.2f} x {sh / EMU_CM:.2f} cm; "
                + ("a shape with text must stay on the slide" if has_text else "at least 0.5 cm of it must show")
            )
    off.set("x", str(box["x"]))
    off.set("y", str(box["y"]))
    ext.set("cx", str(box["w"]))
    ext.set("cy", str(box["h"]))
    pkg.touch(part)
    return {"slide": slide, "shape": shape, "box_cm": [round(box[k] / EMU_CM, 2) for k in ("x", "y", "w", "h")]}


__all__ = ["op_add_slide", "op_replace_slide", "op_update_shape"]
