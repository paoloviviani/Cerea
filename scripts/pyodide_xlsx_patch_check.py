"""Checks for the excel skill's bundled xlsx_patch.py. Runs unchanged in
CPython and in the vendored Pyodide (driven by pyodide_skills_check.mjs).

The fixture is generated, not committed: an openpyxl workbook post-processed
at the XML level to carry what openpyxl itself would drop on load+save (x14
conditional-formatting and data-validation extensions on several sheets), plus
a merged range, a shared formula and a calcChain. Licence: Apache-2.0.
"""

import datetime
import re
import zipfile

import openpyxl
from openpyxl.worksheet.datavalidation import DataValidation

SHEETS = ["Cover", "T1.1", "T2.4", "Lists", "Summary"]
TARGET = "T2.4"
MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

X14 = (
    '<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" '
    'xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">'
    '<x14:conditionalFormattings><x14:conditionalFormatting '
    'xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">'
    '<x14:cfRule type="dataBar" id="{A1B2C3D4-0000-0000-0000-%(n)012d}"><x14:dataBar '
    'minLength="0" maxLength="100"><x14:cfvo type="autoMin"/><x14:cfvo type="autoMax"/>'
    "</x14:dataBar></x14:cfRule><xm:sqref>B2:B30</xm:sqref></x14:conditionalFormatting>"
    "</x14:conditionalFormattings></ext>"
    '<ext uri="{CCE6A557-97BC-48b9-258B-7F2B2D6A1F5B}" '
    'xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main">'
    '<x14:dataValidations xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" '
    'count="1"><x14:dataValidation type="list" allowBlank="1" showErrorMessage="1">'
    "<x14:formula1><xm:f>Lists!$A$2:$A$5</xm:f></x14:formula1><xm:sqref>E2:E20</xm:sqref>"
    "</x14:dataValidation></x14:dataValidations></ext></extLst>"
)


def make_fixture(path, date1904=False):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    if date1904:
        wb.epoch = openpyxl.utils.datetime.CALENDAR_MAC_1904
    for n in SHEETS:
        ws = wb.create_sheet(n)
        ws["A1"] = "Header " + n
        for r in range(2, 30):
            ws.cell(r, 1, "item %d" % r)
            ws.cell(r, 2, r * 3)
            ws.cell(r, 3, "=B%d*2" % r)
        dv = DataValidation(type="list", formula1='"a,b,c"', allow_blank=True)
        ws.add_data_validation(dv)
        dv.add("D2:D20")
    t = wb[TARGET]
    t.merge_cells("A1:C1")
    for ref in ("E2", "E3"):
        t[ref].number_format = "dd/mm/yyyy"
    wb.save(path)

    with zipfile.ZipFile(path) as z:
        parts = [(i.filename, z.read(i.filename)) for i in z.infolist()]
    out = []
    for name, d in parts:
        m = re.match(r"xl/worksheets/sheet(\d+)\.xml$", name)
        if m:
            k, s = int(m.group(1)), d.decode()
            s = s.replace("</worksheet>", X14 % {"n": k} + "</worksheet>")
            if name.endswith("sheet%d.xml" % (SHEETS.index(TARGET) + 1)):
                before = s
                s = re.sub(
                    r'(<c r="C2"[^>]*>)<f>B2\*2</f>',
                    r'\1<f t="shared" ref="C2:C10" si="0">B2*2</f>',
                    s,
                )
                for r in range(3, 11):
                    s = re.sub(
                        r'(<c r="C%d"[^>]*>)<f>B%d\*2</f>' % (r, r),
                        r'\1<f t="shared" si="0"/>',
                        s,
                    )
                assert s != before and 't="shared"' in s, "shared formula injection failed"
            d = s.encode()
        out.append((name, d))
    chain = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><calcChain xmlns="%s">' % MAIN
    for sid in range(1, len(SHEETS) + 1):
        for r in range(2, 30):
            chain += '<c r="C%d" i="%d"/>' % (r, sid) if r == 2 else '<c r="C%d"/>' % r
    chain += "</calcChain>"
    items = dict(out)
    items["[Content_Types].xml"] = (
        items["[Content_Types].xml"]
        .decode()
        .replace(
            "</Types>",
            '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-'
            'officedocument.spreadsheetml.calcChain+xml"/></Types>',
        )
        .encode()
    )
    items["xl/_rels/workbook.xml.rels"] = (
        items["xl/_rels/workbook.xml.rels"]
        .decode()
        .replace(
            "</Relationships>",
            '<Relationship Id="rIdCC" Type="http://schemas.openxmlformats.org/officeDocument/'
            '2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>',
        )
        .encode()
    )
    items["xl/calcChain.xml"] = chain.encode()
    order = [n for n, _ in out] + ["xl/calcChain.xml"]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n in order:
            z.writestr(n, items[n])


