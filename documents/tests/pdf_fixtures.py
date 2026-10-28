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
