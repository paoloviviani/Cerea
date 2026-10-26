"""Create a PDF from a spec with reportlab (OSI-licensed, deterministic, no converter, no LibreOffice).

Fonts are the DejaVu faces that ship with matplotlib, embedded as subsets, so any Latin, Greek or Cyrillic
text renders. The spec's font names map to the nearest of the three families (sans, serif, mono)."""

from __future__ import annotations

import importlib.util
import io
import re
import textwrap
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from reportlab.lib import colors as rl_colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    Flowable,
    Image,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents

from . import charts
from .errors import InvalidRequest
from .images_ref import ImageSet
from .make_docx import PAGE_CM
from .theme import Theme

ALIGN = {"left": TA_LEFT, "center": TA_CENTER, "right": TA_RIGHT, "justify": TA_JUSTIFY}
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_FAMILIES = {
    "DejaVuSans": ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf"),
    "DejaVuSerif": ("DejaVuSerif.ttf", "DejaVuSerif-Bold.ttf", "DejaVuSerif-Italic.ttf", "DejaVuSerif-BoldItalic.ttf"),
    "DejaVuSansMono": (
        "DejaVuSansMono.ttf",
        "DejaVuSansMono-Bold.ttf",
        "DejaVuSansMono-Oblique.ttf",
        "DejaVuSansMono-BoldOblique.ttf",
    ),
}
_registered = False


def register_fonts() -> None:
    global _registered
    if _registered:
        return
    spec = importlib.util.find_spec("matplotlib")
    if spec is None or not spec.submodule_search_locations:
        raise RuntimeError("matplotlib's bundled fonts are missing")
    folder = Path(spec.submodule_search_locations[0]) / "mpl-data" / "fonts" / "ttf"
    for family, files in _FAMILIES.items():
        names = []
        for suffix, file in zip(("", "-B", "-I", "-BI"), files, strict=True):
            name = family + suffix
            pdfmetrics.registerFont(TTFont(name, str(folder / file)))
            names.append(name)
        pdfmetrics.registerFontFamily(family, normal=names[0], bold=names[1], italic=names[2], boldItalic=names[3])
    _registered = True


def _hex(c: str) -> rl_colors.Color:
    return rl_colors.HexColor("#" + c.lstrip("#"))


def _clean(text: str) -> str:
    return _CTRL.sub("", text)


class _Doc(SimpleDocTemplate):  # type: ignore[misc]
    def afterFlowable(self, flowable: Flowable) -> None:  # reportlab's hook
        if isinstance(flowable, Paragraph) and flowable.style.name.startswith("H"):
            level = int(flowable.style.name[1:])
            self.notify("TOCEntry", (level - 1, flowable.getPlainText(), self.page))


