"""Checks for the powerpoint skill's bundled pptx_edit / pptx_slides / pptx_verify.
Runs unchanged in CPython and in the vendored Pyodide (driven by
pyodide_skills_check.mjs).

The fixture is generated, not committed: a python-pptx deck with a layout
placeholder (formatted runs), a text box whose formatting changes mid-word, a
picture used on two slides, a table, and speaker notes. Licence: Apache-2.0.
"""

import io
import os
import struct
import zipfile
import zlib

import pptx
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt


def png(w, h, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d))

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def make_fixture(path, tmp):
    prs = pptx.Presentation()
    s1 = prs.slides.add_slide(prs.slide_layouts[0])
    s1.shapes.title.text_frame.text = "Annual review 2025"
    run = s1.shapes.title.text_frame.paragraphs[0].runs[0]
    run.font.bold = True
    run.font.color.rgb = RGBColor(0x12, 0x34, 0x56)
    s1.placeholders[1].text_frame.text = "Prepared by the team"
    s2 = prs.slides.add_slide(prs.slide_layouts[1])
    s2.shapes.title.text = "Results"
    body = s2.placeholders[1].text_frame
    body.text = "Revenue grew"
    body.add_paragraph().text = "Costs fell"
    box = s2.shapes.add_textbox(Inches(1), Inches(5), Inches(4), Inches(1))
    p = box.text_frame.paragraphs[0]
    r1 = p.add_run()
    r1.text = "Rev"
    r1.font.bold = True
    r1.font.size = Pt(20)
    r2 = p.add_run()
    r2.text = "enue 2025 up"
    r2.font.italic = True
    r2.font.size = Pt(20)
    r2.font.color.rgb = RGBColor(0xC0, 0, 0)
    pic_path = "%s/logo.png" % tmp
    open(pic_path, "wb").write(png(40, 20, (200, 30, 30)))
    pic = s2.shapes.add_picture(pic_path, Inches(6), Inches(1), Inches(2), Inches(2))
    s2.notes_slide.notes_text_frame.text = "Say the number slowly: 2025"
    s3 = prs.slides.add_slide(prs.slide_layouts[5])
    s3.shapes.title.text = "Detail"
    s3.shapes.add_picture(pic_path, Inches(1), Inches(1), Inches(1), Inches(1))  # same media as slide 2
    own = "%s/own.png" % tmp
    open(own, "wb").write(png(30, 30, (0, 120, 0)))
    s3.shapes.add_picture(own, Inches(3), Inches(1), Inches(1), Inches(1))  # media only slide 3 uses
    tbl = s3.shapes.add_table(2, 2, Inches(1), Inches(3), Inches(4), Inches(1)).table
    tbl.cell(0, 0).text = "Region"
    tbl.cell(0, 1).text = "Total 2025"
    prs.save(path)
    return pic.shape_id


def parts(path):
    with zipfile.ZipFile(path) as z:
        return {i.filename: z.read(i.filename) for i in z.infolist()}


def refuses(fn, needle):
    try:
        fn()
    except Exception as e:
        assert type(e).__name__ == "PatchError", repr(e)
        assert needle in str(e), "%r not in %r" % (needle, str(e))
        return
    raise AssertionError("expected a refusal containing %r" % needle)


def unchanged_except(src, dst, allowed):
    a, b = parts(src), parts(dst)
    bad = [n for n in a if n in b and n not in allowed and a[n] != b[n]]
    assert not bad, "untouched parts changed: %s" % bad
    assert all(n in b for n in a if n not in allowed), "an untouched part was lost"


