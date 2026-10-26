"""Excel (.xlsx) engine: outline, read and typed edits that rewrite only the worksheets they touch.
openpyxl load+save drops extensions it does not model (x14 conditional formatting, data validation,
slicers, custom XML) from every sheet, so this engine edits the sheet XML directly and copies every
other part through byte for byte. Ported from the Cerea 0.29.0 xlsx_patch helper."""

from __future__ import annotations

import datetime as _dt
import io
import re
from collections.abc import Callable
from typing import Any

from lxml import etree

from .errors import PatchError
from .images_ref import ImageSet
from .pkg import OD_REL, Pkg, add_media, add_override, add_rel, relative_target
from .xmlsafe import El, parse

FORMAT = "xlsx"
NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
RNS = OD_REL
WS_REL = RNS + "/worksheet"
STRICT_NS = "http://purl.oclc.org/ooxml/spreadsheetml/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"
XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
WORKBOOK = "xl/workbook.xml"
CALC_CHAIN = "xl/calcChain.xml"
WS_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
DRAWING_CT = "application/vnd.openxmlformats-officedocument.drawing+xml"
EDITABLE = re.compile(
    r"^(xl/worksheets/(_rels/)?[^/]+|xl/workbook\.xml|xl/_rels/workbook\.xml\.rels|\[Content_Types\]\.xml"
    r"|xl/calcChain\.xml|xl/drawings/(_rels/)?[^/]+|xl/media/[^/]+)$"
)
MAX_COL, MAX_ROW = 16384, 1048576
MAX_READ_CELLS = 100_000
EMU_PX = 9525
_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_REF = re.compile(r"^([A-Z]{1,3})([1-9][0-9]*)$")
_BAD_SHEET_CHARS = re.compile(r"[\[\]:*?/\\]")


def _q(tag: str) -> str:
    return f"{{{NS}}}{tag}"


def _col2n(c: str) -> int:
    n = 0
    for ch in c:
        n = n * 26 + ord(ch) - 64
    return n