class PdfBuilder:
    def __init__(self, spec: dict[str, Any], images: ImageSet, theme: Theme) -> None:
        register_fonts()
        self.spec, self.images, self.t = spec, images, theme
        self.notes: list[str] = list(spec.get("_notes") or [])
        self.charts: list[dict[str, Any]] = []
        page = spec.get("page") or {}
        w, h = PAGE_CM[page.get("size", "A4")]
        self.pagesize = (w * cm, h * cm)
        if page.get("orientation") == "landscape":
            self.pagesize = landscape(self.pagesize)
        m = page.get("margins_cm", 2.5)
        sides = dict.fromkeys(("top", "bottom", "left", "right"), 2.5)
        sides.update({k: m for k in sides} if not isinstance(m, dict) else m)
        self.m = {k: v * cm for k, v in sides.items()}
        self.width = self.pagesize[0] - self.m["left"] - self.m["right"]
        self.height = self.pagesize[1] - self.m["top"] - self.m["bottom"]
        if self.width < 2 * cm or self.height < 2 * cm:
            raise InvalidRequest("spec.page: the margins leave no room for text; reduce margins_cm", reason="schema")
        self.has_toc = any(b["type"] == "toc" for b in spec["blocks"])
        self.styles = self._styles()

    def _styles(self) -> dict[str, ParagraphStyle]:
        t = self.t
        body, head, mono = t.pdf_font(t.body_font), t.pdf_font(t.heading_font), "DejaVuSansMono"
        text = _hex(t.colors["text"])
        lead = t.body_size * t.line_spacing * 1.17
        s = {
            "body": ParagraphStyle(
                "body", fontName=body, fontSize=t.body_size, leading=lead, textColor=text, spaceAfter=t.space_after
            ),
            "cell": ParagraphStyle(
                "cell", fontName=body, fontSize=t.body_size - 1, leading=(t.body_size - 1) * 1.25, textColor=text
            ),
            "caption": ParagraphStyle(
                "caption",
                fontName=body,
                fontSize=max(t.body_size - 2, 8),
                leading=12,
                textColor=_hex(t.colors["muted"]),
                alignment=TA_CENTER,
                spaceAfter=t.space_after + 4,
            ),
            "quote": ParagraphStyle(
                "quote",
                fontName=body + "-I",
                fontSize=t.body_size,
                leading=lead,
                leftIndent=18,
                textColor=_hex(t.colors["muted"]),
                borderPadding=(0, 0, 0, 6),
                spaceAfter=t.space_after,
            ),
            "code": ParagraphStyle(
                "code",
                fontName=mono,
                fontSize=max(t.body_size - 2, 7.5),
                leading=max(t.body_size - 2, 7.5) * 1.3,
                backColor=_hex(t.colors["table_band"]),
                borderPadding=5,
                spaceAfter=t.space_after + 6,
                spaceBefore=4,
                textColor=text,
            ),
        }
        for level in range(1, 7):
            size = t.heading_sizes[level]
            s[f"H{level}"] = ParagraphStyle(
                f"H{level}", fontName=head + "-B" if level <= 3 else head, fontSize=size, leading=size * 1.25,
                textColor=_hex(t.colors["heading"]), spaceBefore=size * (0.9 if level == 1 else 0.7), spaceAfter=6, keepWithNext=1,
            )  # fmt: skip
        return s

    # ---- markup ---------------------------------------------------------------------------------

    def markup(self, block: dict[str, Any]) -> str:
        out = []
        for r in block.get("runs") or [{"text": block.get("text", "")}]:
            text = escape(_clean(r["text"])).replace("\n", "<br/>")
            if r.get("code"):
                text = f'<font face="DejaVuSansMono">{text}</font>'
            if r.get("color"):
                text = f'<font color="#{r["color"].lstrip("#")}">{text}</font>'
            if r.get("bold"):
                text = f"<b>{text}</b>"
            if r.get("italic"):
                text = f"<i>{text}</i>"
            if r.get("underline"):
                text = f"<u>{text}</u>"
            if r.get("link"):
                text = f'<a href="{escape(r["link"], {chr(34): "&quot;"})}" color="#{self.t.colors["link"]}"><u>{text}</u></a>'
            out.append(text)
        return "".join(out)

    def para(self, block: dict[str, Any], style: ParagraphStyle, align: str | None = None) -> Paragraph:
        if align:
            style = ParagraphStyle(style.name + align, parent=style, alignment=ALIGN[align])
        return Paragraph(self.markup(block) or "&nbsp;", style)

    # ---- build ----------------------------------------------------------------------------------

    def build(self) -> tuple[bytes, dict[str, Any]]:
        story: list[Flowable] = []
        for b in self.spec["blocks"]:
            story.extend(getattr(self, "b_" + b["type"])(b))
        buf = io.BytesIO()
        doc = _Doc(
            buf,
            pagesize=self.pagesize,
            leftMargin=self.m["left"],
            rightMargin=self.m["right"],
            topMargin=self.m["top"],
            bottomMargin=self.m["bottom"],
            title=str(self.spec.get("title") or ""),
            author="Cerea",
            creator="cerea-documents",
            invariant=1,
        )
        canvas_cls = self._canvas()
        if self.has_toc:
            doc.multiBuild(story, canvasmaker=canvas_cls)
        else:
            doc.build(story, canvasmaker=canvas_cls)
        return buf.getvalue(), {"charts": self.charts, "notes": self.notes, "pages": doc.page}

    def _canvas(self) -> type[Canvas]:
        builder = self

        class Numbered(Canvas):  # type: ignore[misc]
            def __init__(self, *a: Any, **k: Any) -> None:
                super().__init__(*a, **k)
                self._states: list[dict[str, Any]] = []

            def showPage(self) -> None:
                self._states.append(dict(self.__dict__))
                self._startPage()

            def save(self) -> None:
                total = len(self._states)
                for state in self._states:
                    self.__dict__.update(state)
                    builder._decorate(self, self._pageNumber, total)
                    super().showPage()
                super().save()

        return Numbered

    def _decorate(self, c: Canvas, page: int, total: int) -> None:
        t = self.t
        for key, y in (("header", self.pagesize[1] - self.m["top"] / 2), ("footer", self.m["bottom"] / 2)):
            cfg = self.spec.get(key)
            if not cfg:
                continue
            text = cfg["text"].replace("{pages}", str(total)).replace("{page}", str(page))
            c.setFont(t.pdf_font(t.body_font), max(t.body_size - 2, 8))
            c.setFillColor(_hex(t.colors["muted"]))
            align = cfg.get("align", "center" if key == "footer" else "right")
            x = {"left": self.m["left"], "center": self.pagesize[0] / 2, "right": self.pagesize[0] - self.m["right"]}[
                align
            ]
            {"left": c.drawString, "center": c.drawCentredString, "right": c.drawRightString}[align](x, y, _clean(text))

    # ---- blocks ---------------------------------------------------------------------------------

    def b_heading(self, b: dict[str, Any]) -> list[Flowable]:
        return [self.para(b, self.styles[f"H{b['level']}"])]

    def b_paragraph(self, b: dict[str, Any]) -> list[Flowable]:
        return [self.para(b, self.styles["body"], b.get("align"))]

    def b_page_break(self, _b: dict[str, Any]) -> list[Flowable]:
        return [PageBreak()]

    def b_quote(self, b: dict[str, Any]) -> list[Flowable]:
        out: list[Flowable] = [self.para(b, self.styles["quote"])]
        if b.get("attribution"):
            out.append(Paragraph("— " + escape(b["attribution"]), self.styles["caption"]))
        return out

    def b_code(self, b: dict[str, Any]) -> list[Flowable]:
        st = self.styles["code"]
        per_line = max(20, int((self.width - 12) / (0.602 * st.fontSize)))
        lines: list[str] = []
        for line in _clean(b["text"]).expandtabs(4).split("\n"):
            lines.extend(
                textwrap.wrap(line, per_line, replace_whitespace=False, drop_whitespace=False, break_long_words=True)
                or [""]
            )
        return [Preformatted("\n".join(lines), st)]

    def b_toc(self, b: dict[str, Any]) -> list[Flowable]:
        levels = b.get("levels", 3)
        toc = TableOfContents()
        toc.levelStyles = [
            ParagraphStyle(f"toc{i}", parent=self.styles["body"], leftIndent=14 * i, spaceAfter=2)
            for i in range(levels)
        ]
        title = b.get("title", "Contents")
        out: list[Flowable] = []
        if title:
            out.append(Paragraph(escape(title), ParagraphStyle("toch", parent=self.styles["H2"], keepWithNext=0)))
        return [*out, toc, Spacer(1, 6)]

    def b_list(self, b: dict[str, Any]) -> list[Flowable]:
        return [self._list(b["items"], bool(b.get("ordered")), 0)]

    def _list(self, items: list[Any], ordered: bool, level: int) -> ListFlowable:
        out = []
        for it in items:
            block = {"text": it} if isinstance(it, str) else it
            content: list[Flowable] = [
                Paragraph(
                    self.markup(block) or "&nbsp;", ParagraphStyle("li", parent=self.styles["body"], spaceAfter=2)
                )
            ]
            if not isinstance(it, str) and it.get("children"):
                content.append(self._list(it["children"], ordered, level + 1))
            out.append(ListItem(content))
        bullet = ("\u2022", "\u2013", "\u25aa")[level % 3]
        kw: dict[str, Any] = (
            {"bulletType": "1", "bulletFormat": "%s."} if ordered else {"bulletType": "bullet", "start": bullet}
        )
        return ListFlowable(
            out,
            bulletFontName="DejaVuSans",
            bulletFontSize=self.t.body_size,
            leftIndent=18,
            bulletColor=_hex(self.t.colors["text"]),
            **kw,
        )

    def b_table(self, b: dict[str, Any]) -> list[Flowable]:
        t = self.t
        style = b.get("style") or t.table_style
        header, rows = b.get("header"), b["rows"]
        cols = max([len(header or []), *(len(r) for r in rows)])
        aligns = b.get("align") or ["left"] * cols
        data: list[list[Any]] = []
        cmds: list[Any] = [
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]
        for ri, row in enumerate(([header] if header else []) + rows):
            is_head = bool(header) and ri == 0
            cells = []
            for ci in range(cols):
                raw = row[ci] if ci < len(row) else ""
                spec = raw if isinstance(raw, dict) else {"text": raw}
                text = (
                    ""
                    if spec["text"] is None
                    else ("true" if spec["text"] is True else "false" if spec["text"] is False else str(spec["text"]))
                )
                st = ParagraphStyle("c", parent=self.styles["cell"], alignment=ALIGN[spec.get("align") or aligns[ci]])
                fill = spec.get("fill")
                colour = spec.get("color")
                bold = bool(spec.get("bold")) or is_head
                if is_head and style in ("banded", "grid"):
                    fill = fill or t.colors["table_header_fill"]
                    colour = colour or t.colors["table_header_text"]
                elif style == "banded" and not fill and (ri - (1 if header else 0)) % 2 == 1:
                    fill = t.colors["table_band"]
                if colour:
                    st = ParagraphStyle("c2", parent=st, textColor=_hex(colour))
                body = escape(_clean(text)).replace("\n", "<br/>")
                cells.append(Paragraph(f"<b>{body}</b>" if bold else body, st))
                if fill:
                    cmds.append(("BACKGROUND", (ci, ri), (ci, ri), _hex(fill)))
            data.append(cells)
        grid = _hex(t.colors["border"])
        if style == "grid":
            cmds.append(("GRID", (0, 0), (-1, -1), 0.5, grid))
        elif style == "banded":
            cmds += [("LINEBELOW", (0, 0), (-1, -1), 0.5, grid), ("LINEABOVE", (0, 0), (-1, 0), 0.5, grid)]
        elif style == "minimal":
            cmds += [("LINEABOVE", (0, 0), (-1, 0), 0.75, grid), ("LINEBELOW", (0, -1), (-1, -1), 0.75, grid)]
            if header:
                cmds.append(("LINEBELOW", (0, 0), (-1, 0), 0.75, grid))
        widths = b.get("widths") or [1] * cols
        col_w = [self.width * w / sum(widths) for w in widths]
        table = Table(data, colWidths=col_w, repeatRows=1 if header else 0, style=TableStyle(cmds))
        out: list[Flowable] = [table]
        out.append(Paragraph(escape(b["caption"]), self.styles["caption"]) if b.get("caption") else Spacer(1, 8))
        return out

    def _fit(self, aspect: float, w_cm: float | None, h_cm: float | None, natural_cm: float) -> tuple[float, float]:
        w = w_cm * cm if w_cm else None
        h = h_cm * cm if h_cm else None
        if w is None and h is None:
            w = min(natural_cm * cm, self.width)
        if w is None:
            w = (h or 1) * aspect
        if h is None:
            h = w / aspect
        if w > self.width:
            w, h = self.width, h * self.width / w
        room = self.height - 14  # the frame's own padding
        if h > room:  # never taller than the frame, or the page cannot be laid out
            w, h = w * room / h, room
        return w, h

    def _picture(self, data: bytes, w: float, h: float, align: str, caption: str | None) -> list[Flowable]:
        img = Image(io.BytesIO(data), width=w, height=h)
        img.hAlign = align.upper()
        parts: list[Flowable] = [img]
        if caption:
            parts.append(Paragraph(escape(caption), self.styles["caption"]))
        else:
            parts.append(Spacer(1, 6))
        return [KeepTogether(parts)]

    def b_image(self, b: dict[str, Any]) -> list[Flowable]:
        img = self.images.get(b["image"])
        w, h = self._fit(
            img.info.width / img.info.height, b.get("width_cm"), b.get("height_cm"), img.info.width / 96 * 2.54
        )
        return self._picture(img.data, w, h, b.get("align", "center"), b.get("caption"))

    def b_chart(self, b: dict[str, Any]) -> list[Flowable]:
        w, h = self._fit(
            charts.DEFAULT_CM[0] / charts.DEFAULT_CM[1], b.get("width_cm"), b.get("height_cm"), charts.DEFAULT_CM[0]
        )
        note = "PDF charts are always images" if b.get("render") == "native" else None
        self.charts.append(charts.describe(b, "image", note))
        png = charts.render_png(b, self.t, w / cm, h / cm)
        return self._picture(png, w, h, b.get("align", "center"), b.get("caption"))


def build_pdf(spec: dict[str, Any], images: ImageSet, theme: Theme) -> tuple[bytes, dict[str, Any]]:
    return PdfBuilder(spec, images, theme).build()
