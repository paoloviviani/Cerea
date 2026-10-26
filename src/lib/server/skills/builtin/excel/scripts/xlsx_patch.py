"""xlsx_patch - set cells in ONE worksheet of an existing .xlsx, touching
nothing else.

Purpose
    Edit a workbook someone supplied (a template, a report with conditional
    formatting and data validation on many sheets) and hand it back with every
    part you did not mean to change byte-for-byte identical.

Why not openpyxl load + save
    openpyxl rebuilds the whole package from its own object model. Anything it
    does not model (x14 conditional-formatting and data-validation extensions,
    slicers, custom XML, unknown parts) is silently dropped from every sheet,
    including sheets you never touched. This helper parses and rewrites only
    the target worksheet's XML and copies every other part through unchanged.
    Use openpyxl for NEW workbooks; use this for EDITING supplied ones.

Needs only the stdlib and lxml (both are in the Pyodide sandbox); openpyxl is
used by verify() when present, to confirm the result still opens.

    import xlsx_patch as xp
    rep = xp.patch_cells("in.xlsx", "out.xlsx", "Sheet1",
        {"B3": "text", "C3": 12.5, "D3": datetime.date(2026, 1, 31),
         "E3": xp.Formula("=B3*2"), "F3": None,
         "G3": xp.Cell("x", style_from="G2")})
    xp.verify("in.xlsx", "out.xlsx", "Sheet1")

Licence: Apache-2.0, as the rest of this repository. Original work.
"""

import datetime as _dt
import os
import re
import tempfile
import zipfile

from lxml import etree

__all__ = ["Formula", "Cell", "PatchError", "sheet_names", "patch_cells", "verify"]

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
RNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WS_REL = RNS + "/worksheet"
STRICT_NS = "http://purl.oclc.org/ooxml/spreadsheetml/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"
MAX_SHEET_BYTES = 50 * 1024 * 1024  # uncompressed sheet XML; lxml needs ~10x in memory
CALC_CHAIN = "xl/calcChain.xml"
WORKBOOK = "xl/workbook.xml"

_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_REF = re.compile(r"^([A-Z]{1,3})([1-9][0-9]*)$")


class PatchError(Exception):
    """The edit was refused or the result failed verification."""


class Formula(str):
    """A formula; the leading '=' is optional. Written without a cached value."""


class Cell:
    """A value plus a style choice. style_from="A1" copies that cell's style
    (same sheet); style=<int> uses a raw cellXfs index."""

    def __init__(self, value, style_from=None, style=None):
        self.value, self.style_from, self.style = value, style_from, style


def _col2n(c):
    n = 0
    for ch in c:
        n = n * 26 + ord(ch) - 64
    return n