def _n2col(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _split_ref(ref: str) -> tuple[str, int]:
    m = _REF.match(str(ref).replace("$", "").upper())
    if not m or _col2n(m.group(1)) > MAX_COL or int(m.group(2)) > MAX_ROW:
        raise PatchError(f"bad cell reference {ref!r}; use A1 style within A1:XFD1048576")
    return m.group(1), int(m.group(2))


def _range(ref: str) -> tuple[int, int, int, int]:
    a, _, b = ref.partition(":")
    (c1, r1), (c2, r2) = _split_ref(a), _split_ref(b or a)
    return min(_col2n(c1), _col2n(c2)), min(r1, r2), max(_col2n(c1), _col2n(c2)), max(r1, r2)


# ---- workbook structure ---------------------------------------------------------


def _sheets(pkg: Pkg) -> list[tuple[str, str, str, str, str]]:
    """[(name, part, state, sheetId, rel_type)] in workbook order."""
    if not pkg.has(WORKBOOK):
        raise PatchError("this is not an .xlsx package (it has no xl/workbook.xml)")
    wb = pkg.tree(WORKBOOK)
    if etree.QName(wb).namespace == STRICT_NS:
        raise PatchError("strict OOXML workbooks are not supported; save as a normal .xlsx first")
    rmap = {i: (t, typ) for i, typ, t, _m in pkg.rels(WORKBOOK)}
    out = []
    sh = wb.find(_q("sheets"))
    for s in sh if sh is not None else []:
        rid = s.get(f"{{{RNS}}}id") or ""
        if rid not in rmap:
            raise PatchError(f"sheet {s.get('name')!r} points at a missing relationship")
        tgt, typ = rmap[rid]
        out.append((s.get("name") or "", tgt, s.get("state", "visible"), s.get("sheetId") or "", typ))
    return out


def _sheet(pkg: Pkg, name: str) -> tuple[str, str, str]:
    sheets = _sheets(pkg)
    hit = [s for s in sheets if s[0] == name]
    if not hit:
        raise PatchError(f"no sheet {name!r}; the sheets are {[s[0] for s in sheets]}")
    nm, part, _st, sid, typ = hit[0]
    if typ != WS_REL:
        raise PatchError(f"{nm!r} is not a plain worksheet (a chart sheet or similar)")
    if not pkg.has(part):
        raise PatchError(f"sheet part {part} is missing from the package")
    return nm, part, sid


def _date1904(pkg: Pkg) -> bool:
    pr = pkg.tree(WORKBOOK).find(_q("workbookPr"))
    return pr is not None and pr.get("date1904") in ("1", "true")


def _shared_strings(pkg: Pkg) -> list[str]:
    parts = [t for _i, typ, t, _m in pkg.rels(WORKBOOK) if typ.endswith("/sharedStrings")]
    if not parts or not pkg.has(parts[0]):
        return []
    out = []
    for si in pkg.tree(parts[0]).findall(_q("si")):
        out.append(
            "".join(t.text or "" for t in si.iter(_q("t")) if not any(a.tag == _q("rPh") for a in t.iterancestors()))
        )
    return out


# ---- values -----------------------------------------------------------------------


class Formula(str):
    """A formula; the leading '=' is optional. Written without a cached value."""


class CellValue:
    def __init__(self, value: Any, style_from: str | None = None) -> None:
        self.value, self.style_from = value, style_from


def _serial(v: Any, date1904: bool) -> float:
    epoch = _dt.datetime(1904, 1, 1) if date1904 else _dt.datetime(1899, 12, 30)
    d = v.replace(tzinfo=None) - epoch if isinstance(v, _dt.datetime) else _dt.datetime(v.year, v.month, v.day) - epoch
    return d.days + d.seconds / 86400 + d.microseconds / 86400e6


def _write_value(cell: El, v: Any, style: str | None, date1904: bool) -> None:
    """Rewrite one <c> element in place."""
    f = cell.find(_q("f"))
    if f is not None and f.get("t") in ("shared", "array", "dataTable") and f.get("ref"):
        raise PatchError(
            f"{cell.get('r')} is the master of a {f.get('t')} formula over {f.get('ref')}; refusing (would orphan the "
            "cells that depend on it). Write to a different cell."
        )
    for ch in list(cell):
        cell.remove(ch)
    for a in ("t", "cm", "vm"):
        cell.attrib.pop(a, "")
    if style is not None:
        cell.set("s", str(style))
    if v is None:
        return
    if isinstance(v, Formula):
        txt = str(v)
        etree.SubElement(cell, _q("f")).text = txt[1:] if txt.startswith("=") else txt
    elif isinstance(v, bool):
        cell.set("t", "b")
        etree.SubElement(cell, _q("v")).text = "1" if v else "0"
    elif isinstance(v, (int, float)):
        if v != v or v in (float("inf"), float("-inf")):
            raise PatchError("NaN/inf cannot be stored in a cell")
        etree.SubElement(cell, _q("v")).text = repr(v)
    elif isinstance(v, (_dt.datetime, _dt.date)):
        etree.SubElement(cell, _q("v")).text = repr(_serial(v, date1904))
    elif isinstance(v, str):
        v = _ILLEGAL.sub("", v)
        cell.set("t", "inlineStr")
        t = etree.SubElement(etree.SubElement(cell, _q("is")), _q("t"))
        t.text = v
        if v != v.strip() or "\n" in v or "  " in v:
            t.set(f"{{{XML_NS}}}space", "preserve")
    else:
        raise PatchError(f"unsupported value type {type(v).__name__} for a cell")


def _spec_to_value(ref: str, spec: Any) -> CellValue:
    """A JSON cell spec: a plain value, or {value|formula|date|datetime, style_from}."""
    if not isinstance(spec, dict):
        return CellValue(spec)
    keys = [k for k in ("value", "formula", "date", "datetime") if k in spec]
    if len(keys) != 1:
        raise PatchError(f"{ref}: give exactly one of value, formula, date or datetime (got {keys or 'none'})")
    k = keys[0]
    try:
        if k == "formula":
            v: Any = Formula(spec["formula"])
        elif k == "date":
            v = _dt.date.fromisoformat(spec["date"])
        elif k == "datetime":
            v = _dt.datetime.fromisoformat(spec["datetime"])
        else:
            v = spec["value"]
    except ValueError as exc:
        raise PatchError(f"{ref}: {k} must be ISO 8601 (e.g. 2026-01-31 or 2026-01-31T13:30:00): {exc}") from exc
    return CellValue(v, spec.get("style_from"))


# ---- session ----------------------------------------------------------------------------


class Session:
    def __init__(self, pkg: Pkg, images: ImageSet) -> None:
        self.pkg, self.images = pkg, images
        self.touched_sheets: set[str] = set()
        self.removed_formulas: dict[str, set[str]] = {}  # sheetId -> refs
        self.formulas_added = 0
        self.recalc_forced = False


def _find_cell(rows: dict[int, El], r: int, cn: int) -> El | None:
    row = rows.get(r)
    if row is not None:
        for c in row:
            if _cell_col(c) == cn:
                return c
    return None


def _cell_col(c: El) -> int:
    ref = c.get("r")
    if not ref:
        raise PatchError("a cell in this sheet has no r= reference; unsupported layout")
    return _col2n(_split_ref(ref)[0])


def _merged(root: El) -> list[tuple[int, int, int, int, str]]:
    out = []
    mc = root.find(_q("mergeCells"))
    if mc is not None:
        for m in mc:
            ref = m.get("ref") or ""
            c1, r1, c2, r2 = _range(ref)
            out.append((c1, r1, c2, r2, ref))
    return out


def _sheet_data(root: El, name: str) -> El:
    sd = root.find(_q("sheetData"))
    if sd is None:
        raise PatchError(f"sheet {name!r} has no sheetData")
    return sd


def op_set_cells(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    name, part, sheet_id = _sheet(pkg, a["sheet"])
    root = pkg.tree(part)
    sd = _sheet_data(root, name)
    date1904 = _date1904(pkg)
    rows = {int(r.get("r") or 0): r for r in sd}
    merged = _merged(root)
    todo = []
    for ref, spec in a["cells"].items():
        c, r = _split_ref(ref)
        todo.append((r, _col2n(c), c + str(r), _spec_to_value(c + str(r), spec)))
    todo.sort(key=lambda t: (t[0], t[1]))
    removed: list[str] = []
    added = created = 0
    for r, cn, ref, cv in todo:
        style: str | None = None
        if cv.style_from:
            sc, sr = _split_ref(cv.style_from)
            src_cell = _find_cell(rows, sr, _col2n(sc))
            style = src_cell.get("s") if src_cell is not None else None
        for c1, r1, c2, r2, rng in merged:
            if c1 <= cn <= c2 and r1 <= r <= r2 and (cn, r) != (c1, r1):
                raise PatchError(f"{ref} is inside the merged range {rng}; write to its top-left cell")
        row = rows.get(r)
        if row is None:
            row = etree.Element(_q("row"))
            row.set("r", str(r))
            before = [k for k in rows if k < r]
            if before:
                rows[max(before)].addnext(row)
            else:
                sd.insert(0, row)
            rows[r] = row
        row.attrib.pop("spans", "")
        cell = _find_cell(rows, r, cn)
        if cell is None:
            cell = etree.Element(_q("c"))
            cell.set("r", ref)
            prev = None
            for sib in row:
                if _cell_col(sib) < cn:
                    prev = sib
            if prev is not None:
                prev.addnext(cell)
            else:
                row.insert(0, cell)
            created += 1
            if style is None and row.get("s") and row.get("customFormat") in ("1", "true"):
                style = row.get("s")
        had_formula = cell.find(_q("f")) is not None
        _write_value(cell, cv.value, style, date1904)
        if isinstance(cv.value, Formula):
            added += 1
        elif had_formula:
            removed.append(ref)
    pkg.touch(part)
    ctx.touched_sheets.add(part)
    ctx.formulas_added += added
    ctx.removed_formulas.setdefault(sheet_id, set()).update(removed)
    return {
        "sheet": name,
        "cells_set": len(todo),
        "cells_created": created,
        "formulas_added": added,
        "formula_cells_replaced": removed,
    }


def op_clear_cells(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    name, part, sheet_id = _sheet(pkg, a["sheet"])
    root = pkg.tree(part)
    sd = _sheet_data(root, name)
    boxes = [_range(r) for r in a["ranges"]]
    cleared: list[str] = []
    removed: list[str] = []
    for row in sd:
        r = int(row.get("r") or 0)
        for cell in row:
            cn = _cell_col(cell)
            if any(c1 <= cn <= c2 and r1 <= r <= r2 for c1, r1, c2, r2 in boxes):
                v = cell.find(_q("v"))
                if cell.find(_q("f")) is None and cell.find(_q("is")) is None and (v is None or not v.text):
                    continue  # already empty
                had = cell.find(_q("f")) is not None
                ref = cell.get("r") or ""
                _write_value(cell, None, None, False)
                cleared.append(ref)
                if had:
                    removed.append(ref)
    pkg.touch(part)
    ctx.touched_sheets.add(part)
    ctx.removed_formulas.setdefault(sheet_id, set()).update(removed)
    return {"sheet": name, "cells_cleared": len(cleared), "formula_cells_cleared": removed}


def op_add_sheet(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    name = a["name"]
    sheets = _sheets(pkg)
    if (
        len(name) > 31
        or _BAD_SHEET_CHARS.search(name)
        or name.startswith("'")
        or name.endswith("'")
        or not name.strip()
    ):
        raise PatchError(
            f"{name!r} is not a valid sheet name (1-31 characters, none of [ ] : * ? / \\, no leading or trailing apostrophe)"
        )
    if name.casefold() in {s[0].casefold() for s in sheets}:
        raise PatchError(f"a sheet named {name!r} already exists; the sheets are {[s[0] for s in sheets]}")
    n = (
        max([int(m.group(1)) for x in pkg.names for m in [re.match(r"xl/worksheets/sheet(\d+)\.xml$", x)] if m] or [0])
        + 1
    )
    part = f"xl/worksheets/sheet{n}.xml"
    root = etree.Element(_q("worksheet"), nsmap={None: NS, "r": RNS})  # type: ignore[dict-item]
    etree.SubElement(root, _q("sheetData"))
    pkg.add_tree(part, root)
    add_override(pkg, part, WS_CT)
    rid = add_rel(pkg, WORKBOOK, WS_REL, relative_target(WORKBOOK, part))
    wb = pkg.tree(WORKBOOK)
    shs = wb.find(_q("sheets"))
    if shs is None:
        raise PatchError("the workbook has no sheets element")
    sid = max([int(s.get("sheetId") or 0) for s in shs] or [0]) + 1
    el = etree.SubElement(shs, _q("sheet"))
    el.set("name", name)
    el.set("sheetId", str(sid))
    el.set(f"{{{RNS}}}id", rid)
    pkg.touch(WORKBOOK)
    out = {"sheet": name, "part": part, "position": len(sheets) + 1}
    if a.get("cells"):
        out.update(op_set_cells(ctx, {"sheet": name, "cells": a["cells"]}))
    return out


_DRAWING_BEFORE = (
    "legacyDrawing",
    "legacyDrawingHF",
    "drawingHF",
    "picture",
    "oleObjects",
    "controls",
    "webPublishItems",
    "tableParts",
    "extLst",
)


def op_insert_image(ctx: Session, a: dict[str, Any]) -> dict[str, Any]:
    pkg = ctx.pkg
    img = ctx.images.get(a["image"])
    name, part, _sid = _sheet(pkg, a["sheet"])
    c, r = _split_ref(a["cell"])
    px_w, px_h = a.get("width_px"), a.get("height_px")
    if px_w is None and px_h is None:
        px_w = min(img.info.width, 800)
    if px_w is None:
        px_w = round((px_h or 1) * img.info.width / img.info.height)
    if px_h is None:
        px_h = round(px_w * img.info.height / img.info.width)
    cx, cy = int(px_w) * EMU_PX, int(px_h) * EMU_PX
    root = pkg.tree(part)
    dr = next((t for _i, typ, t, _m in pkg.rels(part) if typ.endswith("/drawing")), None)
    if dr is None:
        k = (
            max(
                [int(m.group(1)) for x in pkg.names for m in [re.match(r"xl/drawings/drawing(\d+)\.xml$", x)] if m]
                or [0]
            )
            + 1
        )
        dr = f"xl/drawings/drawing{k}.xml"
        wsdr = etree.Element(f"{{{XDR}}}wsDr", nsmap={"xdr": XDR, "a": A_NS})
        pkg.add_tree(dr, wsdr)
        add_override(pkg, dr, DRAWING_CT)
        rid = add_rel(pkg, part, RNS + "/drawing", relative_target(part, dr))
        el = etree.Element(_q("drawing"), nsmap={"r": RNS})
        el.set(f"{{{RNS}}}id", rid)
        anchor_before = next((ch for ch in root if etree.QName(ch).localname in _DRAWING_BEFORE), None)
        if anchor_before is not None:
            anchor_before.addprevious(el)
        else:
            root.append(el)
        pkg.touch(part)
    wsdr = pkg.tree(dr)
    media = add_media(pkg, "xl/media", img.data, img.info.ext, img.info.content_type)
    irid = add_rel(pkg, dr, RNS + "/image", relative_target(dr, media))
    pid = max([int(e.get("id") or 0) for e in wsdr.iter(f"{{{XDR}}}cNvPr") if (e.get("id") or "").isdigit()] or [0]) + 1
    alt = (a.get("alt") or "").replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")
    nm = a["image"].replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")
    xml = (
        f'<xdr:oneCellAnchor xmlns:xdr="{XDR}" xmlns:a="{A_NS}" xmlns:r="{RNS}">'
        f"<xdr:from><xdr:col>{_col2n(c) - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{r - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>"
        f'<xdr:ext cx="{cx}" cy="{cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="{pid}" name="{nm}" descr="{alt}"/>'
        '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
        f'<xdr:blipFill><a:blip r:embed="{irid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
        f'<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>'
        "</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>"
    )
    wsdr.append(parse(xml.encode(), "anchor"))
    pkg.touch(dr)
    return {"sheet": name, "cell": f"{c}{r}", "part": media, "size_px": [int(px_w), int(px_h)]}


# ---- finish: dimension, calcChain, recalculation ----------------------------------------------


def finish(ctx: Session) -> dict[str, Any]:
    pkg = ctx.pkg
    for part in sorted(ctx.touched_sheets):
        root = pkg.tree(part)
        dim = root.find(_q("dimension"))
        sd = root.find(_q("sheetData"))
        if dim is not None and sd is not None:
            cs: list[int] = []
            rs: list[int] = []
            for row in sd:
                for c in row:
                    col, rw = _split_ref(c.get("r") or "")
                    cs.append(_col2n(col))
                    rs.append(rw)
            if cs:
                dim.set("ref", f"{_n2col(min(cs))}{min(rs)}:{_n2col(max(cs))}{max(rs)}")
    removed_any = any(ctx.removed_formulas.values())
    if removed_any and pkg.has(CALC_CHAIN):  # drop entries of cells that no longer hold formulas
        cc = pkg.tree(CALC_CHAIN)
        cur_i: str | None = None
        for c in list(cc):
            if c.get("i") is not None:
                cur_i = c.get("i")
            if cur_i is not None and c.get("r") in ctx.removed_formulas.get(cur_i, set()):
                nxt = c.getnext()
                if c.get("i") is not None and nxt is not None and nxt.get("i") is None:
                    nxt.set("i", c.get("i") or "")  # the sheet marker moves to the next entry
                cc.remove(c)
        pkg.touch(CALC_CHAIN)
    if ctx.formulas_added or removed_any:
        wb = pkg.tree(WORKBOOK)
        cp = wb.find(_q("calcPr"))
        if cp is None:
            cp = etree.Element(_q("calcPr"))
            nxt = next(
                (
                    ch
                    for ch in wb
                    if etree.QName(ch).localname
                    in (
                        "oleSize",
                        "customWorkbookViews",
                        "pivotCaches",
                        "smartTagPr",
                        "smartTagTypes",
                        "webPublishing",
                        "fileRecoveryPr",
                        "webPublishObjects",
                        "extLst",
                    )
                ),
                None,
            )
            if nxt is not None:
                nxt.addprevious(cp)
            else:
                wb.append(cp)
        cp.set("fullCalcOnLoad", "1")
        pkg.touch(WORKBOOK)
        ctx.recalc_forced = True
    return {"recalculate_on_open": ctx.recalc_forced}


# ---- cell maps: read and diff ---------------------------------------------------------------------


def _cell_value(c: El, sst: list[str]) -> Any:
    t = c.get("t")
    if t == "inlineStr":
        return "".join(x.text or "" for x in c.iter(_q("t")))
    v = c.find(_q("v"))
    if v is None or v.text is None:
        return None
    if t == "s":
        i = int(v.text)
        return sst[i] if 0 <= i < len(sst) else None
    if t == "b":
        return v.text in ("1", "true")
    if t in ("str", "e", "d"):
        return v.text
    try:
        f = float(v.text)
    except ValueError:
        return v.text
    return int(f) if f.is_integer() and abs(f) < 1e15 and "." not in v.text and "e" not in v.text.lower() else f


def _cells_of(
    pkg: Pkg, part: str, sst: list[str], box: tuple[int, int, int, int] | None = None
) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    sd = pkg.tree(part).find(_q("sheetData"))
    for row in sd if sd is not None else []:
        r = int(row.get("r") or 0)
        if box and not box[1] <= r <= box[3]:
            continue
        for c in row:
            ref = c.get("r") or ""
            if box and not box[0] <= _cell_col(c) <= box[2]:
                continue
            item: dict[str, Any] = {}
            f = c.find(_q("f"))
            if f is not None:
                item["formula"] = (
                    "=" + (f.text or "") if f.text else ("(shared formula)" if f.get("t") == "shared" else "")
                )
            val = _cell_value(c, sst)
            if val is not None:
                item["value"] = val
            if item:
                out[ref] = item
    return out


def read(pkg: Pkg, targets: list[dict[str, Any]]) -> dict[str, Any]:
    sst = _shared_strings(pkg)
    out = []
    for t in targets:
        name, part, _sid = _sheet(pkg, t["sheet"])
        box = _range(t["range"]) if t.get("range") else None
        if box and (box[2] - box[0] + 1) * (box[3] - box[1] + 1) > MAX_READ_CELLS * 100:
            raise PatchError(f"range {t['range']} is too large to read at once; read it in parts")
        cells = _cells_of(pkg, part, sst, box)
        if len(cells) > MAX_READ_CELLS:
            raise PatchError(f"{len(cells)} cells in range; the limit per read is {MAX_READ_CELLS}. Narrow the range.")
        out.append({"sheet": name, "range": t.get("range"), "cells": cells})
    return {"targets": out}


def _dimension(pkg: Pkg, part: str) -> str | None:
    it = etree.iterparse(
        io.BytesIO(pkg.read(part)),
        events=("start",),
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        huge_tree=False,
    )
    for _ev, el in it:
        if el.tag == _q("dimension"):
            return str(el.get("ref")) if el.get("ref") else None
        if el.tag == _q("sheetData"):
            return None
    return None


def outline(pkg: Pkg) -> dict[str, Any]:
    wb = pkg.tree(WORKBOOK)
    out = []
    for name, part, state, sid, typ in _sheets(pkg):
        item: dict[str, Any] = {"name": name, "state": state, "sheet_id": sid, "part": part}
        if typ != WS_REL:
            item["kind"] = "chartsheet or other"
            out.append(item)
            continue
        item["used_range"] = _dimension(pkg, part)
        tables, charts, images = [], 0, 0
        for _i, rtyp, tgt, _m in pkg.rels(part):
            if rtyp.endswith("/table") and pkg.has(tgt):
                tr = pkg.tree(tgt)
                tables.append({"name": tr.get("displayName") or tr.get("name"), "ref": tr.get("ref")})
            elif rtyp.endswith("/drawing") and pkg.has(tgt):
                for _j, dtyp, dt, _dm in pkg.rels(tgt):
                    charts += dtyp.endswith("/chart")
                    images += dtyp.endswith("/image") and pkg.has(dt)
        item.update(tables=tables, charts=charts, images=images)
        item["merged_ranges"] = len(_merged(pkg.tree(part)))
        out.append(item)
    names = []
    dn = wb.find(_q("definedNames"))
    for d in dn if dn is not None else []:
        names.append({"name": d.get("name"), "ref": d.text})
    return {"sheets": out, "defined_names": names, "date1904": _date1904(pkg)}


def diff_text(a: Pkg, b: Pkg) -> list[str]:
    """Changed cells per sheet ("Sheet!B2: 'old' -> 'new'"), added sheets, image counts."""
    sa, sb = _shared_strings(a), _shared_strings(b)
    before = {n: (p, t) for n, p, _s, _i, t in _sheets(a)}
    out: list[str] = []
    for name, part, _st, _sid, typ in _sheets(b):
        if typ != WS_REL:
            continue
        if name not in before:
            out.append(f"+ sheet {name!r} added")
            new = _cells_of(b, part, sb)
            old: dict[str, dict[str, Any]] = {}
        else:
            opart = before[name][0]
            if a.has(opart) and b.has(part) and a.read(opart) == b.read(part):
                continue
            old, new = _cells_of(a, opart, sa), _cells_of(b, part, sb)
        for ref in sorted(set(old) | set(new), key=lambda r: (_split_ref(r)[1], _col2n(_split_ref(r)[0]))):
            o, n = old.get(ref), new.get(ref)
            if o != n:
                out.append(f"{name}!{ref}: {_show(o)} -> {_show(n)}")
        ia = sum(1 for x in a.names if x.startswith("xl/media/"))
        ib = sum(1 for x in b.names if x.startswith("xl/media/"))
        if ia != ib and not any(line.startswith("images:") for line in out):
            out.append(f"images: {ia} -> {ib}")
    if len(out) > 200:
        out = [*out[:200], f"... and {len(out) - 200} more changes"]
    return out


def _show(c: dict[str, Any] | None) -> str:
    if not c:
        return "(empty)"
    return c.get("formula") or repr(c.get("value"))


def start(pkg: Pkg, track: bool, author: str, images: ImageSet) -> Session:
    if track:
        raise PatchError("track_changes is only available for Word documents")
    _sheets(pkg)
    return Session(pkg, images)


_REFPAT = r"^[A-Za-z]{1,3}[0-9]+$"
_RANGEPAT = r"^[A-Za-z]{1,3}[0-9]+(:[A-Za-z]{1,3}[0-9]+)?$"
_PRIM = {"type": ["string", "number", "boolean", "null"]}
_CELL = {
    "anyOf": [
        _PRIM,
        {
            "type": "object",
            "properties": {
                "value": _PRIM,
                "formula": {"type": "string", "minLength": 1},
                "date": {"type": "string"},
                "datetime": {"type": "string"},
                "style_from": {"type": "string", "pattern": _REFPAT},
            },
            "additionalProperties": False,
            "minProperties": 1,
        },
    ]
}
_SHEET = {"type": "string", "minLength": 1}


def _schema(props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {"op": {"type": "string"}, **props},
        "required": ["op", *required],
        "additionalProperties": False,
    }


_CELLS = {
    "type": "object",
    "minProperties": 1,
    "maxProperties": 50000,
    "propertyNames": {"pattern": _REFPAT},
    "additionalProperties": _CELL,
}
OPS: dict[str, tuple[dict[str, Any], Callable[[Session, dict[str, Any]], dict[str, Any]]]] = {
    "set_cells": (_schema({"sheet": _SHEET, "cells": _CELLS}, ["sheet", "cells"]), op_set_cells),
    "clear_cells": (
        _schema(
            {
                "sheet": _SHEET,
                "ranges": {"type": "array", "minItems": 1, "items": {"type": "string", "pattern": _RANGEPAT}},
            },
            ["sheet", "ranges"],
        ),
        op_clear_cells,
    ),
    "add_sheet": (_schema({"name": {"type": "string", "minLength": 1}, "cells": _CELLS}, ["name"]), op_add_sheet),
    "insert_image": (
        _schema(
            {
                "sheet": _SHEET,
                "cell": {"type": "string", "pattern": _REFPAT},
                "image": {"type": "string"},
                "width_px": {"type": "integer", "minimum": 1, "maximum": 10000},
                "height_px": {"type": "integer", "minimum": 1, "maximum": 10000},
                "alt": {"type": "string"},
            },
            ["sheet", "cell", "image"],
        ),
        op_insert_image,
    ),
}
DEFERRED = ["insert_rows", "delete_rows", "insert_chart"]


def summary(pkg: Pkg) -> dict[str, Any]:
    return {}