def _expect_refusal(xp, src, cells, needle, sheet=TARGET):
    try:
        xp.patch_cells(src, "/tmp/refused.xlsx", sheet, cells)
    except xp.PatchError as e:
        assert needle in str(e), (needle, str(e))
        return
    raise AssertionError("expected PatchError containing %r for %r" % (needle, cells))


def run_checks(xp, tmp="/tmp"):
    src, dst = "%s/xp-fixture.xlsx" % tmp, "%s/xp-out.xlsx" % tmp
    make_fixture(src)
    zsrc = zipfile.ZipFile(src)
    assert b"x14:" in zsrc.read("xl/worksheets/sheet2.xml")
    assert "xl/calcChain.xml" in zsrc.namelist()

    names = [n for n, _, _ in xp.sheet_names(src)]
    assert names == SHEETS, names

    # --- values, dates, formulas, new row, style copy, clear -------------
    cells = {
        "B2": "Hello & <world>",
        "B3": 42,
        "B4": 3.14,
        "E2": datetime.date(2026, 1, 31),
        "E3": datetime.datetime(2026, 2, 1, 13, 30),
        "F20": "  spaced\nline",
        "G5": True,
        "H5": xp.Formula("=B5*10"),
        "A40": "new row",
        "A41": xp.Cell("styled", style_from="A2"),
        "D3": None,
    }
    rep = xp.patch_cells(src, dst, TARGET, cells)
    assert rep["changed_parts"] == ["xl/workbook.xml", "xl/worksheets/sheet3.xml"], rep
    assert rep["formulas_added"] == 1 and rep["formula_cells_replaced"] == [], rep
    summary = xp.verify(src, dst, TARGET)
    assert summary["byte_identical"] == summary["parts"] - 2, summary
    zdst = zipfile.ZipFile(dst)
    assert zdst.testzip() is None
    for n in zsrc.namelist():  # untouched parts byte-identical, x14 intact everywhere
        if n not in rep["changed_parts"]:
            assert zsrc.read(n) == zdst.read(n), n
    for n in ("xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet4.xml"):
        assert b"x14:dataBar" in zdst.read(n), n
    assert b'fullCalcOnLoad="1"' in zdst.read("xl/workbook.xml")

    ws = openpyxl.load_workbook(dst)[TARGET]
    assert ws["B2"].value == "Hello & <world>", ws["B2"].value
    assert ws["B3"].value == 42 and ws["B4"].value == 3.14
    assert ws["E2"].value == datetime.datetime(2026, 1, 31), ws["E2"].value
    assert ws["E2"].number_format == "dd/mm/yyyy"
    assert ws["E3"].value == datetime.datetime(2026, 2, 1, 13, 30), ws["E3"].value
    assert ws["F20"].value == "  spaced\nline", repr(ws["F20"].value)
    assert ws["G5"].value is True
    assert ws["H5"].value == "=B5*10", ws["H5"].value
    assert ws["A40"].value == "new row"
    assert ws["A41"].value == "styled" and ws["A41"].style_id == ws["A2"].style_id
    assert ws["D3"].value is None
    assert ws["C3"].value == "=B3*2", ws["C3"].value  # shared dependant still intact
    assert ws.max_row == 41 and ws.merged_cells.ranges
    assert "A1:C1" in {str(r) for r in ws.merged_cells.ranges}

    # --- in-place edit ----------------------------------------------------
    import shutil

    shutil.copy(src, "%s/xp-inplace.xlsx" % tmp)
    r2 = xp.patch_cells("%s/xp-inplace.xlsx" % tmp, "%s/xp-inplace.xlsx" % tmp, TARGET, {"B2": "x"})
    assert zipfile.ZipFile("%s/xp-inplace.xlsx" % tmp).testzip() is None and r2["cells_set"] == 1

    # --- replacing a formula cell removes its calcChain entry -------------
    r3 = xp.patch_cells(src, dst, TARGET, {"C4": 99})  # shared dependant
    assert set(r3["changed_parts"]) == {"xl/calcChain.xml", "xl/workbook.xml", "xl/worksheets/sheet3.xml"}
    xp.verify(src, dst, TARGET)
    before = zsrc.read("xl/calcChain.xml").decode().count("<c ")
    chain = zipfile.ZipFile(dst).read("xl/calcChain.xml").decode()
    assert chain.count("<c ") == before - 1 and 'r="C4"' not in chain.split('i="3"')[1].split('i="4"')[0]
    assert '<c r="C2" i="3"/>' in chain  # sheet marker of other sheets untouched

    # --- 1904 date system ---------------------------------------------------
    f1904 = "%s/xp-1904.xlsx" % tmp
    make_fixture(f1904, date1904=True)
    xp.patch_cells(f1904, "%s/xp-1904o.xlsx" % tmp, TARGET, {"E2": datetime.date(2026, 1, 31)})
    got = openpyxl.load_workbook("%s/xp-1904o.xlsx" % tmp)[TARGET]["E2"].value
    assert got == datetime.datetime(2026, 1, 31), got

    # --- refusals -----------------------------------------------------------
    _expect_refusal(xp, src, {"C2": 5}, "master of a shared formula")
    _expect_refusal(xp, src, {"C2": xp.Formula("=1")}, "master of a shared formula")
    _expect_refusal(xp, src, {"B1": 1}, "merged range A1:C1")
    _expect_refusal(xp, src, {"B1": 1, "A1": 1}, "merged range A1:C1")
    _expect_refusal(xp, src, {"A1": 1}, "no sheet", sheet="nope")
    _expect_refusal(xp, src, {"A1": object()}, "unsupported value type")
    _expect_refusal(xp, src, {"not a ref": 1}, "bad cell reference")
    assert xp.patch_cells(src, dst, TARGET, {"A1": "top-left is fine"})["cells_set"] == 1

    # --- verify catches tampering -------------------------------------------
    xp.patch_cells(src, dst, TARGET, {"B2": 1})
    bad = "%s/xp-bad.xlsx" % tmp
    with zipfile.ZipFile(dst) as zi, zipfile.ZipFile(bad, "w") as zo:
        for i in zi.infolist():
            d = zi.read(i.filename)
            if i.filename == "xl/worksheets/sheet2.xml":
                d = d.replace(b"x14:", b"x15:")
            zo.writestr(i.filename, d)
    try:
        xp.verify(src, bad, TARGET)
    except xp.PatchError as e:
        assert "sheet2.xml" in str(e), e
    else:
        raise AssertionError("verify accepted a tampered untouched part")

    # --- size guard -----------------------------------------------------------
    old = xp.MAX_SHEET_BYTES
    xp.MAX_SHEET_BYTES = 100
    try:
        _expect_refusal(xp, src, {"B2": 1}, "too big")
    finally:
        xp.MAX_SHEET_BYTES = old

    # contrast: openpyxl load+save loses the extensions (why the helper exists)
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        openpyxl.load_workbook(src).save("%s/xp-opx.xlsx" % tmp)
    assert b"x14:" not in zipfile.ZipFile("%s/xp-opx.xlsx" % tmp).read("xl/worksheets/sheet2.xml")
    return "values/dates/formulas read back, %d/%d parts byte-identical, 7 refusals, verify catches tampering" % (
        summary["byte_identical"],
        summary["parts"],
    )


if __name__ == "__main__":
    import importlib.util
    import sys
    import tempfile

    spec = importlib.util.spec_from_file_location("xlsx_patch", sys.argv[1])
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    print(run_checks(mod, tempfile.mkdtemp()))
