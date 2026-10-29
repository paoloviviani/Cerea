"""PDF form fixtures, built in the tests (reportlab for the layout, pypdf for what reportlab cannot say).

`make_form_pdf()` is a three-page AcroForm:
  page 1: a text field `full_name`, a text field `code` with a maximum length of 5, a read-only field `locked`
          and a required field `email`;
  page 2: a checkbox `agree` whose on-state is `Si`, a radio group `colour` (red, green, blue);
  page 3: a combo box `country` (export IT/FR/ES, shown as Italy/France/Spain), a list box `topics`
          (alpha, beta, gamma), a multi-select list `tags`, a text field `notes` and a signature `signature`.
"""

from __future__ import annotations

import io
from typing import Any

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    TextStringObject,
)
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


def _acro_fields(writer: PdfWriter) -> dict[str, DictionaryObject]:
    root = writer._root_object
    found: dict[str, DictionaryObject] = {}
    for ref in root["/AcroForm"]["/Fields"]:
        field = ref.get_object()
        found[str(field["/T"])] = field
    return found


def make_form_pdf() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    form = c.acroForm
    c.drawString(72, 780, "Application form - page 1")
    c.drawString(72, 722, "Full name")
    form.textfield(name="full_name", x=160, y=716, width=240, height=20)
    c.drawString(72, 682, "Code")
    form.textfield(name="code", x=160, y=676, width=100, height=20)
    c.drawString(72, 642, "Locked")
    form.textfield(name="locked", x=160, y=636, width=100, height=20, value="fixed", fieldFlags="readOnly")
    c.drawString(72, 602, "Email")
    form.textfield(name="email", x=160, y=596, width=240, height=20, fieldFlags="required")
    c.showPage()
    c.drawString(72, 780, "Application form - page 2")
    c.drawString(72, 722, "I agree")
    form.checkbox(name="agree", x=160, y=718, size=16, checked=False)
    c.drawString(72, 672, "Colour")
    for i, colour in enumerate(("red", "green", "blue")):
        x = 160 + i * 70
        form.radio(name="colour", value=colour, x=x, y=668, size=16, selected=False)
        c.drawString(x + 22, 672, colour)
    c.showPage()
    c.drawString(72, 780, "Application form - page 3")
    c.drawString(72, 722, "Country")
    form.choice(
        name="country",
        x=160,
        y=716,
        width=150,
        height=20,
        options=[("Italy", "IT"), ("France", "FR"), ("Spain", "ES")],
        value="IT",
        fieldFlags="combo",
    )
    c.drawString(72, 640, "Topics")
    form.listbox(name="topics", x=160, y=600, width=150, height=60, options=["alpha", "beta", "gamma"], value="alpha")
    c.drawString(72, 560, "Tags")
    form.listbox(
        name="tags",
        x=160,
        y=520,
        width=150,
        height=60,
        options=["red", "green", "blue", "grey"],
        value="red",
        fieldFlags="multiSelect",
    )
    c.drawString(72, 480, "Notes")
    form.textfield(name="notes", x=160, y=440, width=300, height=60, fieldFlags="multiline")
    c.showPage()
    c.save()

    writer = PdfWriter(clone_from=io.BytesIO(buf.getvalue()))
    fields = _acro_fields(writer)
    fields["code"][NameObject("/MaxLen")] = NumberObject(5)
    fields["email"][NameObject("/Ff")] = NumberObject(2)  # required
    fields["agree"][NameObject("/Ff")] = NumberObject(0)  # reportlab marks every button required; only email is
    fields["colour"][NameObject("/Ff")] = NumberObject((1 << 14) | (1 << 15))  # radio, one option always chosen
    # a checkbox whose on-state is /Si, not reportlab's /Yes
    agree = fields["agree"]
    for key in ("/N", "/D"):
        states = agree["/AP"][key]
        if "/Yes" in states:
            states[NameObject("/Si")] = states.raw_get("/Yes")
            del states["/Yes"]
    # the multi-select list really is one (reportlab's flag name is not honoured by every version)
    fields["tags"][NameObject("/Ff")] = NumberObject(1 << 21)
    # a signature field on page 3
    sig = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Widget"),
            NameObject("/FT"): NameObject("/Sig"),
            NameObject("/T"): TextStringObject("signature"),
            NameObject("/Rect"): ArrayObject([NumberObject(v) for v in (160, 380, 360, 420)]),
            NameObject("/F"): NumberObject(4),
        }
    )
    ref = writer._add_object(sig)
    sig[NameObject("/P")] = writer.pages[2].indirect_reference
    writer.pages[2]["/Annots"].append(ref)
    writer._root_object["/AcroForm"]["/Fields"].append(ref)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def make_plain_pdf() -> bytes:
    """Two pages and no form at all."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.drawString(72, 780, "Just text, name: ______")
    c.showPage()
    c.drawString(72, 780, "Page two")
    c.showPage()
    c.save()
    return buf.getvalue()


def make_flatten_check_pdf() -> bytes:
    """A one-page form built to check where a flattened copy reports its values: three text fields whose
    labels sit well above them, so no value shares its label's baseline, and the last one turned by 90°
    (/MK /R), so its appearance stream carries a /Matrix."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    form = c.acroForm
    c.drawString(72, 780, "Flatten check")
    c.drawString(72, 700, "Who")
    form.textfield(name="who", x=72, y=650, width=200, height=18)
    c.drawString(300, 700, "Sum")
    form.textfield(name="sum", x=300, y=650, width=120, height=18)
    c.drawString(500, 700, "Turned")
    form.textfield(name="turned", x=500, y=650, width=18, height=60)
    c.save()

    writer = PdfWriter(clone_from=io.BytesIO(buf.getvalue()))
    fields = _acro_fields(writer)
    fields["turned"][NameObject("/MK")] = DictionaryObject({NameObject("/R"): NumberObject(90)})
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def make_xfa_pdf() -> bytes:
    """The form fixture with an /XFA entry in its AcroForm, as a hybrid LiveCycle form carries."""
    writer = PdfWriter(clone_from=io.BytesIO(make_form_pdf()))
    xml = b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>'
    from pypdf.generic import DecodedStreamObject

    stream = DecodedStreamObject()
    stream.set_data(xml)
    ref = writer._add_object(stream)
    writer._root_object["/AcroForm"][NameObject("/XFA")] = ArrayObject([TextStringObject("template"), ref])
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def reread(data: bytes) -> dict[str, object]:
    """Field name -> /V as a plain value, straight from pypdf (no code of ours in between)."""
    reader = PdfReader(io.BytesIO(data))
    return {n: f.get("/V") for n, f in (reader.get_fields() or {}).items()}


