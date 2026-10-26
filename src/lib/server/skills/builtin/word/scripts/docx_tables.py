"""docx_tables - table edits for docx_edit (write both files into the working
directory). Cells are addressed by table id from outline() plus 0-based row and
column; every function takes src, dst and track_changes=True, author="...".

    import docx_tables as dt
    dt.set_table_cell("in.docx", "out.docx", "t1", 2, 1, "42")
    dt.add_table_row("in.docx", "out.docx", "t1", ["Total", "99"])

Licence: Apache-2.0, as the rest of this repository. Original work.
"""

import copy

from lxml import etree

from docx_edit import P, R, RPR, TBL, TC, TR, PatchError, _add_run, _block, _main, _para_rpr, _run, _set_text, w


def _cell(pkg, table, row, col):
    tbl = _block(pkg, table)
    if tbl.tag != TBL:
        raise PatchError("%r is a paragraph, not a table" % table)
    rows = tbl.findall(TR)
    if not 0 <= row < len(rows):
        raise PatchError("%s has %d rows (0-based); row %d does not exist" % (table, len(rows), row))
    cells = rows[row].findall(TC)
    if not 0 <= col < len(cells):
        raise PatchError("%s row %d has %d cells (0-based); column %d does not exist" % (table, row, len(cells), col))
    return tbl, rows, cells[col]


def _first_rpr(tc):
    for r in tc.iter(R):
        if r.find(RPR) is not None:
            return r.find(RPR)
    return None


def set_table_cell(src, dst, table, row, col, text, track_changes=False, author="Cerea"):
    """Set one cell's text, keeping its formatting (an empty cell borrows the
    run formatting of the cell above it)."""
    def job(pkg, ctx):
        tbl, rows, tc = _cell(pkg, table, row, col)
        above = rows[row - 1].findall(TC) if row else []
        fb = _first_rpr(above[col]) if col < len(above) else None
        ps = tc.findall(P)
        for extra in ps[1:]:
            if ctx.tr:
                _set_text(ctx, extra, "")
            else:
                tc.remove(extra)
        _set_text(ctx, ps[0], text, fb)
        pkg.touch(_main(pkg))
        return {"cell": "%s r%d c%d" % (table, row, col)}

    return _run(src, dst, track_changes, author, job)


def add_table_row(src, dst, table, values, after=None, track_changes=False, author="Cerea"):
    """Add a row of `values` after row `after` (default: the last row), cloned
    from that row so borders, shading and run formatting carry over."""
    def job(pkg, ctx):
        tbl = _block(pkg, table)
        if tbl.tag != TBL:
            raise PatchError("%r is a paragraph, not a table" % table)
        rows = tbl.findall(TR)
        idx = len(rows) - 1 if after is None else after
        if not 0 <= idx < len(rows):
            raise PatchError("%s has %d rows (0-based); row %s does not exist" % (table, len(rows), after))
        new = copy.deepcopy(rows[idx])
        tcs = new.findall(TC)
        if len(values) > len(tcs):
            raise PatchError("row has %d cells but %d values were given (merged cells count once)" % (len(tcs), len(values)))
        for e in new.iter():
            for a in [a for a in e.attrib if a.endswith("}paraId") or a.endswith("}textId")]:
                del e.attrib[a]
        for e in list(new.iter(w("ins"), w("del"))):
            if e.getparent() is not None and e.getparent().tag == w("trPr"):
                e.getparent().remove(e)
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
                (pre.addnext(trpr) if pre is not None else new.insert(0, trpr))
            trpr.append(ctx.mk("ins"))
        rows[idx].addnext(new)
        pkg.touch(_main(pkg))
        return {"row": idx + 1, "table": table}

    return _run(src, dst, track_changes, author, job)
