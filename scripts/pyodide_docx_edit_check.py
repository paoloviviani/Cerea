"""Checks for the word skill's bundled docx_edit / docx_tables / docx_verify.
Runs unchanged in CPython and in the vendored Pyodide (driven by
pyodide_skills_check.mjs).

The fixture is generated, not committed: a python-docx document post-processed
so that character formatting is split mid-word across runs, with placeholders
split across runs in the body, a table, a header and a footer, a table with
shaded, formatted rows, and a real comment. Licence: Apache-2.0.
"""

import copy
import os
import re
import zipfile

import docx
from docx.enum.text import WD_COLOR_INDEX
from docx.shared import Pt, RGBColor
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

CONTENT = {"word/document.xml", "word/header1.xml", "word/footer1.xml"}


def make_fixture(path):
    d = docx.Document()
    d.add_heading("Statement of work", level=1)
    p = d.add_paragraph()
    a = p.add_run("Dear Ac")
    a.bold = True
    b = p.add_run("me L")
    b.italic = True
    b.font.color.rgb = RGBColor(0xC0, 0, 0)
    p.add_run("td, welcome")
    q = d.add_paragraph()
    x = q.add_run("Prepared for {{cli")
    x.bold = True
    y = q.add_run("ent}} on {{ date }}.")
    y.italic = True
    d.add_paragraph("Open points", style="List Bullet")
    c = d.add_paragraph()
    r1 = c.add_run("Review the ")
    r2 = c.add_run("pricing")
    r2.font.highlight_color = WD_COLOR_INDEX.YELLOW
    d.add_comment(r2, text="Check the numbers", author="Reviewer", initials="RV")
    d.add_paragraph("Keep {{other}} as it is.")
    t = d.add_table(rows=3, cols=2)
    t.style = "Table Grid"
    for i, row in enumerate(t.rows):
        for j, cell in enumerate(row.cells):
            run = cell.paragraphs[0].add_run(["Item", "Cost"][j] if i == 0 else ["Widget {{client}}", "10"][j])
            run.bold = i == 0
            run.font.size = Pt(9)
            if i == 2:
                run.font.color.rgb = RGBColor(0, 0x66, 0)
            tcpr = cell._tc.get_or_add_tcPr()
            shd = OxmlElement("w:shd")
            shd.set(qn("w:val"), "clear")
            shd.set(qn("w:fill"), "DDEEFF" if i == 0 else "F2F2F2")
            tcpr.append(shd)
    d.add_paragraph("After the table.")
    sec = d.sections[0]
    sec.header.is_linked_to_previous = False
    hp = sec.header.paragraphs[0]
    h1 = hp.add_run("Report for {{cli")
    h1.bold = True
    hp.add_run("ent}}")
    sec.footer.is_linked_to_previous = False
    fp = sec.footer.paragraphs[0]
    f1 = fp.add_run("Confidential - {{foot")
    f1.italic = True
    fp.add_run("er_note}}")
    d.save(path)


def parts(path):
    with zipfile.ZipFile(path) as z:
        return {i.filename: z.read(i.filename) for i in z.infolist()}


def untouched(src, dst, allowed):
    a, b = parts(src), parts(dst)
    assert list(a) == list(b), "part list changed"
    bad = [n for n in a if n not in allowed and a[n] != b[n]]
    assert not bad, "untouched parts changed: %s" % bad
    return len(a)


def runs_of(p):
    return [(r.text, bool(r.bold), bool(r.italic)) for r in p.runs]


def refuses(fn, needle):
    try:
        fn()
    except Exception as e:
        assert type(e).__name__ == "PatchError", repr(e)
        assert needle in str(e), "%r not in %r" % (needle, str(e))
        return
    raise AssertionError("expected a refusal containing %r" % needle)