# -- hand-built structures, the way real forms are stored --------------------------------------------------
# (after the review probes: a field tree whose widgets are separate unnamed kids, signatures, buttons without
# appearances, widgets that are screen-only or rotated)


def _n(s: str) -> NameObject:
    return NameObject(s)


def _ap_stream(w: float, h: float, data: bytes = b"") -> Any:
    from pypdf.generic import DecodedStreamObject, FloatObject

    s = DecodedStreamObject()
    s.set_data(data)
    s.update(
        {
            _n("/Type"): _n("/XObject"),
            _n("/Subtype"): _n("/Form"),
            _n("/BBox"): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(w), FloatObject(h)]),
        }
    )
    return s


class Hand:
    """A one-page document with an empty AcroForm (/DA Helvetica, /DR with /Helv) to add fields to."""

    def __init__(self, rotate: int = 0, sigflags: int | None = None) -> None:
        from pypdf.generic import FloatObject

        buf = io.BytesIO()
        c = canvas.Canvas(buf)
        c.drawString(72, 800, "hand-built form")
        c.showPage()
        c.save()
        self.w = PdfWriter(clone_from=io.BytesIO(buf.getvalue()))
        if rotate:
            self.w.pages[0][_n("/Rotate")] = NumberObject(rotate)
        font = DictionaryObject(
            {
                _n("/Type"): _n("/Font"),
                _n("/Subtype"): _n("/Type1"),
                _n("/BaseFont"): _n("/Helvetica"),
                _n("/Encoding"): _n("/WinAnsiEncoding"),
            }
        )
        self.acro = DictionaryObject(
            {
                _n("/Fields"): ArrayObject(),
                _n("/DA"): TextStringObject("/Helv 0 Tf 0 g"),
                _n("/DR"): DictionaryObject({_n("/Font"): DictionaryObject({_n("/Helv"): self.w._add_object(font)})}),
            }
        )
        if sigflags is not None:
            self.acro[_n("/SigFlags")] = NumberObject(sigflags)
        self.w._root_object[_n("/AcroForm")] = self.w._add_object(self.acro)
        self.w.pages[0][_n("/Annots")] = ArrayObject()
        self._float = FloatObject

    def widget(self, parent: Any, rect: list[float], extra: dict[str, Any] | None = None, flags: int = 4) -> Any:
        d = DictionaryObject(
            {
                _n("/Type"): _n("/Annot"),
                _n("/Subtype"): _n("/Widget"),
                _n("/Rect"): ArrayObject([self._float(x) for x in rect]),
                _n("/F"): NumberObject(flags),
                _n("/P"): self.w.pages[0].indirect_reference,
            }
        )
        if parent is not None:
            d[_n("/Parent")] = parent
        for k, v in (extra or {}).items():
            d[_n(k)] = v
        ref = self.w._add_object(d)
        self.w.pages[0]["/Annots"].append(ref)
        return ref

    def field(
        self,
        entries: dict[str, Any],
        kids: list[list[float]] | None = None,
        top: bool = True,
        kid_extra: list[dict[str, Any]] | None = None,
        rect: list[float] | None = None,
        flags: int = 4,
    ) -> Any:
        """A terminal field. With `kids`, the widgets are separate unnamed kids; otherwise the field is its own widget."""
        ref = self.w._add_object(DictionaryObject({_n(k): v for k, v in entries.items()}))
        obj = ref.get_object()
        if kids is not None:
            obj[_n("/Kids")] = ArrayObject(
                [self.widget(ref, r, (kid_extra[i] if kid_extra else None), flags) for i, r in enumerate(kids)]
            )
        else:
            obj.update(
                {
                    _n("/Type"): _n("/Annot"),
                    _n("/Subtype"): _n("/Widget"),
                    _n("/Rect"): ArrayObject([self._float(x) for x in (rect or [100, 600, 300, 620])]),
                    _n("/F"): NumberObject(flags),
                    _n("/P"): self.w.pages[0].indirect_reference,
                }
            )
            self.w.pages[0]["/Annots"].append(ref)
        if top:
            self.acro["/Fields"].append(ref)
        return ref

    def group(self, name: str, entries: dict[str, Any] | None = None) -> Any:
        """A non-terminal node (`applicant`), added to the form's top level."""
        d = {_n("/T"): TextStringObject(name), **{_n(k): v for k, v in (entries or {}).items()}}
        ref = self.w._add_object(DictionaryObject(d))
        self.acro["/Fields"].append(ref)
        return ref

    def bytes(self) -> bytes:
        buf = io.BytesIO()
        self.w.write(buf)
        return buf.getvalue()