def run_checks(mods, tmp="/tmp"):
    pe, ps, pv = mods
    src, o1, o2 = ("%s/pe-%s.pptx" % (tmp, n) for n in ("src", "o1", "o2"))
    pic_id = make_fixture(src, tmp)
    before = parts(src)

    # outline
    o = pe.outline(src)
    assert [s["layout"] for s in o["slides"]] == ["Title Slide", "Title and Content", "Title Only"], o["slides"]
    s2 = o["slides"][1]
    kinds = {s["name"]: s for s in s2["shapes"]}
    pic = next(s for s in s2["shapes"] if s["kind"] == "picture")
    assert pic["id"] == pic_id and pic["image"].startswith("ppt/media/") and pic["box"][2:] == [1828800, 1828800], pic
    assert any(s.get("placeholder", {}).get("idx") == 1 and s["text"] == ["Revenue grew", "Costs fell"] for s in s2["shapes"])
    assert "2025" in s2["notes"] and "Total 2025" in str(o["slides"][2]["shapes"])
    assert "slide 2 [Title and Content]" in pv.outline_text(o)

    # replace across runs: first matched run's formatting, the tail keeps its own
    rep = pe.replace_text(src, o1, "enue 2025 up", "enue 2026 down")
    assert rep["replaced"] == 1 and rep["changed_parts"] == ["ppt/slides/slide2.xml"], rep
    sl = pptx.Presentation(o1).slides[1]
    tb = next(s for s in sl.shapes if s.name.startswith("TextBox"))
    runs = tb.text_frame.paragraphs[0].runs
    assert tb.text_frame.text == "Revenue 2026 down", tb.text_frame.text
    assert [(r.text, bool(r.font.bold)) for r in runs] == [("Rev", True), ("enue 2026 down", False)], [(r.text, r.font.bold) for r in runs]
    assert runs[1].font.italic and runs[1].font.size == Pt(20)
    v = pv.verify(src, o1)
    assert v["changed"] == ["ppt/slides/slide2.xml"] and not v["added"] and not v["removed"], v
    assert v["text_diff"] == ["- slide2.xml #%d %s: Revenue 2025 up" % (tb.shape_id, tb.name),
                              "+ slide2.xml #%d %s: Revenue 2026 down" % (tb.shape_id, tb.name)], v["text_diff"]
    unchanged_except(src, o1, {"ppt/slides/slide2.xml"})
    assert all(parts(o1)[n] == before[n] for n in before if "slideLayout" in n or "slideMaster" in n or "theme" in n)
    # a match inside the title spanning nothing special; notes only with notes=True
    pe.replace_text(src, o2, "2025", "2026", slides=[1, 3])
    assert pptx.Presentation(o2).slides[0].shapes.title.text == "Annual review 2026"
    assert "2025" in pptx.Presentation(o2).slides[1].notes_slide.notes_text_frame.text
    pe.replace_text(src, o2, "2025", "2026", notes=True)
    assert pptx.Presentation(o2).slides[1].notes_slide.notes_text_frame.text == "Say the number slowly: 2026"
    refuses(lambda: pe.replace_text(src, o2, "no such text", "x"), "no match for")

    # placeholders keep run formatting
    pe.set_placeholder_text(src, o1, 1, "title", "Annual review 2026")
    t = pptx.Presentation(o1).slides[0].shapes.title.text_frame.paragraphs[0].runs[0]
    assert t.text == "Annual review 2026" and t.font.bold and t.font.color.rgb == RGBColor(0x12, 0x34, 0x56)
    pe.set_placeholder_text(src, o1, 2, 1, ["One", "Two", "Three"])
    assert pptx.Presentation(o1).slides[1].placeholders[1].text_frame.text == "One\nTwo\nThree"
    pv.verify(src, o1)
    refuses(lambda: pe.set_placeholder_text(src, o1, 1, "chart", "x"), "this slide has: ctrTitle (idx 0), subTitle (idx 1)")
    refuses(lambda: pe.set_placeholder_text(src, o1, 9, "title", "x"), "3 slides")

    # picture: new aspect ratio is cropped to the old frame; shared media stays, private media goes
    new_wide = png(80, 20, (0, 0, 200))
    rep = pe.replace_image(src, o1, 2, pic_id, new_wide)
    assert rep["cropped"] and rep["removed_media"] == [], rep  # slide 3 still uses the old file
    s2n = pptx.Presentation(o1).slides[1]
    pnew = next(s for s in s2n.shapes if s.shape_id == pic_id)
    assert (pnew.left, pnew.top, pnew.width, pnew.height) == (Inches(6), Inches(1), Inches(2), Inches(2))
    assert pnew.image.blob == new_wide and pnew.crop_left > 0.3 and pnew.crop_top == 0, (pnew.crop_left, pnew.crop_top)
    v = pv.verify(src, o1)
    assert len(v["added"]) == 1 and v["added"][0].startswith("ppt/media/image") and not v["removed"], v
    assert "ppt/slides/_rels/slide2.xml.rels" in v["changed"]
    private = next(s for s in o["slides"][2]["shapes"] if s["kind"] == "picture" and s["id"] != 0 and s["image"] != pic["image"])
    rep = pe.replace_image(src, o2, 3, private["id"], png(30, 30, (9, 9, 9)), fit="stretch")
    assert not rep["cropped"] and rep["removed_media"] == [private["image"]], rep
    v = pv.verify(src, o2)
    assert private["image"] in v["removed"] and len(v["added"]) == 1, v
    try:
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", (30, 60), (5, 5, 5)).save(buf, "JPEG")
        pe.replace_image(src, o2, 2, pic_id, buf.getvalue())
        assert any(n.endswith(".jpeg") for n in parts(o2)), "jpeg not added"
        pv.verify(src, o2)
        jp = next(x for x in pptx.Presentation(o2).slides[1].shapes if x.shape_id == pic_id)
        assert jp.image.content_type == "image/jpeg" and jp.width == Inches(2) and jp.crop_top > 0.2
    except ImportError:
        pass
    refuses(lambda: pe.replace_image(src, o2, 2, 9999, new_wide), "no picture with id 9999")
    refuses(lambda: pe.replace_image(src, o2, 2, pic_id, b"GIF"), "not a PNG")

    # slides: duplicate, delete, reorder
    ps.duplicate_slide(src, o1, 2)
    d = pptx.Presentation(o1)
    assert len(d.slides) == 4 and d.slides[2].shapes.title.text == "Results"
    assert d.slides[2].slide_layout.name == "Title and Content" and d.slides[1].shapes[3].image.blob == d.slides[2].shapes[3].image.blob
    v = pv.verify(src, o1)
    assert v["slides"] == (3, 4) and "ppt/slides/slide4.xml" in v["added"] and "ppt/media" not in str(v["added"]), v
    assert v["text_diff"][:2] == ["- order: slide1.xml, slide2.xml, slide3.xml", "+ order: slide1.xml, slide2.xml, slide4.xml, slide3.xml"], v["text_diff"]
    unchanged_except(src, o1, {"ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "[Content_Types].xml"} | set(v["added"]))
    ps.delete_slide(o1, o2, 3)
    assert [s.shapes.title.text for s in pptx.Presentation(o2).slides] == ["Annual review 2025", "Results", "Detail"]
    ps.delete_slide(src, o2, 2)
    d = pptx.Presentation(o2)
    assert len(d.slides) == 2
    v = pv.verify(src, o2)
    assert "ppt/slides/slide2.xml" in v["removed"] and any(n.startswith("ppt/notesSlides/") for n in v["removed"]), v
    assert not any("slideLayout" in n or "slideMaster" in n or "theme" in n for n in v["removed"] + v["changed"]), v
    ps.reorder(src, o2, [3, 1, 2])
    assert [s.shapes.title.text for s in pptx.Presentation(o2).slides] == ["Detail", "Annual review 2025", "Results"]
    v = pv.verify(src, o2)
    assert v["changed"] == ["ppt/presentation.xml"] and v["text_diff"][0].startswith("- order: slide1.xml, slide2.xml, slide3.xml"), v
    refuses(lambda: ps.reorder(src, o2, [1, 1, 2]), "exactly once")
    refuses(lambda: ps.delete_slide(src, o2, 7), "3 slides")

    # verify catches an out-of-bounds change
    bad = "%s/pe-bad.pptx" % tmp
    with zipfile.ZipFile(src) as zi, zipfile.ZipFile(bad, "w") as zo:
        for i in zi.infolist():
            data = zi.read(i.filename)
            if i.filename.startswith("ppt/slideLayouts/slideLayout1.xml"):
                data += b" "
            zo.writestr(i.filename, data)
    refuses(lambda: pv.verify(src, bad), "slideLayout1.xml")
    return "outline, run-spanning replace, placeholders, picture swap (crop, shared media), duplicate/delete/reorder, %d parts, layouts/masters byte-identical, verify refusals" % len(before)


if __name__ == "__main__":
    import sys
    import tempfile

    sys.path.insert(0, sys.argv[1])
    import pptx_edit, pptx_slides, pptx_verify  # noqa: E401

    print(run_checks((pptx_edit, pptx_slides, pptx_verify), tempfile.mkdtemp()))