def run_checks(mods, tmp="/tmp"):
    de, dt, dv = mods
    src, o1, o2, o3 = ("%s/de-%s.docx" % (tmp, n) for n in ("src", "o1", "o2", "o3"))
    make_fixture(src)
    before = parts(src)
    assert CONTENT <= set(before), sorted(before)

    # outline: ids, styles, placeholders, header/footer, comment
    o = de.outline(src)
    ids = {b["id"]: b for b in o["blocks"]}
    assert ids["p1"]["type"] == "heading" and ids["p1"]["level"] == 1, ids["p1"]
    assert ids["p2"]["text"] == "Dear Acme Ltd, welcome", ids["p2"]
    assert ids["t1"]["type"] == "table" and ids["t1"]["rows"] == 3 and ids["t1"]["cols"] == 2
    assert ids["t1"]["cells"][1][0] == "Widget {{client}}"
    assert o["placeholders"] == ["client", "date", "other", "footer_note"], o["placeholders"]
    assert o["comments"] == 1 and any("Report for" in "".join(v) for v in o["headers"].values())
    assert "p2 [Normal] Dear Acme Ltd, welcome" in dv.outline_text(o)

    # replace across runs: formatting of the first matched run wins, the tail keeps its own
    rep = de.replace_text(src, o1, "Acme Ltd", "Beta plc")
    assert rep["replaced"] == 1 and rep["changed_parts"] == ["word/document.xml"], rep
    p2 = docx.Document(o1).paragraphs[1]
    assert p2.text == "Dear Beta plc, welcome", p2.text
    got = runs_of(p2)
    assert "".join(t for t, b, i in got if b and not i) == "Dear Beta plc", got
    assert [t for t, b, i in got if not b and not i] == [", welcome"], got
    assert not any(i for t, b, i in got), "the italic colour run must be fully consumed"
    v = dv.verify(src, o1)
    assert v["changed"] == ["word/document.xml"], v
    assert v["text_diff"] == ["word/document.xml:", "- Dear Acme Ltd, welcome", "+ Dear Beta plc, welcome"], v["text_diff"]
    total = untouched(src, o1, {"word/document.xml"})
    assert parts(o1)["word/comments.xml"] == before["word/comments.xml"]
    xml = parts(o1)["word/document.xml"].decode()
    assert all(k in xml for k in ("commentRangeStart", "commentRangeEnd", "commentReference"))

    # placeholders split over runs: body, table, header, footer; leftovers reported
    rep = de.fill_placeholders(src, o2, {"client": "Beta plc", "date": "26 Oct 2026", "unused": "x"})
    assert rep["filled"] == {"client": 4, "date": 1}, rep
    assert rep["missing"] == ["unused"] and rep["unfilled"] == ["footer_note", "other"], rep
    assert set(rep["changed_parts"]) == {"word/document.xml", "word/header1.xml"}, rep
    d2 = docx.Document(o2)
    assert d2.paragraphs[2].text == "Prepared for Beta plc on 26 Oct 2026.", d2.paragraphs[2].text
    assert d2.tables[0].rows[1].cells[0].text == "Widget Beta plc"
    assert d2.sections[0].header.paragraphs[0].text == "Report for Beta plc"
    assert d2.sections[0].footer.paragraphs[0].text == "Confidential - {{footer_note}}"
    hb = [(r.text, r.bold) for r in d2.sections[0].header.paragraphs[0].runs]
    assert hb == [("Report for ", True), ("Beta plc", True)], hb
    untouched(src, o2, {"word/document.xml", "word/header1.xml"})
    refuses(lambda: de.fill_placeholders(src, o3, {"client": "x"}, strict=True), "strict mode")
    refuses(lambda: de.fill_placeholders(src, o3, {"nothing": "x"}), "found ['client', 'date', 'footer_note', 'other']")
    assert not os.path.exists(o3), "a refused edit must not write the output"

    # tables: set a cell, add a row (formatting copied from the previous row)
    r = dt.set_table_cell(src, o3, "t1", 1, 1, "12.5")
    cell = docx.Document(o3).tables[0].rows[1].cells[1]
    assert cell.text == "12.5" and cell.paragraphs[0].runs[0].font.size == Pt(9)
    dt.add_table_row(o3, o3, "t1", ["Gadget", "7"])
    t = docx.Document(o3).tables[0]
    assert len(t.rows) == 4 and [c.text for c in t.rows[3].cells] == ["Gadget", "7"]
    run = t.rows[3].cells[0].paragraphs[0].runs[0]
    assert run.font.size == Pt(9) and run.font.color.rgb == RGBColor(0, 0x66, 0), "run formatting not copied"
    assert 'w:fill="F2F2F2"' in parts(o3)["word/document.xml"].decode() and \
        t.rows[3].cells[0]._tc.xml.count("F2F2F2") == 1, "cell shading not copied"
    refuses(lambda: dt.set_table_cell(src, o1, "t1", 9, 0, "x"), "has 3 rows")
    refuses(lambda: dt.add_table_row(src, o1, "t1", ["a", "b", "c"]), "2 cells")
    refuses(lambda: dt.set_table_cell(src, o1, "p1", 0, 0, "x"), "paragraph")
    dv.verify(src, o3)

    # insert after: named style, and the copy-the-anchor default
    de.insert_paragraph_after(src, o1, "p1", "Background", "Heading 2")
    ps = docx.Document(o1).paragraphs
    assert ps[1].text == "Background" and ps[1].style.name == "Heading 2" and ps[2].text.startswith("Dear")
    de.insert_paragraph_after(src, o1, "p4", "Second point")
    ps = docx.Document(o1).paragraphs
    assert ps[4].text == "Second point" and ps[4].style.name == "List Bullet"
    de.insert_paragraph_after(src, o1, "t1", "After the table, new")
    assert [p.text for p in docx.Document(o1).paragraphs][-2:] == ["After the table, new", "After the table."]
    refuses(lambda: de.insert_paragraph_after(src, o1, "p2", "x", "No Such Style"), "available:")
    refuses(lambda: de.insert_paragraph_after(src, o1, "p99", "x"), "no block 'p99'")
    de.set_paragraph_text(src, o1, "p2", "Hello team")
    first = docx.Document(o1).paragraphs[1]
    assert first.text == "Hello team" and first.runs[0].bold, "formatting of the first run is kept"
    dv.verify(src, o1)

    # tracked changes: w:del + w:ins with author and date, reopen, accepted-view diff
    rep = de.replace_text(src, o1, "Acme Ltd", "Beta plc", track_changes=True, author="Cerea Bot")
    assert rep["tracked"] is True
    xml = parts(o1)["word/document.xml"].decode()
    dels = re.findall(r"<w:del [^>]*w:author=\"Cerea Bot\"[^>]*>.*?</w:del>", xml)
    assert "".join(re.findall(r"<w:delText[^>]*>([^<]*)</w:delText>", "".join(dels))) == "Acme Ltd", dels
    assert re.search(r'<w:ins [^>]*w:date="\d{4}-\d\d-\d\dT[^"]*Z"[^>]*>.*?<w:t[^>]*>Beta plc</w:t>', xml)
    ids_ = re.findall(r'<w:(?:ins|del) w:id="(\d+)"', xml)
    assert len(ids_) == len(set(ids_)) and len(ids_) >= 4, ids_
    v = dv.verify(src, o1)
    assert v["tracked"]["ins"] == 1 and v["tracked"]["del"] == 3, v["tracked"]
    assert "+ Dear Beta plc, welcome" in v["text_diff"]
    dt.add_table_row(src, o3, "t1", ["Tracked", "1"], track_changes=True)
    assert "<w:trPr>" in parts(o3)["word/document.xml"].decode() and dv.verify(src, o3)["tracked"]["ins"] >= 3
    de.insert_paragraph_after(src, o3, "p2", "Tracked paragraph", track_changes=True)
    dv.verify(src, o3)

    # chained edits, one verify against the original; exact content parts changed
    de.fill_placeholders(src, o1, {"client": "Beta plc", "footer_note": "Draft"})
    de.replace_text(o1, o1, "Acme Ltd", "Beta plc", scope="body")
    v = dv.verify(src, o1)
    assert set(v["changed"]) == CONTENT and v["byte_identical"] == v["parts"] - 3, v
    assert any(l == "+ Confidential - Draft" for l in v["text_diff"]), v["text_diff"]
    refuses(lambda: de.replace_text(src, o2, "no such text", "x"), "no match for")
    refuses(lambda: de.replace_text(src, o2, "Acme", "x", scope="p99"), "no block")

    # verify catches an out-of-bounds change and a python-docx round trip
    bad = "%s/de-bad.docx" % tmp
    with zipfile.ZipFile(src) as zi, zipfile.ZipFile(bad, "w") as zo:
        for i in zi.infolist():
            data = zi.read(i.filename)
            if i.filename == "word/styles.xml":
                data = data.replace(b"<w:styles", b"<!-- x --><w:styles", 1) if b"<w:styles" in data else data + b" "
            zo.writestr(i.filename, data)
    refuses(lambda: dv.verify(src, bad), "word/styles.xml")
    return "outline, run-spanning replace, placeholders (body/table/header/footer), table cell/row, insert, tracked changes, %d parts: %d byte-identical in the simple edit, verify refusals" % (
        total, total - 1)


if __name__ == "__main__":
    import sys
    import tempfile

    sys.path.insert(0, sys.argv[1])
    import docx_edit, docx_tables, docx_verify  # noqa: E401
    print(run_checks((docx_edit, docx_tables, docx_verify), tempfile.mkdtemp()))