def button_ap(w: Hand, states: list[str]) -> DictionaryObject:
    return DictionaryObject(
        {
            _n("/N"): DictionaryObject(
                {
                    **{_n("/" + s): w.w._add_object(_ap_stream(10, 10, b"0 g 2 2 6 6 re f")) for s in states},
                    _n("/Off"): w.w._add_object(_ap_stream(10, 10)),
                }
            )
        }
    )


def make_repeated_field_pdf() -> bytes:
    """`applicant` > `name` (text, DA on the grandparent) with two unnamed widget kids, and `spouse` > `name` with one:
    how Acrobat stores a field that appears twice."""
    h = Hand()
    applicant = h.group("applicant", {"/FT": _n("/Tx"), "/DA": TextStringObject("/Helv 10 Tf 0 g")})
    name1 = h.field(
        {"/T": TextStringObject("name"), "/Parent": applicant},
        kids=[[100, 700, 300, 720], [100, 650, 300, 670]],
        top=False,
    )
    applicant.get_object()[_n("/Kids")] = ArrayObject([name1])
    spouse = h.group("spouse", {"/FT": _n("/Tx")})
    name2 = h.field({"/T": TextStringObject("name"), "/Parent": spouse}, kids=[[100, 550, 300, 570]], top=False)
    spouse.get_object()[_n("/Kids")] = ArrayObject([name2])
    return h.bytes()


def make_signed_pdf(with_signature_value: bool = True) -> bytes:
    from pypdf.generic import ByteStringObject

    h = Hand(sigflags=3)
    entries: dict[str, Any] = {"/T": TextStringObject("firma"), "/FT": _n("/Sig")}
    if with_signature_value:
        entries["/V"] = h.w._add_object(
            DictionaryObject(
                {
                    _n("/Type"): _n("/Sig"),
                    _n("/Filter"): _n("/Adobe.PPKLite"),
                    _n("/ByteRange"): ArrayObject(
                        [NumberObject(0), NumberObject(10), NumberObject(20), NumberObject(30)]
                    ),
                    _n("/Contents"): ByteStringObject(b"\x00" * 16 + b"SECRET-SIGNATURE-BYTES"),
                }
            )
        )
    h.field(entries, rect=[100, 100, 300, 140])
    h.field({"/T": TextStringObject("nome"), "/FT": _n("/Tx")}, kids=[[100, 500, 300, 520]])
    return h.bytes()