def _n2col(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _split_ref(ref):
    m = _REF.match(str(ref).replace("$", "").upper())
    if not m:
        raise PatchError("bad cell reference %r" % (ref,))
    return m.group(1), int(m.group(2))


def _q(tag):
    return "{%s}%s" % (NS, tag)


def _norm(target):
    t = target.lstrip("/") if target.startswith("/") else "xl/" + target
    out = []
    for p in t.split("/"):
        if p == "..":
            if out:
                out.pop()
        elif p != ".":
            out.append(p)
    return "/".join(out)


def _sheets(z):
    """[(name, part, state, sheetId, rel_type)] in workbook order."""
    try:
        wb = etree.fromstring(z.read(WORKBOOK))
        rels = etree.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    except KeyError:
        raise PatchError("not an .xlsx package (no xl/workbook.xml)")
    if etree.QName(wb).namespace == STRICT_NS:
        raise PatchError("strict OOXML workbooks are not supported; save as a normal .xlsx first")
    rmap = {r.get("Id"): (r.get("Target"), r.get("Type")) for r in rels}
    out = []
    for s in wb.find(_q("sheets")):
        tgt, typ = rmap[s.get("{%s}id" % RNS)]
        out.append((s.get("name"), _norm(tgt), s.get("state", "visible"), s.get("sheetId"), typ))
    return out


def sheet_names(src):
    """[(name, part_path, state)] in workbook order."""
    with zipfile.ZipFile(src) as z:
        return [(n, p, st) for n, p, st, _, _ in _sheets(z)]


def _serial(v, date1904):
    epoch = _dt.datetime(1904, 1, 1) if date1904 else _dt.datetime(1899, 12, 30)
    if isinstance(v, _dt.datetime):
        d = v.replace(tzinfo=None) - epoch
    elif isinstance(v, _dt.date):
        d = _dt.datetime(v.year, v.month, v.day) - epoch
    else:  # time of day
        return (v.hour * 3600 + v.minute * 60 + v.second) / 86400
    return d.days + d.seconds / 86400 + d.microseconds / 86400e6


def _merged(root):
    out = []
    mc = root.find(_q("mergeCells"))
    if mc is not None:
        for m in mc:
            a, _, b = m.get("ref").partition(":")
            (c1, r1), (c2, r2) = _split_ref(a), _split_ref(b or a)
            out.append((_col2n(c1), r1, _col2n(c2), r2, m.get("ref")))
    return out


def _cell_col(c):
    ref = c.get("r")
    if not ref:
        raise PatchError("a cell in this sheet has no r= reference; unsupported layout")
    return _col2n(_split_ref(ref)[0])


def _write_value(cell, v, style, date1904):
    """Rewrite one <c> element in place."""
    f = cell.find(_q("f"))
    if f is not None and f.get("t") in ("shared", "array", "dataTable") and f.get("ref"):
        raise PatchError(
            "%s is the master of a %s formula over %s; refusing (would orphan the cells "
            "that depend on it). Write to a different cell." % (cell.get("r"), f.get("t"), f.get("ref"))
        )
    for ch in list(cell):
        cell.remove(ch)
    for a in ("t", "cm", "vm"):
        cell.attrib.pop(a, None)
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
    elif isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        etree.SubElement(cell, _q("v")).text = repr(_serial(v, date1904))
    elif isinstance(v, str):
        v = _ILLEGAL.sub("", v)
        cell.set("t", "inlineStr")
        t = etree.SubElement(etree.SubElement(cell, _q("is")), _q("t"))
        t.text = v
        if v != v.strip() or "\n" in v or "  " in v:
            t.set("{%s}space" % XML_NS, "preserve")
    else:
        raise PatchError("unsupported value type %s for a cell" % type(v).__name__)


def patch_cells(src, dst, sheet, cells, recalc=None):
    """Set `cells` ({"B3": value, ...}) on worksheet `sheet`; write `dst`.

    value: str (inline string) | int/float | bool | date/datetime/time (stored
           as a serial, honouring the 1904 system) | Formula("=...") |
           None (clear the value, keep the style) | Cell(value, style_from=/style=).
    A cell keeps its existing style unless a Cell(...) says otherwise; dates
    need a date-formatted cell (or Cell(style_from=<a date cell>)) to display
    as dates. `dst` may equal `src`.
    recalc: set fullCalcOnLoad so Excel recomputes on open (default: only when
            formulas were added or removed).
    Returns {"sheet", "part", "cells_set", "cells_created", "formulas_added",
    "formula_cells_replaced", "changed_parts"}. Raises PatchError on refusal.
    """
    with zipfile.ZipFile(src) as z:
        infos = z.infolist()
        sheets = _sheets(z)
        hit = [s for s in sheets if s[0] == sheet]
        if not hit:
            raise PatchError("no sheet %r; the sheets are %s" % (sheet, [s[0] for s in sheets]))
        name, part, _state, sheet_id, typ = hit[0]
        if typ != WS_REL:
            raise PatchError("%r is not a plain worksheet (a chart sheet or similar)" % sheet)
        try:
            if z.getinfo(part).file_size > MAX_SHEET_BYTES:
                raise PatchError(
                    "sheet %r is larger than %d MB of XML; too big to patch safely here"
                    % (sheet, MAX_SHEET_BYTES >> 20)
                )
        except KeyError:
            raise PatchError("sheet part %s is missing from the package" % part)
        data = {i.filename: z.read(i.filename) for i in infos}

    wbxml = data[WORKBOOK]
    date1904 = re.search(rb'<workbookPr[^>]*date1904="(1|true)"', wbxml) is not None
    root = etree.fromstring(data[part])
    sd = root.find(_q("sheetData"))
    if sd is None:
        raise PatchError("sheet %r has no sheetData" % sheet)
    rows = {int(r.get("r")): r for r in sd}
    merged = _merged(root)

    def find_cell(r, cn):
        row = rows.get(r)
        if row is not None:
            for c in row:
                if _cell_col(c) == cn:
                    return c
        return None

    todo = []
    for ref, v in cells.items():
        c, r = _split_ref(ref)
        todo.append((r, _col2n(c), c + str(r), v))
    todo.sort(key=lambda t: (t[0], t[1]))

    removed, added, created = [], 0, 0
    for r, cn, ref, v in todo:
        style = None
        if isinstance(v, Cell):
            if v.style is not None:
                style = v.style
            elif v.style_from:
                sc, sr = _split_ref(v.style_from)
                src_cell = find_cell(sr, _col2n(sc))
                style = src_cell.get("s") if src_cell is not None else None
            v = v.value
        for c1, r1, c2, r2, a in merged:
            if c1 <= cn <= c2 and r1 <= r <= r2 and (cn, r) != (c1, r1):
                raise PatchError("%s is inside the merged range %s; write to its top-left cell" % (ref, a))
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
        row.attrib.pop("spans", None)
        cell = find_cell(r, cn)
        if cell is None:
            cell = etree.Element(_q("c"))
            cell.set("r", ref)
            prev = None
            for c in row:
                if _cell_col(c) < cn:
                    prev = c
            if prev is not None:
                prev.addnext(cell)
            else:
                row.insert(0, cell)
            created += 1
            if style is None and row.get("s") and row.get("customFormat") in ("1", "true"):
                style = row.get("s")
        had_formula = cell.find(_q("f")) is not None
        _write_value(cell, v, style, date1904)
        if isinstance(v, Formula):
            added += 1
        elif had_formula:
            removed.append(ref)

    dim = root.find(_q("dimension"))
    if dim is not None:
        cs, rs = [], []
        for row in sd:
            for c in row:
                a, b = _split_ref(c.get("r"))
                cs.append(_col2n(a))
                rs.append(b)
        if cs:
            dim.set("ref", "%s%d:%s%d" % (_n2col(min(cs)), min(rs), _n2col(max(cs)), max(rs)))

    changed = {part: etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)}

    if removed and CALC_CHAIN in data:  # drop entries of cells that no longer hold formulas
        cc = etree.fromstring(data[CALC_CHAIN])
        gone, cur_i = set(removed), None
        for c in list(cc):
            if c.get("i") is not None:
                cur_i = c.get("i")
            if cur_i == sheet_id and c.get("r") in gone:
                nxt = c.getnext()
                if c.get("i") is not None and nxt is not None and nxt.get("i") is None:
                    nxt.set("i", c.get("i"))  # the sheet marker moves to the next entry
                cc.remove(c)
        changed[CALC_CHAIN] = etree.tostring(cc, xml_declaration=True, encoding="UTF-8", standalone=True)

    if recalc is None:
        recalc = bool(added or removed)
    if recalc:
        s = wbxml.decode("utf-8")
        if "<calcPr" in s:
            def fix(m):
                t = re.sub(r'\s+fullCalcOnLoad="[^"]*"', "", m.group(0))
                return t.replace("<calcPr", '<calcPr fullCalcOnLoad="1"', 1)
            s = re.sub(r"<calcPr[^>]*?/?>", fix, s, count=1)
        else:
            s = re.sub(r"</(\w+:)?workbook>\s*$", lambda m: '<calcPr fullCalcOnLoad="1"/>' + m.group(0), s)
        changed[WORKBOOK] = s.encode("utf-8")

    _write(infos, data, changed, dst)
    return {
        "sheet": name,
        "part": part,
        "cells_set": len(todo),
        "cells_created": created,
        "formulas_added": added,
        "formula_cells_replaced": removed,
        "changed_parts": sorted(changed),
    }


