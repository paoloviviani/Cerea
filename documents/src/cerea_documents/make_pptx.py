"""Create a .pptx from a spec with python-pptx.

The built-in set is PowerPoint's default master and layouts, resized to 16:9 and restyled through the
master (fonts, colours, title style). With a template the uploaded file's master and layouts are used as
they are; `layout` then names one of its layouts. Native charts are python-pptx charts."""

from __future__ import annotations

import io
import math
import re
from typing import Any

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import PP_PLACEHOLDER
from pptx.enum.text import PP_ALIGN
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.util import Emu, Inches, Pt

from . import charts
from .determinism import FIXED, fix_zip
from .errors import InvalidRequest
from .images_ref import ImageSet
from .theme import Theme

EMU_CM = 360_000
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
BUILTIN = {"title": 0, "title_content": 1, "section": 2, "two_content": 3, "title_only": 5, "blank": 6}
TABLE_STYLE_IDS = {
    "banded": "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}",
    "grid": "{5940675A-B579-460E-94D1-54222C63F5DA}",
    "minimal": "{2D5ABB26-0587-4C30-8999-92F81FD0307C}",
    "plain": "{2D5ABB26-0587-4C30-8999-92F81FD0307C}",
}
TEXT_KINDS = ("paragraph", "list", "quote", "code")
Box = tuple[int, int, int, int]
_PPTX_MAIN = b"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"


def _as_plain_pptx(data: bytes) -> bytes:
    """python-pptx opens a plain .pptx only; present a template (.potx) or show (.ppsx) to it as one."""
    import zipfile

    with zipfile.ZipFile(io.BytesIO(data)) as z:
        ct = z.read("[Content_Types].xml")
    fixed = re.sub(
        rb"application/vnd\.openxmlformats-officedocument\.presentationml\.(?:template|slideshow)\.main\+xml",
        _PPTX_MAIN,
        ct,
    )
    if fixed == ct:
        return data
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as zi, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for i in zi.infolist():
            zo.writestr(i.filename, fixed if i.filename == "[Content_Types].xml" else zi.read(i.filename))
    return out.getvalue()


def _rgb(h: str) -> RGBColor:
    return RGBColor.from_string(h.lstrip("#").upper())


