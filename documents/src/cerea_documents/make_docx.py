"""Create a .docx from a spec with python-docx (plus a native chart part python-docx cannot write itself).

The built-in set is applied as style definitions (Normal, headings, captions), so the file edits like any
Word file. With a template, its styles are used as they are and only what `theme` names is applied on top;
a style the template lacks falls back to direct formatting and is reported in `notes`."""

from __future__ import annotations

import io
import re
from typing import Any

import docx
from docx.document import Document as DocumentT
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.opc.constants import CONTENT_TYPE as CT
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.opc.packuri import PackURI
from docx.opc.part import Part
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Cm, Emu, Pt, RGBColor
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from lxml import etree

from . import charts
from .determinism import FIXED, fix_zip
from .errors import InvalidRequest
from .images_ref import ImageSet
from .theme import Theme
from .verify import _as_plain_docx

PAGE_CM = {
    "A4": (21.0, 29.7),
    "A3": (29.7, 42.0),
    "A5": (14.8, 21.0),
    "Letter": (21.59, 27.94),
    "Legal": (21.59, 35.56),
}
ALIGNS = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
}
EMU_CM = 360_000
RT_PACKAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package"
CT_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
FIELD = re.compile(r"\{(pages?)\}")


def _rgb(hex6: str) -> RGBColor:
    return RGBColor.from_string(hex6)


PPR = [
    "pStyle",
    "keepNext",
    "keepLines",
    "pageBreakBefore",
    "framePr",
    "widowControl",
    "numPr",
    "suppressLineNumbers",
    "pBdr",
    "shd",
    "tabs",
    "suppressAutoHyphens",
    "kinsoku",
    "wordWrap",
    "overflowPunct",
    "topLinePunct",
    "autoSpaceDE",
    "autoSpaceDN",
    "bidi",
    "adjustRightInd",
    "snapToGrid",
    "spacing",
    "ind",
    "contextualSpacing",
    "mirrorIndents",
    "suppressOverlap",
    "jc",
    "textDirection",
    "textAlignment",
    "textboxTightWrap",
    "outlineLvl",
    "divId",
    "cnfStyle",
    "rPr",
    "sectPr",
    "pPrChange",
]
TBLPR = [
    "tblStyle",
    "tblpPr",
    "tblOverlap",
    "bidiVisual",
    "tblStyleRowBandSize",
    "tblStyleColBandSize",
    "tblW",
    "jc",
    "tblCellSpacing",
    "tblInd",
    "tblBorders",
    "shd",
    "tblLayout",
    "tblCellMar",
    "tblLook",
    "tblCaption",
    "tblDescription",
    "tblPrChange",
]
TCPR = [
    "cnfStyle",
    "tcW",
    "gridSpan",
    "hMerge",
    "vMerge",
    "tcBorders",
    "shd",
    "noWrap",
    "tcMar",
    "textDirection",
    "tcFitText",
    "vAlign",
    "hideMark",
]


def put_in_order(parent: Any, child: Any, order: list[str]) -> None:
    """Insert `child` where the schema's sequence wants it (Word refuses some files with children out of order)."""
    tag = child.tag.rsplit("}", 1)[1]
    parent.insert_element_before(child, *[f"w:{t}" for t in order[order.index(tag) + 1 :]])


def set_font(font_owner: Any, name: str) -> None:
    """Set the font of a style (all scripts) and drop the theme-font links that would override it."""
    font_owner.font.name = name
    rfonts = font_owner.element.get_or_add_rPr().get_or_add_rFonts()
    for attr in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
        rfonts.attrib.pop(qn(f"w:{attr}"), None)
    rfonts.set(qn("w:eastAsia"), name)
    rfonts.set(qn("w:cs"), name)