def _write(infos, data, changed, dst):
    """Rezip: same part order and names, a FRESH ZipInfo per entry. Reusing a
    ZipInfo read from the source archive carries its old CRC and sizes and
    yields a corrupt file once the data changes."""
    fd, tmp = tempfile.mkstemp(suffix=".xlsx", dir=os.path.dirname(os.path.abspath(dst)))
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, "w") as out:
            for i in infos:
                zi = zipfile.ZipInfo(i.filename, date_time=i.date_time)
                zi.compress_type = i.compress_type if i.compress_type in (0, 8) else zipfile.ZIP_DEFLATED
                zi.external_attr = i.external_attr
                zi.create_system = i.create_system
                out.writestr(zi, changed.get(i.filename, data[i.filename]))
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def verify(src, dst, sheet):
    """Raise PatchError unless `dst` is a sound edit of `src` confined to
    worksheet `sheet`: valid zip (CRC), same parts in the same order, every
    part except that sheet (plus workbook.xml's calcPr and calcChain.xml)
    byte-identical, changed XML well-formed, and the file reopens in openpyxl
    (read-only) when openpyxl is installed. Returns a summary dict."""
    with zipfile.ZipFile(src) as a:
        hit = [s for s in _sheets(a) if s[0] == sheet]
    if not hit:
        raise PatchError("no sheet %r in the source workbook" % sheet)
    part = hit[0][1]
    with zipfile.ZipFile(src) as a, zipfile.ZipFile(dst) as b:
        bad = b.testzip()
        if bad:
            raise PatchError("CRC failure in %s" % bad)
        if [i.filename for i in a.infolist()] != [i.filename for i in b.infolist()]:
            raise PatchError("the part list or order differs from the source")
        diff = [n for n in a.namelist() if a.read(n) != b.read(n)]
        unexpected = sorted(set(diff) - {part, WORKBOOK, CALC_CHAIN})
        if unexpected:
            raise PatchError("parts changed that should not have: %s" % unexpected)
        if WORKBOOK in diff:
            strip = lambda d: re.sub(rb'\s+fullCalcOnLoad="[^"]*"', b"", d)
            if strip(a.read(WORKBOOK)) != strip(b.read(WORKBOOK)):
                raise PatchError("workbook.xml changed beyond fullCalcOnLoad")
        for n in diff:
            if n.endswith((".xml", ".rels")):
                try:
                    etree.fromstring(b.read(n))
                except etree.XMLSyntaxError as e:
                    raise PatchError("%s is not well-formed XML: %s" % (n, e))
        total, same = len(a.namelist()), len(a.namelist()) - len(diff)
    try:
        import openpyxl
    except ImportError:
        openpyxl = None
    if openpyxl is not None:
        try:
            openpyxl.load_workbook(dst, read_only=True).close()
        except Exception as e:
            raise PatchError("openpyxl cannot reopen the result: %s" % e)
    return {"parts": total, "byte_identical": same, "changed": sorted(diff)}