class PptxBuilder:
    def __init__(self, spec: dict[str, Any], images: ImageSet, theme: Theme, template: bytes | None) -> None:
        self.spec, self.images, self.t = spec, images, theme
        self.notes: list[str] = []
        self.charts: list[dict[str, Any]] = []
        self.has_template = template is not None
        if template:
            self.prs = Presentation(io.BytesIO(_as_plain_pptx(template)))
            lst = self.prs.slides._sldIdLst
            for sld in list(lst):  # the template's own slides are not content
                self.prs.part.drop_rel(sld.rId)
                lst.remove(sld)
        else:
            self.prs = Presentation()
            if spec.get("size", "16:9") == "16:9":
                self._widen()
            self._restyle()
        self.W, self.H = int(self.prs.slide_width), int(self.prs.slide_height)

    # ---- the built-in set ---------------------------------------------------------------------

    def _widen(self) -> None:
        factor = 12_192_000 / int(self.prs.slide_width)
        self.prs.slide_width = Emu(12_192_000)
        holders = [self.prs.slide_master, *self.prs.slide_layouts]
        for h in holders:
            for shape in h.shapes:
                if shape.left is not None and shape.width is not None:
                    shape.left, shape.width = Emu(int(shape.left * factor)), Emu(int(shape.width * factor))

    def _restyle(self) -> None:
        t = self.t
        master = self.prs.slide_master
        theme = master.part.part_related_by(RT.THEME)
        root = etree.fromstring(theme.blob)
        ns = {"a": A}
        for tag, font in (("majorFont", t.heading_font), ("minorFont", t.body_font)):
            for el in root.xpath(f"//a:fontScheme/a:{tag}/a:latin", namespaces=ns):
                el.set("typeface", font)
        for el in root.xpath("//a:clrScheme/a:accent1/a:srgbClr", namespaces=ns):
            el.set("val", t.colors["accent"])
        for i, colour in enumerate(t.palette[1:6], start=2):
            for el in root.xpath(f"//a:clrScheme/a:accent{i}/a:srgbClr", namespaces=ns):
                el.set("val", colour)
        theme._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
        styles = master._element.find(f"{{{P}}}txStyles")
        if styles is None:
            return
        title = styles.find(f"{{{P}}}titleStyle/{{{A}}}lvl1pPr")
        if title is not None:
            title.set("algn", "l")
            rpr = title.find(f"{{{A}}}defRPr")
            if rpr is not None:
                rpr.set("sz", str(int(t.heading_sizes[1] * 100 * 1.45)))
                rpr.set("b", "1")
                for fill in rpr.findall(f"{{{A}}}solidFill"):
                    rpr.remove(fill)
                fill = etree.SubElement(rpr, f"{{{A}}}solidFill")
                etree.SubElement(fill, f"{{{A}}}srgbClr").set("val", t.colors["heading"])
                rpr.insert(0, fill)
        for lvl, size in zip(range(1, 6), (20, 18, 16, 14, 14), strict=True):
            el = styles.find(f"{{{P}}}bodyStyle/{{{A}}}lvl{lvl}pPr/{{{A}}}defRPr")
            if el is not None:
                el.set("sz", str(int(size * 100)))
        self.prs.core_properties  # noqa: B018 - touches the part so it exists before properties are set

    # ---- layouts ------------------------------------------------------------------------------

    def layouts(self) -> dict[str, Any]:
        return {lay.name.lower(): lay for lay in self.prs.slide_layouts}

    def pick(self, name: str, where: str) -> Any:
        if not self.has_template:
            if name in BUILTIN:
                return self.prs.slide_layouts[BUILTIN[name]]
            raise InvalidRequest(
                f"{where}: unknown layout {name!r}; available: {sorted(BUILTIN)}. "
                "Named layouts need `theme.template` (an uploaded presentation).",
                reason="schema",
                details={"available": sorted(BUILTIN)},
            )
        named = self.layouts()
        if name.lower() in named:
            return named[name.lower()]
        if name in BUILTIN:
            found = self._by_shape(name)
            if found is not None:
                return found
        raise InvalidRequest(
            f"{where}: the template has no layout {name!r}; its layouts: {[lay.name for lay in self.prs.slide_layouts]}",
            reason="schema",
            details={"available": [lay.name for lay in self.prs.slide_layouts]},
        )

    def _by_shape(self, kind: str) -> Any | None:
        def types(lay: Any) -> list[Any]:
            return [p.placeholder_format.type for p in lay.placeholders]

        body = (PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT)
        for lay in self.prs.slide_layouts:
            ts = types(lay)
            has_title = PP_PLACEHOLDER.TITLE in ts or PP_PLACEHOLDER.CENTER_TITLE in ts
            n_body = sum(x in body for x in ts)
            if kind == "title" and PP_PLACEHOLDER.CENTER_TITLE in ts:
                return lay
            if kind == "section" and has_title and "section" in lay.name.lower():
                return lay
            if kind == "title_content" and has_title and n_body == 1 and PP_PLACEHOLDER.CENTER_TITLE not in ts:
                return lay
            if kind == "two_content" and has_title and n_body >= 2:
                return lay
            if kind == "title_only" and has_title and n_body == 0 and PP_PLACEHOLDER.SUBTITLE not in ts:
                return lay
            if kind == "blank" and not ts:
                return lay
        return None

    # ---- build --------------------------------------------------------------------------------

    def build(self) -> tuple[bytes, dict[str, Any]]:
        for i, s in enumerate(self.spec["slides"]):
            self.slide(i, s)
        cp = self.prs.core_properties
        cp.author = cp.last_modified_by = "Cerea"
        cp.title = str(self.spec.get("title") or "")
        cp.created = cp.modified = FIXED
        cp.revision = 1
        if self.spec.get("language"):
            cp.language = self.spec["language"]
        out = io.BytesIO()
        self.prs.save(out)
        return fix_zip(out.getvalue()), {"charts": self.charts, "notes": self.notes, "slides": len(self.spec["slides"])}

    def slide(self, i: int, s: dict[str, Any]) -> None:
        where = f"slides[{i}]"
        visuals_only = bool(s.get("images") or s.get("charts"))
        default = (
            "title" if i == 0 and not s.get("body") and not visuals_only
            else "two_content" if s.get("body_right")
            else "title_content" if s.get("body") or visuals_only
            else "title_only"
        )  # fmt: skip
        layout = self.pick(s.get("layout") or default, where)
        slide = self.prs.slides.add_slide(layout)
        phs = list(slide.placeholders)
        title_ph = next(
            (p for p in phs if p.placeholder_format.type in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE)), None
        )
        sub_ph = next((p for p in phs if p.placeholder_format.type == PP_PLACEHOLDER.SUBTITLE), None)
        bodies = [p for p in phs if p.placeholder_format.type in (PP_PLACEHOLDER.BODY, PP_PLACEHOLDER.OBJECT)]
        pictures = [p for p in phs if p.placeholder_format.type == PP_PLACEHOLDER.PICTURE]
        centered = (s.get("layout") or default) in ("title", "section") and not self.has_template
        if s.get("title"):
            if title_ph is None:
                self.notes.append(f"{where}: layout {layout.name!r} has no title placeholder; the title was not shown")
            else:
                self._text(
                    title_ph,
                    [{"text": s["title"]}],
                    0,
                    size=36 if centered else None,
                    bold=True if centered else None,
                    align=PP_ALIGN.CENTER if centered else None,
                    heading=True,
                )
        if s.get("subtitle"):
            target = sub_ph or (bodies.pop(0) if bodies and layout.name.lower().startswith("section") else None)
            if target is None:
                self.notes.append(
                    f"{where}: layout {layout.name!r} has no subtitle placeholder; the subtitle was not shown"
                )
            else:
                self._text(
                    target,
                    [{"text": s["subtitle"]}],
                    0,
                    size=22 if not self.has_template else None,
                    align=PP_ALIGN.CENTER if centered else None,
                )
        left, right = [*bodies, None, None][:2]
        area = self._area(slide, title_ph, left)
        self.fill(
            slide,
            s.get("body") or [],
            left,
            area if s.get("body_right") is None else self._half(area, 0),
            s,
            where,
            extra=True,
        )
        if s.get("body_right"):
            self.fill(slide, s["body_right"], right, self._half(area, 1), s, where + ".body_right", extra=False)
        for ph in pictures:
            self._remove(ph)
        if s.get("notes"):
            slide.notes_slide.notes_text_frame.text = s["notes"]
        for ph in list(slide.placeholders):  # nothing may be left as "Click to add text"
            if ph.has_text_frame and not ph.text_frame.text.strip() and ph.element.getparent() is not None:
                self._remove(ph)

    @staticmethod
    def _remove(shape: Any) -> None:
        shape.element.getparent().remove(shape.element)

    def _area(self, slide: Any, title_ph: Any, body_ph: Any) -> Box:
        if body_ph is not None and body_ph.width:
            return int(body_ph.left), int(body_ph.top), int(body_ph.width), int(body_ph.height)
        top = int(
            (title_ph.top + title_ph.height) if title_ph is not None and title_ph.top is not None else Inches(1.4)
        ) + int(Inches(0.2))
        margin = int(Inches(0.6))
        return margin, top, self.W - 2 * margin, self.H - top - margin

    @staticmethod
    def _half(area: Box, side: int) -> Box:
        x, y, w, h = area
        gap = int(Inches(0.3))
        return (x + side * (w + gap) // 2, y, (w - gap) // 2, h)

    # ---- content ------------------------------------------------------------------------------

    def fill(
        self, slide: Any, blocks: list[dict[str, Any]], ph: Any, area: Box, s: dict[str, Any], where: str, extra: bool
    ) -> None:
        text = [b for b in blocks if b["type"] in TEXT_KINDS]
        visuals: list[dict[str, Any]] = [b for b in blocks if b["type"] not in TEXT_KINDS]
        if extra:  # explicit images and charts of the slide
            visuals += [{"type": "image", "_slide_image": im} for im in s.get("images") or []]
            visuals += [{"type": "chart", **c} for c in s.get("charts") or []]
        x, y, w, h = area
        text_area, visual_area = area, area
        if text and visuals:
            gap = int(Inches(0.3))
            tw = int((w - gap) * 0.42)
            text_area, visual_area = (x, y, tw, h), (x + tw + gap, y, w - tw - gap, h)
        if text:
            target = ph
            if target is None:
                target = slide.shapes.add_textbox(*text_area)
            else:
                target.left, target.top, target.width, target.height = text_area
            self._body(target, text, text_area)
        elif ph is not None:
            self._remove(ph)
        self._visuals(slide, visuals, visual_area, where)

    def _body(self, shape: Any, blocks: list[dict[str, Any]], area: Box) -> None:
        paras: list[tuple[list[dict[str, Any]], int, str]] = []  # runs, level, kind
        for b in blocks:
            if b["type"] == "list":
                self._flatten(b["items"], 0, bool(b.get("ordered")), paras)
            elif b["type"] == "code":
                paras.extend(([{"text": line, "code": True}], 0, "code") for line in b["text"].split("\n"))
            else:
                paras.append((b.get("runs") or [{"text": b.get("text", "")}], 0, b["type"]))
        size = self._fit_size(paras, area)
        tf = shape.text_frame
        tf.word_wrap = True
        for n, (runs, level, kind) in enumerate(paras):
            p = tf.paragraphs[0] if n == 0 else tf.add_paragraph()
            if kind in ("paragraph", "quote", "code"):
                self._nobullet(p)
            p.level = min(level, 4)
            for r in runs:
                self._run(p, r, size - 2 * min(level, 3), italic=kind == "quote", mono=kind == "code")
            p.space_after = Pt(6)

    def _flatten(self, items: list[Any], level: int, ordered: bool, out: list[Any]) -> None:
        for n, it in enumerate(items, 1):
            block = {"text": it} if isinstance(it, str) else it
            runs = list(block.get("runs") or [{"text": block.get("text", "")}])
            if ordered:
                runs = [{"text": f"{n}. "}, *runs]
            out.append((runs, level, "list"))
            if not isinstance(it, str) and it.get("children"):
                self._flatten(it["children"], level + 1, ordered, out)

    def _nobullet(self, p: Any) -> None:
        ppr = p._p.get_or_add_pPr()
        ppr.set("marL", "0")
        ppr.set("indent", "0")
        if ppr.find(f"{{{A}}}buNone") is None:
            etree.SubElement(ppr, f"{{{A}}}buNone")

    def _fit_size(self, paras: list[Any], area: Box) -> int:
        """The largest of 20..12 pt at which the text is estimated to fit the area."""
        for size in (20, 18, 16, 14, 12):
            per_line = max(10, int(area[2] / 12700 / (size * 0.52)))
            lines = sum(
                max(1, math.ceil(sum(len(r["text"]) for r in runs) / max(per_line - 4 * lvl, 6)))
                for runs, lvl, _k in paras
            )
            if lines * size * 1.2 + len(paras) * 6 <= area[3] / 12700:
                return size
        return 12

    def _run(self, p: Any, r: dict[str, Any], size: float | None, italic: bool = False, mono: bool = False) -> None:
        run = p.add_run()
        run.text = r["text"]
        f = run.font
        if size:
            f.size = Pt(size)
        if r.get("bold"):
            f.bold = True
        if r.get("italic") or italic:
            f.italic = True
        if r.get("underline"):
            f.underline = True
        if r.get("code") or mono:
            f.name = "Consolas"
        elif self.t.uses("body_font") and self.has_template:
            f.name = self.t.body_font
        if r.get("color"):
            f.color.rgb = _rgb(r["color"])
        elif self.t.uses("color_text") and not (r.get("link")):
            f.color.rgb = _rgb(self.t.colors["text"])
        if r.get("link"):
            run.hyperlink.address = r["link"]

    def _text(
        self,
        shape: Any,
        runs: list[dict[str, Any]],
        level: int,
        size: float | None = None,
        bold: bool | None = None,
        align: Any = None,
        heading: bool = False,
    ) -> None:
        tf = shape.text_frame
        p = tf.paragraphs[0]
        if align is not None:
            p.alignment = align
        for r in runs:
            self._run(p, r, size)
            if bold is not None:
                p.runs[-1].font.bold = bold
        if heading:
            for run in p.runs:
                if self.has_template and self.t.uses("heading_font"):
                    run.font.name = self.t.heading_font
                if self.t.uses("color_heading"):
                    run.font.color.rgb = _rgb(self.t.colors["heading"])

    # visuals: tables, images, charts laid out in a grid inside the area
    def _visuals(self, slide: Any, visuals: list[dict[str, Any]], area: Box, where: str) -> None:
        if not visuals:
            return
        placed = [v for v in visuals if self._has_box(v)]
        flow = [v for v in visuals if not self._has_box(v)]
        for v in placed:
            self._place(slide, v, self._box_of(v), where)
        if not flow:
            return
        x, y, w, h = area
        cols = 1 if len(flow) == 1 else 2
        rows = math.ceil(len(flow) / cols)
        gap = int(Inches(0.2))
        cw, ch = (w - gap * (cols - 1)) // cols, (h - gap * (rows - 1)) // rows
        for n, v in enumerate(flow):
            r, c = divmod(n, cols)
            self._place(slide, v, (x + c * (cw + gap), y + r * (ch + gap), cw, ch), where)

    @staticmethod
    def _has_box(v: dict[str, Any]) -> bool:
        src = v.get("_slide_image") or v
        return not src.get("fit") and any(k in src for k in ("x_cm", "y_cm", "width_cm", "height_cm"))

    def _box_of(self, v: dict[str, Any]) -> Box:
        """An explicit box in EMU; a missing position is -1 (centred for pictures, the content corner otherwise)."""
        src = v.get("_slide_image") or v
        x = int(src["x_cm"] * EMU_CM) if "x_cm" in src else -1
        y = int(src["y_cm"] * EMU_CM) if "y_cm" in src else -1
        w = int(src["width_cm"] * EMU_CM) if "width_cm" in src else 0
        h = int(src["height_cm"] * EMU_CM) if "height_cm" in src else 0
        return x, y, w, h

    def _place(self, slide: Any, v: dict[str, Any], box: Box, where: str) -> None:
        kind = v["type"]
        if kind == "table":
            self._table(slide, v, box)
        elif kind == "chart":
            self._chart(slide, v, box)
        else:
            self._image(slide, v.get("_slide_image") or v, box)

    def _image(self, slide: Any, im: dict[str, Any], box: Box) -> None:
        img = self.images.get(im["image"])
        x, y, w, h = box
        aspect = img.info.width / img.info.height
        if not w and not h:
            w = int(self.W * 0.5)
        if not w:
            w = int(h * aspect)
        if not h:
            h = int(w / aspect)
        if w / h > aspect:  # fit inside the box without distortion, centred in it
            w2, h2 = int(h * aspect), h
        else:
            w2, h2 = w, int(w / aspect)
        px = (self.W - w2) // 2 if x < 0 else x + (w - w2) // 2
        py = (self.H - h2) // 2 if y < 0 else y + (h - h2) // 2
        pic = slide.shapes.add_picture(io.BytesIO(img.data), px, py, w2, h2)
        pic._element.nvPicPr.cNvPr.set("descr", im.get("alt") or im["image"])

    def _chart(self, slide: Any, c: dict[str, Any], box: Box) -> None:
        x, y, w, h = box
        x, y = (int(Inches(0.6)) if x < 0 else x), (int(Inches(1.6)) if y < 0 else y)
        w = w or int(Inches(6))
        h = h or int(w * 9 / 16)
        if c.get("render", "native") == "native":
            try:
                charts.add_pptx_chart(slide.shapes, c, self.t, x, y, w, h)
                self.charts.append(charts.describe(c, "native"))
                return
            except Exception as exc:
                note = f"native chart could not be written ({type(exc).__name__}); placed as an image instead"
                self.notes.append(note)
                self.charts.append(charts.describe(c, "image", note))
        else:
            self.charts.append(charts.describe(c, "image"))
        png = charts.render_png(c, self.t, w / EMU_CM, h / EMU_CM)
        pic = slide.shapes.add_picture(io.BytesIO(png), x, y, w, h)
        pic._element.nvPicPr.cNvPr.set("descr", c.get("title") or f"{c['chart_type']} chart")

    def _table(self, slide: Any, b: dict[str, Any], box: Box) -> None:
        t = self.t
        style = b.get("style") or t.table_style
        header, rows = b.get("header"), b["rows"]
        cols = max([len(header or []), *(len(r) for r in rows)])
        data = ([header] if header else []) + rows
        x, y, w, h = box
        x, y = (int(Inches(0.6)) if x < 0 else x), (int(Inches(1.6)) if y < 0 else y)
        w = w or self.W - 2 * x
        h = h or int(Inches(4))
        size = max(9, min(14, int(16 - len(data) / 2)))
        row_h = int(Pt(size * 2.1))
        frame = slide.shapes.add_table(len(data), cols, x, y, w, min(h, row_h * len(data)))
        table = frame.table
        sid = frame._element.find(f".//{{{A}}}tableStyleId")
        if sid is not None:
            sid.text = TABLE_STYLE_IDS[style]
        table.first_row = bool(header)
        widths = b.get("widths") or [1] * cols
        for i, wd in enumerate(widths):
            table.columns[i].width = int(w * wd / sum(widths))
        aligns = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}
        for ri, row in enumerate(data):
            is_head = bool(header) and ri == 0
            table.rows[ri].height = row_h
            for ci in range(cols):
                raw = row[ci] if ci < len(row) else ""
                spec = raw if isinstance(raw, dict) else {"text": raw}
                v = spec["text"]
                cell = table.cell(ri, ci)
                cell.text = "" if v is None else ("true" if v is True else "false" if v is False else str(v))
                p = cell.text_frame.paragraphs[0]
                p.alignment = aligns[spec.get("align") or (b.get("align") or ["left"] * cols)[ci]]
                f = p.runs[0].font if p.runs else None
                if f is None:
                    continue
                f.size = Pt(size)
                f.bold = bool(spec.get("bold")) or is_head
                fill = spec.get("fill")
                colour = spec.get("color")
                if is_head and style in ("banded", "grid"):
                    fill, colour = fill or t.colors["table_header_fill"], colour or t.colors["table_header_text"]
                elif style == "banded" and not fill and (ri - (1 if header else 0)) % 2 == 1:
                    fill = t.colors["table_band"]
                elif style == "banded" and not fill:
                    fill = "FFFFFF"
                if fill:
                    cell.fill.solid()
                    cell.fill.fore_color.rgb = _rgb(fill)
                if colour:
                    f.color.rgb = _rgb(colour)
                elif not (is_head and style in ("banded", "grid")):
                    f.color.rgb = _rgb(t.colors["text"])


def build_pptx(
    spec: dict[str, Any], images: ImageSet, theme: Theme, template: bytes | None
) -> tuple[bytes, dict[str, Any]]:
    return PptxBuilder(spec, images, theme, template).build()