class DocxBuilder:
    def __init__(self, spec: dict[str, Any], images: ImageSet, theme: Theme, template: bytes | None) -> None:
        self.spec, self.images, self.t = spec, images, theme
        self.notes: list[str] = list(spec.get("_notes") or [])
        self.charts: list[dict[str, Any]] = []
        self.chart_n = 0
        self.nums: dict[str, int] = {}
        self.has_template = template is not None
        self.doc: DocumentT = docx.Document(io.BytesIO(_as_plain_docx(template))) if template else docx.Document()
        if template:
            body = self.doc.element.body
            for child in list(body):
                if child.tag != qn("w:sectPr"):
                    body.remove(child)
        self.sec = self.doc.sections[0]
        self.text_width = self.sec.page_width - self.sec.left_margin - self.sec.right_margin  # type: ignore[operator]

    # ---- document level ------------------------------------------------------------------------

    def style(self, name: str) -> Any | None:
        try:
            return self.doc.styles[name]
        except KeyError:
            return None

    def build(self) -> bytes:
        self.page_setup()
        self.apply_theme()
        self.header_footer()
        blocks = self.spec["blocks"]
        self.headings = [(b["level"], _plain(b)) for b in blocks if b["type"] == "heading"]
        for b in blocks:
            getattr(self, "b_" + b["type"])(b)
        self.properties()
        out = io.BytesIO()
        self.doc.save(out)
        return fix_zip(out.getvalue())

    def page_setup(self) -> None:
        page = self.spec.get("page") or {}
        if self.has_template and not page:
            return
        size = page.get("size", "A4")
        orient = page.get("orientation", "portrait")
        w, h = PAGE_CM[size]
        if orient == "landscape":
            w, h = h, w
        s = self.sec
        s.page_width, s.page_height = Cm(w), Cm(h)
        s.orientation = 1 if orient == "landscape" else 0  # type: ignore[assignment]
        m = page.get("margins_cm", 2.5)
        sides = (
            {k: m for k in ("top", "bottom", "left", "right")}
            if not isinstance(m, dict)
            else {"top": 2.5, "bottom": 2.5, "left": 2.5, "right": 2.5} | m
        )
        s.top_margin, s.bottom_margin = Cm(sides["top"]), Cm(sides["bottom"])
        s.left_margin, s.right_margin = Cm(sides["left"]), Cm(sides["right"])
        s.header_distance = s.footer_distance = Cm(min(1.25, sides["top"] / 2))
        self.text_width = s.page_width - s.left_margin - s.right_margin  # type: ignore[operator]
        if self.text_width <= Cm(2):
            raise InvalidRequest("spec.page: the margins leave no room for text; reduce margins_cm", reason="schema")

    def apply_theme(self) -> None:
        t, st = self.t, self.doc.styles
        normal = self.style("Normal")
        if normal is not None:
            if t.uses("body_font"):
                set_font(normal, t.body_font)
            if t.uses("body_size"):
                normal.font.size = Pt(t.body_size)
            if t.uses("color_text"):
                normal.font.color.rgb = _rgb(t.colors["text"])
            if t.uses("line_spacing"):
                normal.paragraph_format.line_spacing = t.line_spacing
            if t.uses("space_after"):
                normal.paragraph_format.space_after = Pt(t.space_after)
        for level in range(1, 7):
            h = self.style(f"Heading {level}")
            if h is None:
                continue
            if t.uses("heading_font"):
                set_font(h, t.heading_font)
            if t.uses(f"heading_size_h{level}"):
                h.font.size = Pt(t.heading_sizes[level])
            if t.uses("color_heading"):
                h.font.color.rgb = _rgb(t.colors["heading"])
            if not self.has_template:
                h.font.bold = level <= 3
                h.paragraph_format.space_before = Pt(18 if level == 1 else 12)
                h.paragraph_format.space_after = Pt(6)
                h.paragraph_format.keep_with_next = True
        cap = self.style("Caption")
        if cap is not None and not self.has_template:
            cap.font.size, cap.font.italic, cap.font.bold = Pt(max(t.body_size - 2, 8)), True, False
            cap.font.color.rgb = _rgb(t.colors["muted"])
        if self.style("Code") is None:
            code = st.add_style("Code", WD_STYLE_TYPE.PARAGRAPH)
            code.base_style = normal
            set_font(code, "Consolas")
            code.font.size = Pt(max(t.body_size - 1.5, 8))
            code.paragraph_format.space_after = Pt(t.space_after)
            code.paragraph_format.left_indent = Cm(0.3)
            code.paragraph_format.line_spacing = 1.0
            ppr = code.element.get_or_add_pPr()
            shd = OxmlElement("w:shd")
            for k, v in (("val", "clear"), ("color", "auto"), ("fill", t.colors["table_band"])):
                shd.set(qn(f"w:{k}"), v)
            put_in_order(ppr, shd, PPR)
        lang = self.spec.get("language")
        if lang:
            defaults = st.element.find(qn("w:docDefaults"))
            rpr = defaults.find(f"{qn('w:rPrDefault')}/{qn('w:rPr')}") if defaults is not None else None
            if rpr is not None:
                el = rpr.find(qn("w:lang"))
                if el is None:
                    el = OxmlElement("w:lang")
                    rpr.append(el)
                el.set(qn("w:val"), lang)

    def properties(self) -> None:
        cp = self.doc.core_properties
        cp.author = cp.last_modified_by = "Cerea"
        cp.title = str(self.spec.get("title") or "")
        cp.created = cp.modified = FIXED
        cp.revision = 1
        cp.comments = cp.keywords = cp.subject = cp.category = ""
        if self.spec.get("language"):
            cp.language = self.spec["language"]

    def header_footer(self) -> None:
        for key, part in (("header", self.sec.header), ("footer", self.sec.footer)):
            cfg = self.spec.get(key)
            if not cfg:
                continue
            part.is_linked_to_previous = False
            p = part.paragraphs[0] if part.paragraphs else part.add_paragraph()
            for r in list(p.runs):
                r._r.getparent().remove(r._r)
            p.alignment = ALIGNS[cfg.get("align", "center" if key == "footer" else "right")]
            for chunk in FIELD.split(cfg["text"]):
                if chunk in ("page", "pages"):
                    self._field(p, "PAGE" if chunk == "page" else "NUMPAGES", small=True)
                elif chunk:
                    self._small(p.add_run(chunk))

    def _small(self, run: Run) -> None:
        run.font.size = Pt(max(self.t.body_size - 2, 8))
        run.font.color.rgb = _rgb(self.t.colors["muted"])

    def _field(self, p: Paragraph, instr: str, small: bool = False) -> None:
        fld = OxmlElement("w:fldSimple")
        fld.set(qn("w:instr"), instr)
        r = OxmlElement("w:r")
        t = OxmlElement("w:t")
        t.text = "1"
        r.append(t)
        fld.append(r)
        p._p.append(fld)
        if small:
            self._small(Run(r, p))

    # ---- runs -----------------------------------------------------------------------------------

    def runs(self, p: Paragraph, block: dict[str, Any], size: float | None = None, bold: bool = False) -> None:
        for r in block.get("runs") or [{"text": block.get("text", "")}]:
            run = self._hyperlink(p, r) if r.get("link") else p.add_run(r["text"])
            if r.get("bold") or bold:
                run.bold = True
            if r.get("italic"):
                run.italic = True
            if r.get("underline"):
                run.underline = True
            if r.get("code"):
                set_font(run, "Consolas")
                run.font.size = Pt(max((size or self.t.body_size) - 1, 8))
            elif size:
                run.font.size = Pt(size)
            if r.get("color"):
                run.font.color.rgb = _rgb(r["color"].lstrip("#"))

    def _hyperlink(self, p: Paragraph, r: dict[str, Any]) -> Run:
        rid = self.doc.part.relate_to(r["link"], RT.HYPERLINK, is_external=True)
        h = OxmlElement("w:hyperlink")
        h.set(qn("r:id"), rid)
        h.set(qn("w:history"), "1")
        el = OxmlElement("w:r")
        h.append(el)
        p._p.append(h)
        run = Run(el, p)
        run.text = r["text"]
        run.font.color.rgb = _rgb(self.t.colors["link"])
        run.underline = True
        return run

    def para(self, style: str | None = None) -> Paragraph:
        p = self.doc.add_paragraph()
        if style and self.style(style) is not None:
            p.style = style
        elif style:
            self.notes.append(f"style {style!r} is not in the template; direct formatting was used")
        return p

    # ---- blocks ---------------------------------------------------------------------------------

    def b_heading(self, b: dict[str, Any]) -> None:
        name = f"Heading {b['level']}"
        p = self.para(name)
        if self.style(name) is None:  # a template without headings
            self.runs(p, b, size=self.t.heading_sizes[b["level"]], bold=True)
        else:
            self.runs(p, b)

    def b_paragraph(self, b: dict[str, Any]) -> None:
        p = self.doc.add_paragraph()
        if b.get("align"):
            p.alignment = ALIGNS[b["align"]]
        self.runs(p, b)

    def b_page_break(self, _b: dict[str, Any]) -> None:
        self.doc.add_page_break()

    def b_quote(self, b: dict[str, Any]) -> None:
        p = self.doc.add_paragraph()
        styled = self.style("Quote") is not None
        if styled:
            p.style = "Quote"
        else:
            p.paragraph_format.left_indent = Cm(1)
        self._border(p, "left", self.t.colors["accent"], 18)
        self.runs(p, b)
        if not styled:
            for run in p.runs:
                run.italic = True
                run.font.color.rgb = _rgb(self.t.colors["muted"])
        if b.get("attribution"):
            a = self.doc.add_paragraph()
            a.paragraph_format.left_indent = Cm(1)
            self._small(a.add_run("\u2014 " + b["attribution"]))

    def _border(self, p: Paragraph, edge: str, color: str, size: int) -> None:
        ppr = p._p.get_or_add_pPr()
        bdr = OxmlElement("w:pBdr")
        el = OxmlElement(f"w:{edge}")
        for k, v in (("val", "single"), ("sz", str(size)), ("space", "8"), ("color", color)):
            el.set(qn(f"w:{k}"), v)
        bdr.append(el)
        put_in_order(ppr, bdr, PPR)

    def b_code(self, b: dict[str, Any]) -> None:
        p = self.doc.add_paragraph(style="Code")
        p.add_run(b["text"])

    def b_toc(self, b: dict[str, Any]) -> None:
        levels = b.get("levels", 3)
        entries = [t for lvl, t in self.headings if lvl <= levels and t]
        title = b.get("title", "Contents")
        if title:
            p = self.para("TOC Heading" if self.style("TOC Heading") else None)
            run = p.add_run(title)
            if not self.style("TOC Heading"):
                run.bold = True
                run.font.size = Pt(self.t.heading_sizes[2])
        items = entries or ["(update this field to build the table of contents)"]
        for i, text in enumerate(items):
            p = self.doc.add_paragraph()
            if self.style("TOC 1") is not None:
                p.style = "TOC 1"
            if i == 0:
                self._fld_char(p, "begin")
                instr = OxmlElement("w:r")
                it = OxmlElement("w:instrText")
                it.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                it.text = f' TOC \\o "1-{levels}" \\h \\z \\u '
                instr.append(it)
                p._p.append(instr)
                self._fld_char(p, "separate")
            p.add_run(text)
            if i == len(items) - 1:
                self._fld_char(p, "end")

    def _fld_char(self, p: Paragraph, kind: str) -> None:
        r = OxmlElement("w:r")
        fc = OxmlElement("w:fldChar")
        fc.set(qn("w:fldCharType"), kind)
        r.append(fc)
        p._p.append(r)

    # lists: one numbering instance per list, so numbered lists restart at 1
    def _numbering(self) -> Any:
        try:
            return self.doc.part.numbering_part.element
        except NotImplementedError:
            from docx.parts.numbering import NumberingPart

            root = parse_xml(f"<w:numbering {nsdecls('w')}/>".encode())
            part = NumberingPart(PackURI("/word/numbering.xml"), CT.WML_NUMBERING, root, self.doc.part.package)
            self.doc.part.relate_to(part, RT.NUMBERING)
            return root

    def _abstract(self, kind: str) -> int:
        if kind in self.nums:
            return self.nums[kind]
        root = self._numbering()
        existing = [int(a.get(qn("w:abstractNumId")) or 0) for a in root.findall(qn("w:abstractNum"))]
        aid = max([*existing, 900]) + 1
        ordered = kind == "ordered"
        fmts = ("decimal", "lowerLetter", "lowerRoman") if ordered else ("bullet",) * 3
        bullets = ("\u2022", "\u2013", "\u25aa")
        lvls = "".join(
            f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{fmts[i % 3]}"/>'
            f'<w:lvlText w:val="{f"%{i + 1}." if ordered else bullets[i % 3]}"/>'
            f'<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{720 + 360 * i}" w:hanging="360"/></w:pPr></w:lvl>'
            for i in range(9)
        )
        el = parse_xml(
            f'<w:abstractNum {nsdecls("w")} w:abstractNumId="{aid}"><w:multiLevelType w:val="hybridMultilevel"/>{lvls}</w:abstractNum>'.encode()
        )
        first_num = root.find(qn("w:num"))
        if first_num is not None:
            first_num.addprevious(el)
        else:
            root.append(el)
        self.nums[kind] = aid
        return aid

    def _new_num(self, kind: str) -> int:
        aid = self._abstract(kind)
        root = self._numbering()
        nid = max([int(n.get(qn("w:numId")) or 0) for n in root.findall(qn("w:num"))] + [0]) + 1
        overrides = "".join(
            f'<w:lvlOverride w:ilvl="{i}"><w:startOverride w:val="1"/></w:lvlOverride>' for i in range(9)
        )
        root.append(
            parse_xml(
                f'<w:num {nsdecls("w")} w:numId="{nid}"><w:abstractNumId w:val="{aid}"/>{overrides}</w:num>'.encode()
            )
        )
        return nid

    def b_list(self, b: dict[str, Any]) -> None:
        nid = self._new_num("ordered" if b.get("ordered") else "bullet")
        self._items(b["items"], nid, 0)

    def _items(self, items: list[Any], nid: int, level: int) -> None:
        for it in items:
            block = {"text": it} if isinstance(it, str) else it
            p = self.doc.add_paragraph()
            if self.style("List Paragraph") is not None:
                p.style = "List Paragraph"
            ppr = p._p.get_or_add_pPr()
            num = ppr.get_or_add_numPr()
            num.get_or_add_ilvl().val = level
            num.get_or_add_numId().val = nid
            p.paragraph_format.space_after = Pt(2)
            self.runs(p, block)
            if not isinstance(it, str) and it.get("children"):
                self._items(it["children"], nid, level + 1)

    # tables
    def b_table(self, b: dict[str, Any]) -> None:
        t = self.t
        style = b.get("style") or t.table_style
        header, rows = b.get("header"), b["rows"]
        cols = max([len(header or []), *(len(r) for r in rows)])
        table = self.doc.add_table(rows=(1 if header else 0) + len(rows), cols=cols)
        table.autofit = False
        widths = b.get("widths") or [1] * cols
        total = sum(widths)
        emus = [int(self.text_width * w / total) for w in widths]
        grid = table._tbl.tblGrid
        for gc, w_ in zip(grid.findall(qn("w:gridCol")), emus, strict=True):
            gc.set(qn("w:w"), str(int(Emu(w_).twips)))
        self._table_props(table, style)
        aligns = b.get("align") or ["left"] * cols
        data = ([header] if header else []) + rows
        for ri, row in enumerate(data):
            is_head = bool(header) and ri == 0
            if is_head:
                trpr = table.rows[ri]._tr.get_or_add_trPr()
                trpr.append(OxmlElement("w:tblHeader"))
            for ci in range(cols):
                cell = table.rows[ri].cells[ci]
                cell.width = Emu(emus[ci])
                raw = row[ci] if ci < len(row) else ""
                spec = raw if isinstance(raw, dict) else {"text": raw}
                text = "" if spec["text"] is None else str(spec["text"])
                if isinstance(spec["text"], bool):
                    text = "true" if spec["text"] else "false"
                p = cell.paragraphs[0]
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.space_before = Pt(0)
                p.alignment = ALIGNS[spec.get("align") or aligns[ci]]
                run = p.add_run(text)
                fill = spec.get("fill")
                if is_head and style in ("banded", "grid"):
                    fill = fill or t.colors["table_header_fill"]
                    run.font.color.rgb = _rgb(spec.get("color") or t.colors["table_header_text"])
                    run.bold = True
                elif is_head:
                    run.bold = True
                elif style == "banded" and (ri - (1 if header else 0)) % 2 == 1 and not fill:
                    fill = t.colors["table_band"]
                if spec.get("bold"):
                    run.bold = True
                if spec.get("color") and not (is_head and style in ("banded", "grid")):
                    run.font.color.rgb = _rgb(spec["color"].lstrip("#"))
                if fill:
                    self._shade(cell, fill.lstrip("#"))
        if b.get("caption"):
            self._caption(b["caption"], "center")
        else:
            self.doc.add_paragraph().paragraph_format.space_after = Pt(2)

    def _table_props(self, table: Table, style: str) -> None:
        tpr = table._tbl.tblPr
        color = self.t.colors["border"]
        edges = {
            "grid": ("top", "left", "bottom", "right", "insideH", "insideV"),
            "banded": ("top", "bottom", "insideH"),
            "minimal": ("top", "bottom"),
            "plain": (),
        }[style]
        if edges:
            bdr = OxmlElement("w:tblBorders")
            for e in ("top", "left", "bottom", "right", "insideH", "insideV"):
                el = OxmlElement(f"w:{e}")
                on = e in edges
                el.set(qn("w:val"), "single" if on else "nil")
                if on:
                    el.set(qn("w:sz"), "4")
                    el.set(qn("w:space"), "0")
                    el.set(qn("w:color"), color)
                bdr.append(el)
            put_in_order(tpr, bdr, TBLPR)
        mar = parse_xml(
            f'<w:tblCellMar {nsdecls("w")}><w:top w:w="40" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>'
            '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>'.encode()
        )
        put_in_order(tpr, mar, TBLPR)

    def _shade(self, cell: Any, fill: str) -> None:
        tcpr = cell._tc.get_or_add_tcPr()
        shd = OxmlElement("w:shd")
        for k, v in (("val", "clear"), ("color", "auto"), ("fill", fill)):
            shd.set(qn(f"w:{k}"), v)
        put_in_order(tcpr, shd, TCPR)

    def _caption(self, text: str, align: str) -> None:
        p = self.doc.add_paragraph()
        run = p.add_run(text)
        if self.style("Caption") is not None:
            p.style = "Caption"
        else:
            run.italic = True
            self._small(run)
        p.alignment = ALIGNS[align]

    # images and charts
    def _size(
        self, aspect: float, width_cm: float | None, height_cm: float | None, natural_w_cm: float
    ) -> tuple[int, int]:
        w = width_cm * EMU_CM if width_cm else None
        h = height_cm * EMU_CM if height_cm else None
        if w is None and h is None:
            w = min(natural_w_cm * EMU_CM, int(self.text_width))
        if w is None:
            w = (h or 1) * aspect
        if h is None:
            h = w / aspect
        if w > self.text_width:  # never wider than the text
            h, w = h * self.text_width / w, int(self.text_width)
        return int(w), max(1, int(h))

    def _picture(self, data: bytes, w: int, h: int, alt: str, align: str, caption: str | None) -> None:
        p = self.doc.add_paragraph()
        p.alignment = ALIGNS[align]
        p.paragraph_format.keep_with_next = bool(caption)
        shape = p.add_run().add_picture(io.BytesIO(data), width=Emu(w), height=Emu(h))
        shape._inline.docPr.set("descr", alt)
        if caption:
            self._caption(caption, align)

    def b_image(self, b: dict[str, Any]) -> None:
        img = self.images.get(b["image"])
        w, h = self._size(
            img.info.width / img.info.height, b.get("width_cm"), b.get("height_cm"), img.info.width / 96 * 2.54
        )
        self._picture(
            img.data, w, h, b.get("alt") or b.get("caption") or b["image"], b.get("align", "center"), b.get("caption")
        )

    def b_chart(self, b: dict[str, Any]) -> None:
        w, h = self._size(
            charts.DEFAULT_CM[0] / charts.DEFAULT_CM[1], b.get("width_cm"), b.get("height_cm"), charts.DEFAULT_CM[0]
        )
        alt = b.get("title") or f"{b['chart_type']} chart"
        align = b.get("align", "center")
        if b.get("render", "native") == "native":
            try:
                self._native_chart(b, w, h, alt, align)
                self.charts.append(charts.describe(b, "native"))
                if b.get("caption"):
                    self._caption(b["caption"], align)
                return
            except Exception as exc:  # the chart is still delivered, as an image, and the result says so
                note = f"native chart could not be written ({type(exc).__name__}); embedded as an image instead"
                self.notes.append(note)
                self.charts.append(charts.describe(b, "image", note))
        else:
            self.charts.append(charts.describe(b, "image"))
        png = charts.render_png(b, self.t, w / EMU_CM, h / EMU_CM)
        self._picture(png, w, h, alt, align, b.get("caption"))

    def _native_chart(self, c: dict[str, Any], cx: int, cy: int, alt: str, align: str) -> None:
        xml, xlsx = charts.native_part_for_word(c, self.t)
        self.chart_n += 1
        n, pkg = self.chart_n, self.doc.part.package
        chart_part = Part(PackURI(f"/word/charts/chart{n}.xml"), CT.DML_CHART, package=pkg, blob=b"")
        book = Part(PackURI(f"/word/embeddings/Microsoft_Excel_Sheet{n}.xlsx"), CT_XLSX, package=pkg, blob=xlsx)
        rid_book = chart_part.relate_to(book, RT_PACKAGE)
        root = etree.fromstring(xml)
        ext = root.find("{http://schemas.openxmlformats.org/drawingml/2006/chart}externalData")
        if ext is None:
            raise ValueError("the chart has no workbook link")
        ext.set("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id", rid_book)
        chart_part._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
        rid = self.doc.part.relate_to(chart_part, RT.CHART)
        p = self.doc.add_paragraph()
        p.alignment = ALIGNS[align]
        p.paragraph_format.keep_with_next = False
        pid = self.doc.part.next_id
        drawing = parse_xml(
            (
                f'<w:drawing {nsdecls("w")} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
                'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
                'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                f'<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/>'
                f'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{pid}" name="Chart {n}" descr="{_attr(alt)}"/>'
                "<wp:cNvGraphicFramePr/><a:graphic><a:graphicData "
                f'uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="{rid}"/>'
                "</a:graphicData></a:graphic></wp:inline></w:drawing>"
            ).encode()
        )
        run = OxmlElement("w:r")
        run.append(drawing)
        p._p.append(run)


def _attr(text: str) -> str:
    return text.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def _plain(b: dict[str, Any]) -> str:
    return "".join(r["text"] for r in b["runs"]) if "runs" in b else str(b.get("text", ""))


def build_docx(
    spec: dict[str, Any], images: ImageSet, theme: Theme, template: bytes | None
) -> tuple[bytes, dict[str, Any]]:
    b = DocxBuilder(spec, images, theme, template)
    data = b.build()
    return data, {"charts": b.charts, "notes": b.notes}
