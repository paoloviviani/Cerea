"""PDF forms (AcroForm): list the fields of a form, fill them, flatten, and check the result.

This file is deliberately self-contained (pypdf and the standard library only) because the same code runs in
two places: the document service (`doc_outline` and `doc_edit fill_form` on a PDF) and the chat's Python
sandbox (`pdf_tools.py` of the `pdf-tools` skill, the fallback when the document tools are not available).
`tests/test_pdf_tools_helper.py` fails when the copy in the skill drifts; `scripts/sync_pdf_tools.py`
rewrites it. Keep this file free of imports from the rest of the package.
"""

from __future__ import annotations

import difflib
import io
import re
import unicodedata
from typing import Any

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    FloatObject,
    IndirectObject,
    NameObject,
    NumberObject,
    StreamObject,
    TextStringObject,
)

MAX_DEPTH = 32
OFF = "Off"

# field flag bits (PDF 32000-1, tables 221, 226, 228, 230), as masks
F_READ_ONLY = 1 << 0
F_REQUIRED = 1 << 1
F_NO_TOGGLE_TO_OFF = 1 << 14
F_RADIO = 1 << 15
F_PUSHBUTTON = 1 << 16
F_COMBO = 1 << 17
F_EDITABLE = 1 << 18
F_MULTILINE = 1 << 12
F_PASSWORD = 1 << 13
F_MULTISELECT = 1 << 21
F_COMB = 1 << 24

CHECKBOX_ON_DEFAULT = "Yes"


class PdfFormError(Exception):
    """A refusal that explains itself. `problems` lists one entry per value that was not acceptable."""

    def __init__(self, message: str, *, reason: str = "form", problems: list[dict[str, Any]] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.reason = reason
        self.problems = problems or []


# -- reading the field tree ---------------------------------------------------------------------------


class Field:
    """One terminal field of the form: its dictionary, its widgets and where they sit."""

    def __init__(self, name: str, obj: DictionaryObject, chain: tuple[DictionaryObject, ...]) -> None:
        self.name = name
        self.obj = obj
        self.chain = chain  # the field and its ancestors, nearest first (for inherited keys)
        self.widgets: list[DictionaryObject] = []
        self.pages: list[int] = []
        self.widget_pages: list[int | None] = []  # the page of each widget, in step with `widgets`
        self.top_level = len(chain) == 1

    def inherited(self, key: str) -> Any:
        for node in self.chain:
            if key in node:
                return node[key].get_object()
        return None

    @property
    def flags(self) -> int:
        ff = self.inherited("/Ff")
        return int(ff) if isinstance(ff, int | NumberObject) else 0

    @property
    def ft(self) -> str:
        ft = self.inherited("/FT")
        return str(ft) if ft is not None else ""

    @property
    def kind(self) -> str:
        """text, checkbox, radio, list, combo, signature, button, or "" for something that is not a field."""
        ft, ff = self.ft, self.flags
        if ft == "/Tx":
            return "text"
        if ft == "/Btn":
            if ff & F_PUSHBUTTON:
                return "button"
            return "radio" if ff & F_RADIO else "checkbox"
        if ft == "/Ch":
            return "combo" if ff & F_COMBO else "list"
        if ft == "/Sig":
            return "signature"
        return ""

    @property
    def signed(self) -> bool:
        """A signature field that carries a signature."""
        return self.kind == "signature" and isinstance(self.inherited("/V"), DictionaryObject)

    @property
    def read_only(self) -> bool:
        return bool(self.flags & F_READ_ONLY)

    @property
    def required(self) -> bool:
        return bool(self.flags & F_REQUIRED)

    @property
    def max_length(self) -> int | None:
        value = self.inherited("/MaxLen")
        return int(value) if isinstance(value, int | NumberObject) and int(value) > 0 else None

    def states(self) -> list[str]:
        """The names a checkbox or radio widget can be set to, "Off" excluded, in the order they appear."""
        found: list[str] = []
        for widget in self.widgets:
            normal = _normal_appearance(widget)
            if isinstance(normal, DictionaryObject) and not isinstance(normal, StreamObject):
                for key in normal:
                    state = str(key).lstrip("/")
                    if state != OFF and state not in found:
                        found.append(state)
        return found

    def labels(self) -> list[str] | None:
        """A button group's /Opt (one label per state index), when it has one."""
        opt = self.inherited("/Opt")
        if isinstance(opt, ArrayObject) and self.kind in ("checkbox", "radio"):
            return [str(x.get_object()) for x in opt]
        return None

    def choices(self) -> list[tuple[str, str]]:
        """(export value, display text) for a list or combo box."""
        opt = self.inherited("/Opt")
        out: list[tuple[str, str]] = []
        if isinstance(opt, ArrayObject):
            for item in opt:
                item = item.get_object()
                if isinstance(item, ArrayObject) and len(item) >= 2:
                    out.append((str(item[0].get_object()), str(item[1].get_object())))
                elif isinstance(item, ArrayObject) and len(item) == 1:
                    out.append((str(item[0].get_object()), str(item[0].get_object())))
                else:
                    out.append((str(item), str(item)))
        return out


def _normal_appearance(widget: DictionaryObject) -> Any:
    ap = widget.get("/AP")
    if ap is None:
        return None
    normal = ap.get_object().get("/N")
    return normal.get_object() if normal is not None else None


class Form:
    """The fields of one document, by full name, plus what could not be read."""

    def __init__(self) -> None:
        self.fields: dict[str, Field] = {}
        self.duplicates: list[str] = []
        self.xfa = False
        self.signed = False  # a signature is present: any change would invalidate it
        self.has_acroform = False
        self.partial_names: set[str] = set()  # the last name part of every field that has a parent


def _page_index(pages: Any) -> tuple[dict[int, int], dict[int, int]]:
    """Widget annotation -> page number, by object number and (for direct objects) by identity."""
    by_id: dict[int, int] = {}
    by_ref: dict[int, int] = {}
    for number, page in enumerate(pages, start=1):
        annots = page.get("/Annots")
        if annots is None:
            continue
        annots = annots.get_object()
        if not isinstance(annots, ArrayObject):
            continue
        for ref in annots:
            if isinstance(ref, IndirectObject):
                by_ref.setdefault(ref.idnum, number)
            by_id.setdefault(id(ref.get_object()), number)
    return by_ref, by_id


def read_form(root: Any, pages: Any, *, max_fields: int = 5000) -> Form:
    """Walk /AcroForm /Fields. A cycle, a nesting deeper than MAX_DEPTH or more than `max_fields` fields
    is refused rather than followed."""
    form = Form()
    acro = root.get("/AcroForm")
    if acro is None:
        return form
    acro = acro.get_object()
    if not isinstance(acro, DictionaryObject):
        return form
    form.has_acroform = True
    form.xfa = "/XFA" in acro
    flags = acro.get("/SigFlags")
    form.signed = bool(isinstance(flags, int | NumberObject) and int(flags) & 2)
    top = acro.get("/Fields")
    if top is None:
        return form
    by_ref, by_id = _page_index(pages)
    seen: set[int] = set()

    def walk(ref: Any, prefix: str, chain: tuple[DictionaryObject, ...], depth: int) -> None:
        if depth > MAX_DEPTH:
            raise PdfFormError(
                f"the form's fields are nested more than {MAX_DEPTH} levels deep", reason="form_structure"
            )
        node = ref.get_object()
        if not isinstance(node, DictionaryObject) or id(node) in seen:
            return
        seen.add(id(node))
        title = node.get("/T")
        partial = str(title.get_object()) if title is not None else ""
        name = (f"{prefix}.{partial}" if prefix else partial) if partial else prefix
        chain = (node, *chain)
        kids_obj = node.get("/Kids")
        kids = list(kids_obj.get_object()) if kids_obj is not None else []
        named = [k for k in kids if isinstance(k.get_object(), DictionaryObject) and "/T" in k.get_object()]
        if named:
            for kid in named:
                walk(kid, name, chain, depth + 1)
            kids = [k for k in kids if k not in named]  # widgets of this field that have no name of their own
            if not kids or not name or not Field(name, node, chain).kind:
                return
        if not name:
            return
        if len(form.fields) >= max_fields:
            raise PdfFormError(
                f"the form has more than {max_fields} fields; this is more than can be handled",
                reason="too_many_fields",
            )
        field = Field(name, node, chain)
        if len(chain) > 1 and partial:
            form.partial_names.add(partial)
        members = [(k, k.get_object()) for k in kids] if kids else [(ref, node)]
        for member_ref, member in members:
            if not isinstance(member, DictionaryObject):
                continue
            field.widgets.append(member)
            page = by_ref.get(member_ref.idnum) if isinstance(member_ref, IndirectObject) else None
            page = page or by_id.get(id(member))
            field.widget_pages.append(page)
            if page and page not in field.pages:
                field.pages.append(page)
        field.pages.sort()
        if name in form.fields:
            form.duplicates.append(name)
        else:
            form.fields[name] = field

    for ref in list(top.get_object()):
        walk(ref, "", (), 0)
    form.signed = form.signed or any(f.signed for f in form.fields.values())
    return form


# -- describing and reading values ----------------------------------------------------------------------


def _plain(value: Any) -> str:
    text = str(value)
    return text[1:] if isinstance(value, NameObject) and text.startswith("/") else text


def current_value(field: Field) -> Any:
    """What the field holds now: text, "Off" or a state name, an export value, or a list of them (None: empty)."""
    value = field.inherited("/V")
    kind = field.kind
    if kind == "signature":
        return None  # never the signature dictionary or its contents
    if kind in ("checkbox", "radio"):
        if value is None:
            states = {_plain(w.get("/AS")) for w in field.widgets if w.get("/AS") is not None}
            on = [s for s in field.states() if s in states]
            return on[0] if on else OFF
        return _plain(value) or OFF
    if value is None:
        return None
    if isinstance(value, ArrayObject):
        return [str(v.get_object()) for v in value]
    if isinstance(value, StreamObject):
        try:
            return str(value.get_data().decode("utf-8", "replace"))
        except Exception:
            return None
    return str(value)


def describe(field: Field) -> dict[str, Any]:
    kind = field.kind
    out: dict[str, Any] = {"name": field.name, "type": kind, "pages": field.pages, "value": current_value(field)}
    if kind == "checkbox":
        states = field.states() or [CHECKBOX_ON_DEFAULT]
        out["allowed"] = [True, False, *states] if len(states) == 1 else [False, *states]
        out["on_state"] = states[0]
    elif kind == "radio":
        out["allowed"] = field.states()
        labels = field.labels()
        if labels:
            out["labels"] = labels
    elif kind in ("list", "combo"):
        out["options"] = [{"value": v, "label": label} for v, label in field.choices()]
        if kind == "combo" and field.flags & F_EDITABLE:
            out["editable"] = True
        if kind == "list" and field.flags & F_MULTISELECT:
            out["multiple"] = True
    elif kind == "text":
        if field.flags & F_MULTILINE:
            out["multiline"] = True
        if field.max_length:
            out["max_length"] = field.max_length
    elif kind in ("signature", "button"):
        out["fillable"] = False
        if kind == "signature" and field.signed:
            out["signed"] = True
    rects = widget_rects(field)
    if rects:
        out["rect"] = rects[0]
        if len(rects) > 1:
            out["rects"] = rects  # one per widget (a radio group's buttons, a field repeated on a page)
    if field.required:
        out["required"] = True
    if field.read_only:
        out["read_only"] = True
    return out


def widget_rects(field: Field) -> list[dict[str, Any]]:
    """Where the widgets sit: {page, x, y, w, h} in PDF points, origin at the page's bottom left."""
    found: list[dict[str, Any]] = []
    for widget, page in zip(field.widgets, field.widget_pages, strict=False):
        raw = widget.get("/Rect")
        raw = raw.get_object() if raw is not None else None
        if not isinstance(raw, ArrayObject) or len(raw) != 4 or page is None:
            continue
        try:
            x0, y0, x1, y1 = (float(v.get_object()) for v in raw)
        except (TypeError, ValueError):
            continue
        found.append(
            {
                "page": page,
                "x": round(min(x0, x1), 1),
                "y": round(min(y0, y1), 1),
                "w": round(abs(x1 - x0), 1),
                "h": round(abs(y1 - y0), 1),
            }
        )
    return found


def inspect_reader(reader: PdfReader, *, max_fields: int = 5000) -> dict[str, Any]:
    """Everything the model needs to know about a PDF's form."""
    form = read_form(reader.trailer["/Root"], reader.pages, max_fields=max_fields)
    fields = [describe(f) for f in form.fields.values() if f.kind]
    out: dict[str, Any] = {"has_form": bool(fields), "xfa": form.xfa, "fields": fields}
    if form.signed:
        out["signed"] = True
    if form.duplicates:
        out["duplicate_names"] = sorted(set(form.duplicates))
    if form.xfa:
        out["note"] = (
            "this is an XFA form (Adobe LiveCycle): its values live in XML that this tool cannot fill; "
            "ask the user for an AcroForm (non-XFA) version or fill it in Adobe Acrobat"
        )
    elif form.signed:
        out["note"] = (
            "this PDF carries a digital signature: filling it would invalidate the signature, so it cannot be "
            "filled here"
        )
    elif not fields:
        out["note"] = (
            "this PDF has no fillable form fields. The blanks (if any) are only drawn on the page; "
            "this tool cannot write text onto them"
        )
    return out


def open_reader(data: bytes) -> PdfReader:
    if b"%PDF-" not in data[:1024]:
        raise PdfFormError("the file is not a PDF", reason="not_a_pdf")
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise PdfFormError(
                "the PDF is encrypted (password-protected or restricted), which this tool cannot open; remove the protection first",
                reason="encrypted",
            )
        len(reader.pages)  # parses the page tree
        reader.trailer["/Root"]
    except PdfFormError:
        raise
    except Exception as exc:
        raise PdfFormError(
            f"the PDF cannot be read ({type(exc).__name__}: {str(exc)[:160]})", reason="damaged"
        ) from exc
    return reader


# -- validating values ------------------------------------------------------------------------------------


class _Reject(Exception):
    def __init__(self, message: str, allowed: Any = None) -> None:
        super().__init__(message)
        self.message = message
        self.allowed = allowed


def _control(char: str) -> bool:
    return char < " " or char == "\x7f"


def _check_shown(text: str, *, newlines: bool = False) -> None:
    """The appearances use a Western European font (Windows-1252): refuse what it cannot show, never write '?'.
    Control characters are refused too (a line break only where `newlines`): they draw nothing and have no place
    in a form value."""
    controls = sorted({c for c in text if _control(c) and not (newlines and c in "\n\r")})
    if controls:
        shown = ", ".join(f"U+{ord(c):04X}" for c in controls[:8])
        raise _Reject(
            f"cannot contain control characters ({shown}): remove them"
            + ("" if newlines else "; a line break needs a multiline field"),
            {"control_characters": [ord(c) for c in controls]},
        )
    bad = sorted({c for c in text if not _control(c) and not _encodable(c)})
    if bad:
        shown = ", ".join(f'"{c}"' for c in bad[:8])
        raise _Reject(
            f"cannot show the characters {shown}: the form is filled with a Western European font "
            "(Latin letters with accents, and signs such as the euro), not other alphabets",
            {"unsupported_characters": bad},
        )


def _encodable(char: str) -> bool:
    try:
        char.encode("cp1252")
    except UnicodeEncodeError:
        return False
    return True


def _shown(value: Any) -> str:
    text = repr(value) if not isinstance(value, str) else '"' + value + '"'
    return text if len(text) <= 80 else text[:77] + '..."'


def _listing(items: list[Any], limit: int = 12) -> str:
    shown = [("true" if x is True else "false" if x is False else f'"{x}"') for x in items[:limit]]
    more = f" (and {len(items) - limit} more)" if len(items) > limit else ""
    return ", ".join(shown) + more


def coerce(field: Field, value: Any) -> Any:
    """The value to store for this field, or _Reject. Text: a str. Checkbox and radio: a state name or None
    (off). List and combo: the export value (a list of them when several are chosen), None to clear."""
    kind = field.kind
    if kind in ("signature", "button"):
        raise _Reject(f"is a {kind} and cannot be filled")
    if field.read_only:
        raise _Reject("is read-only in this form")
    if kind == "text":
        if value is None:
            return ""
        if isinstance(value, bool) or not isinstance(value, str | int | float):
            raise _Reject(f"needs text, not {_shown(value)}")
        text = value if isinstance(value, str) else (str(int(value)) if float(value).is_integer() else str(value))
        _check_shown(text, newlines=True)  # a line break in a single-line field is refused just below
        limit = field.max_length
        if limit and len(text) > limit:
            raise _Reject(f"takes at most {limit} characters, and this has {len(text)}", {"max_length": limit})
        if "\n" in text and not field.flags & F_MULTILINE:
            raise _Reject("is a single-line field; give the text on one line")
        return text
    if kind == "checkbox":
        states = field.states() or [CHECKBOX_ON_DEFAULT]
        allowed = [True, False, *states] if len(states) == 1 else [False, *states]
        if value is True:
            if len(states) > 1:
                raise _Reject(
                    f"has several on-states ({_listing(states)}); give the one to choose, or false", [False, *states]
                )
            return states[0]
        if value is False or value is None or (isinstance(value, str) and value.strip().lstrip("/") in ("", OFF)):
            return None
        if isinstance(value, str) and value.strip().lstrip("/") in states:
            return value.strip().lstrip("/")
        raise _Reject(f"takes {_listing(allowed)}, not {_shown(value)}", allowed)
    if kind == "radio":
        states = field.states()
        labels = field.labels() or []
        allowed = list(states)
        if value is None or value is False or (isinstance(value, str) and value.strip().lstrip("/") in ("", OFF)):
            if field.flags & F_NO_TOGGLE_TO_OFF:
                raise _Reject(f"must have one option chosen: {_listing(allowed)}", allowed)
            return None
        if isinstance(value, str):
            wanted = value.strip().lstrip("/")
            if wanted in states:
                return wanted
            if wanted in labels and labels.index(wanted) < len(states):
                return states[labels.index(wanted)]
        raise _Reject(f"takes one of {_listing(allowed)}, not {_shown(value)}", allowed)
    if kind in ("list", "combo"):
        choices = field.choices()
        multi = kind == "list" and bool(field.flags & F_MULTISELECT)
        editable = kind == "combo" and bool(field.flags & F_EDITABLE)
        if value is None or value == "" or value == []:
            return [] if multi else None
        items = value if isinstance(value, list) else [value]
        if len(items) > 1 and not multi:
            raise _Reject("takes one value, not a list", [{"value": v, "label": label} for v, label in choices])
        chosen: list[str] = []
        for item in items:
            if isinstance(item, bool) or not isinstance(item, str | int | float):
                raise _Reject(f"takes one of its options, not {_shown(item)}")
            text = item if isinstance(item, str) else str(item)
            match = next((v for v, _ in choices if v == text), None)
            if match is None:
                match = next((v for v, label in choices if label == text), None)
            if match is None:
                folded = [v for v, label in choices if text.casefold() in (v.casefold(), label.casefold())]
                match = folded[0] if len(set(folded)) == 1 else None
            if match is None and editable:
                _check_shown(text)
                match = text
            if match is None:
                allowed = [{"value": v, "label": label} for v, label in choices]
                names = ", ".join(f'"{v}"' if v == label else f'"{label}" (value {v})' for v, label in choices[:12])
                more = f" (and {len(choices) - 12} more)" if len(choices) > 12 else ""
                raise _Reject(f"takes one of its options ({names}{more}), not {_shown(item)}", allowed)
            chosen.append(match)
        return chosen if multi else chosen[0]
    raise _Reject("is not a field this tool can fill")


def _normalise(field: Field, stored: Any) -> Any:
    """The form of a stored value that current_value() returns, for comparing after a re-read."""
    if field.kind in ("checkbox", "radio"):
        return stored or OFF
    if field.kind in ("list", "combo"):
        if isinstance(stored, list):
            return stored or None
        return stored
    return stored if stored != "" else None


# -- appearances ------------------------------------------------------------------------------------------


def _da_parts(field: Field, widget: DictionaryObject, acro: Any) -> tuple[float, str]:
    """(font size, colour operators) from the default appearance string."""
    da = widget.get("/DA")
    da = da.get_object() if da is not None else field.inherited("/DA")
    if da is None and acro is not None and "/DA" in acro:
        da = acro["/DA"].get_object()
    text = str(da or "")
    size = 0.0
    found = re.search(r"([\d.]+)\s+Tf", text)
    if found:
        size = float(found.group(1))
    colour = re.search(r"((?:[\d.]+\s+){1,4}(?:g|rg|k))\b", text)
    return size, colour.group(1) if colour else "0 g"


def _resolved(node: DictionaryObject, key: str) -> Any:
    value = node.get(key)
    return value.get_object() if value is not None else None


def _colour_ops(value: Any, stroke: bool) -> bytes | None:
    if not isinstance(value, ArrayObject) or len(value) not in (1, 3, 4):
        return None
    comps = " ".join(f"{float(x.get_object()):.3f}" for x in value)
    op = {1: "G" if stroke else "g", 3: "RG" if stroke else "rg", 4: "K" if stroke else "k"}[len(value)]
    return f"{comps} {op}\n".encode()


def _pdf_text(text: str) -> bytes:
    raw = text.encode("cp1252", "replace")
    return b"(" + raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)") + b")"


def _add_object(writer: PdfWriter, obj: Any) -> Any:
    add = getattr(writer, "_add_object", None) or writer.add_object  # type: ignore[attr-defined]
    return add(obj)


# fmt: off
_HELVETICA = (
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
)
# fmt: on


def _char_width(char: str) -> float:
    """Helvetica's advance width in 1/1000 em; an accented letter is as wide as its base letter."""
    code = ord(char)
    if not 32 <= code < 127:
        base = unicodedata.normalize("NFD", char)[0]
        code = ord(base) if 32 <= ord(base) < 127 else 0
    return float(_HELVETICA[code - 32]) if code else 556.0


def _text_width(text: str, size: float) -> float:
    return sum(_char_width(c) for c in text) * size / 1000


def _frame(widget: DictionaryObject) -> tuple[float, float, list[float] | None]:
    """(drawing width, drawing height, matrix) of a widget's appearance: /MK /R turns it by 90, 180 or 270."""
    rect_array: Any = widget["/Rect"]
    rect = [float(x.get_object()) for x in rect_array]
    width, height = abs(rect[2] - rect[0]), abs(rect[3] - rect[1])
    rotation = 0
    mk = _resolved(widget, "/MK")
    if isinstance(mk, DictionaryObject) and "/R" in mk:
        r: Any = mk["/R"].get_object()
        rotation = int(r) % 360
    if rotation == 90:
        return height, width, [0, 1, -1, 0, width, 0]
    if rotation == 180:
        return width, height, [-1, 0, 0, -1, width, height]
    if rotation == 270:
        return height, width, [0, -1, 1, 0, 0, height]
    return width, height, None


def _wrap(text: str, size: float, room: float) -> list[str]:
    lines: list[str] = []
    for paragraph in re.split(r"\r\n|\n|\r", text):
        line = ""
        for word in paragraph.split(" "):
            trial = f"{line} {word}" if line else word
            if line and _text_width(trial, size) > room:
                lines.append(line)
                line = word
            else:
                line = trial
        lines.append(line)
    return lines


AUTO_MAX = 12.0  # the size an auto-sized field starts from
AUTO_MIN = 6.0  # and the smallest it is shrunk to; text that still does not fit is clipped and reported


ASCENT = 0.718  # Helvetica: the height of its capitals, digits and ascenders, in em
DESCENT = 0.207  # and how far g, j, p, q, y and the like reach below the baseline


def _fit_height(size: float, window: float) -> tuple[float, bool]:
    """(font size, whether its glyphs fit the window's height) for one line. The field's own /DA size is kept
    when it fits; otherwise the size is the largest, up to AUTO_MAX, whose ascenders and descenders fit the
    window, never below AUTO_MIN (a window lower than that is reported, not drawn smaller)."""
    room = window / (ASCENT + DESCENT)
    if size > 0 and size <= room + 0.01:
        return size, True
    fs = min(AUTO_MAX, room)
    floor = min(AUTO_MIN, size) if size > 0 else AUTO_MIN
    if fs < floor:
        fs = floor
    return fs, fs <= room + 0.01


def _baseline(fs: float, inset: float, height: float) -> float:
    """The baseline that centres the glyph box (descent to ascent) in the clip window."""
    window = max(height - 2 * inset, 1.0)
    return inset + (window - (ASCENT + DESCENT) * fs) / 2 + DESCENT * fs


def _draw_text(
    field: Field, text: str, width: float, height: float, inset: float, size: float, colour: str
) -> tuple[bytes, bool]:
    """The text of a text field or a combo box: /Q alignment, multiline wrapping, comb cells, password dots.
    A field whose /DA size is 0 is auto-sized: it starts from AUTO_MAX (less when the box is low) and shrinks
    until the text fits the width (a comb field: its cells; a multiline field: its height), down to AUTO_MIN.
    A single-line field with a fixed size keeps it when its glyphs fit the box's height, and is shrunk the same
    way when they do not or the text would be cut off sideways. A box too low for AUTO_MIN is reported as clipped.
    Returns (the drawing operators, whether the text fits)."""
    flags = field.flags if field.kind == "text" else 0
    quad = field.inherited("/Q")
    quad = int(quad) if isinstance(quad, int | NumberObject) else 0
    if flags & F_PASSWORD:
        text = "*" * len(text)
    room = max(width - 2 * inset - 2, 1.0)
    tall = max(height - 2 * inset - 1, 1.0)
    window = max(height - 2 * inset, 1.0)  # the clip window the glyphs must stay inside

    def at(fs: float, x: float, y: float, line: str) -> bytes:
        head = f"BT\n/Helv {fs:.2f} Tf {colour}\n{x:.2f} {y:.2f} Td\n".encode()
        return head + _pdf_text(line) + b" Tj\nET\n"

    def left(line: str, fs: float) -> float:
        gap = room - _text_width(line, fs)
        return inset + 1 + (gap / 2 if quad == 1 else gap if quad == 2 else 0)

    if flags & F_COMB and field.max_length:
        cell = (width - 2 * (inset - 1)) / field.max_length
        fs, tall_enough = _fit_height(size, window)
        widest = max((_text_width(c, 1.0) for c in text), default=0.0)
        fit = fs
        if size <= 0 and widest > 0 and widest * fs > cell - 1:
            fit = max(min(fs, (cell - 1) / widest), AUTO_MIN)
            tall_enough = fit * (ASCENT + DESCENT) <= window + 0.01
        out = b""
        for i, char in enumerate(text[: field.max_length]):
            x = (inset - 1) + i * cell + (cell - _text_width(char, fit)) / 2
            out += at(fit, x, _baseline(fit, inset, height), char)
        return out, (widest * fit <= cell + 0.01 and tall_enough) or not text
    if flags & F_MULTILINE:
        fs = size if size > 0 else AUTO_MAX
        lines = _wrap(text, fs, room)
        while size <= 0 and fs > AUTO_MIN and (len(lines) * 1.15 * fs > tall + 0.15 * fs):
            fs = max(fs - 0.5, AUTO_MIN)
            lines = _wrap(text, fs, room)
        out = b""
        for number, line in enumerate(lines):
            out += at(fs, left(line, fs), height - inset - fs * (1 + 1.15 * number) + fs * 0.1, line)
        return out, len(lines) * 1.15 * fs <= tall + 0.15 * fs
    fs, fits = _fit_height(size, window)
    if text and _text_width(text, fs) > room:
        floor = min(AUTO_MIN, fs)
        fs = max(min(fs, room / _text_width(text, 1.0)), floor)
        fits = _text_width(text, fs) <= room + 0.01 and fs * (ASCENT + DESCENT) <= window + 0.01
    # no text, nothing to cut off, however low the box
    return at(fs, left(text, fs), _baseline(fs, inset, height), text), fits or not text


def _draw_list(
    field: Field,
    widget: DictionaryObject,
    texts: list[str],
    selected: list[int],
    width: float,
    height: float,
    inset: float,
    size: float,
    colour: str,
) -> bytes:
    out = b""
    fs = size if size > 0 else 12.0
    row = fs * 1.2
    visible = max(int((height - 2 * inset) // row), 1)
    top = 0
    ti = field.inherited("/TI")
    if isinstance(ti, int | NumberObject):
        top = max(int(ti), 0)
    if selected:
        if selected[0] < top:
            top = selected[0]
        elif selected[0] >= top + visible:
            top = selected[0] - visible + 1
    widget[NameObject("/TI")] = NumberObject(top)
    for line, index in enumerate(range(top, min(len(texts), top + visible + 1))):
        y_top = height - inset - line * row
        if index in selected:
            out += f"0.600 0.756 0.854 rg\n{inset:.2f} {y_top - row:.2f} {max(width - 2 * inset, 1):.2f} {row:.2f} re f\n".encode()
        out += (
            f"BT\n/Helv {fs:.2f} Tf {colour}\n{inset + 1:.2f} {y_top - row + (row - fs) / 2 + fs * 0.22:.2f} Td\n".encode()
            + _pdf_text(texts[index])
            + b" Tj\nET\n"
        )
    return out


def _appearance(
    writer: PdfWriter,
    field: Field,
    widget: DictionaryObject,
    acro: Any,
    text: str = "",
    texts: list[str] | None = None,
    selected: list[int] | None = None,
) -> bool:
    """Give one widget an appearance stream of its own: background and border from /MK, then the text of a text
    field or combo box, or the rows of a list box (the selection marked). Drawn here, not by the library, which
    writes nothing for a field whose widgets are separate kids, draws list boxes wrongly and shows a combo's value
    instead of its label. A rotated widget (/MK /R) gets its /Matrix. Returns False when the text does not fit
    the box even at the smallest size (it is clipped)."""
    width, height, matrix = _frame(widget)
    size, colour = _da_parts(field, widget, acro)
    mk = _resolved(widget, "/MK")
    mk = mk if isinstance(mk, DictionaryObject) else DictionaryObject()
    border = 1.0
    bs = widget.get("/BS")
    if bs is not None and "/W" in bs.get_object():
        border = float(bs.get_object()["/W"].get_object())
    out = b"/Tx BMC\nq\n"
    background = _colour_ops(_resolved(mk, "/BG"), False)
    if background:
        out += background + f"0 0 {width:.2f} {height:.2f} re f\n".encode()
    edge = _colour_ops(_resolved(mk, "/BC"), True)
    if edge and border > 0:
        out += (
            edge
            + f"{border:.2f} w {border / 2:.2f} {border / 2:.2f} {width - border:.2f} {height - border:.2f} re S\n".encode()
        )
    inset = border + 1.0
    out += f"{inset:.2f} {inset:.2f} {max(width - 2 * inset, 1):.2f} {max(height - 2 * inset, 1):.2f} re W n\n".encode()
    fits = True
    if field.kind == "list":
        out += _draw_list(field, widget, texts or [], selected or [], width, height, inset, size, colour)
    else:
        drawn, fits = _draw_text(field, text, width, height, inset, size, colour)
        out += drawn
    out += b"Q\nEMC\n"
    stream = DecodedStreamObject()
    stream.set_data(out)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
            NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
        }
    )
    entries: dict[Any, Any] = {
        NameObject("/Type"): NameObject("/XObject"),
        NameObject("/Subtype"): NameObject("/Form"),
        NameObject("/BBox"): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(width), FloatObject(height)]),
        NameObject("/Resources"): DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/Helv"): font})}
        ),
    }
    if matrix:
        entries[NameObject("/Matrix")] = ArrayObject([FloatObject(x) for x in matrix])
    stream.update(entries)
    widget[NameObject("/AP")] = DictionaryObject({NameObject("/N"): _add_object(writer, stream)})
    return fits


def _draw_field(writer: PdfWriter, field: Field, acro: Any, only_missing: bool = False) -> bool:
    """(Re)draw every widget of a text, combo or list field from its current value. False: some text is clipped."""
    value = current_value(field)
    fits = True
    for widget in field.widgets:
        if "/Rect" not in widget or (only_missing and isinstance(_normal_appearance(widget), StreamObject)):
            continue
        if field.kind == "text":
            fits = _appearance(writer, field, widget, acro, text=value or "") and fits
        else:
            texts, selected = _choice_view(field, value)
            fits = (
                _appearance(
                    writer,
                    field,
                    widget,
                    acro,
                    text=texts[0] if field.kind == "combo" and texts else "",
                    texts=texts,
                    selected=selected,
                )
                and fits
            )
    return fits


def _choice_view(field: Field, value: Any) -> tuple[list[str], list[int]]:
    """What a list or combo box shows: the texts (one label for a combo, every row for a list) and the selected rows."""
    choices = field.choices()
    exports = [v for v, _ in choices]
    chosen = value if isinstance(value, list) else ([value] if value else [])
    labels = dict(choices)
    selected = sorted(exports.index(v) for v in chosen if v in exports)
    if field.kind == "combo":
        return [labels.get(chosen[0]) or chosen[0]] if chosen else [""], selected
    return [label for _, label in choices], selected


# -- filling ----------------------------------------------------------------------------------------------


def _set_button(field: Field, state: str | None) -> None:
    name = NameObject("/" + state) if state else NameObject("/" + OFF)
    field.obj[NameObject("/V")] = name
    for widget in field.widgets:
        normal = _normal_appearance(widget)
        has = isinstance(normal, DictionaryObject) and not isinstance(normal, StreamObject) and name in normal
        widget[NameObject("/AS")] = name if (has or normal is None) and state else NameObject("/" + OFF)


def _set_choice(writer: PdfWriter, field: Field, acro: Any, stored: str | list[str] | None) -> None:
    choices = field.choices()
    exports = [v for v, _ in choices]
    chosen = stored if isinstance(stored, list) else ([stored] if stored else [])
    if "/I" in field.obj:
        del field.obj["/I"]
    if not chosen:
        if "/V" in field.obj:
            del field.obj["/V"]
    elif isinstance(stored, list):
        field.obj[NameObject("/V")] = ArrayObject([TextStringObject(v) for v in chosen])
        indices = sorted(exports.index(v) for v in chosen if v in exports)
        field.obj[NameObject("/I")] = ArrayObject([NumberObject(i) for i in indices])
    else:
        field.obj[NameObject("/V")] = TextStringObject(chosen[0])
    _draw_field(writer, field, acro)


def _root(writer: PdfWriter) -> Any:
    root = getattr(writer, "root_object", None)
    return root if root is not None else writer._root_object


def _drawable(widget: DictionaryObject) -> bool:
    """Flatten draws a widget that is visible and has the Print flag (a hidden or screen-only one is dropped)."""
    flags = widget.get("/F", 0)
    flags = int(flags) if isinstance(flags, int | NumberObject) else 0
    return "/Rect" in widget and not flags & 0b100010 and bool(flags & 4)


def _flatten(writer: PdfWriter) -> set[int]:
    """Draw every widget's current appearance into its page and remove the widgets and the form. Returns the
    identities (`id()`) of the widget dictionaries that were drawn."""
    drawn = 0
    done: set[int] = set()
    for page in writer.pages:
        annots: Any = page.get("/Annots")
        if annots is None:
            continue
        annots = annots.get_object()
        keep = ArrayObject()
        ops = b""
        names: dict[str, Any] = {}
        for ref in annots:
            annot = ref.get_object()
            if annot.get("/Subtype") != "/Widget":
                keep.append(ref)
                continue
            normal = _normal_appearance(annot)
            raw: Any = None
            if isinstance(normal, StreamObject):
                raw = annot["/AP"].get_object().raw_get("/N")
            elif isinstance(normal, DictionaryObject):
                state = annot.get("/AS")
                if state is not None and state in normal:
                    raw = normal.raw_get(state)
                elif "/" + OFF in normal:  # an unchecked box or radio keeps its empty frame
                    raw = normal.raw_get("/" + OFF)
            if raw is None or not _drawable(annot):  # no appearance, hidden, screen-only or not viewable
                continue
            stream = raw.get_object()
            if not isinstance(raw, IndirectObject):
                raw = _add_object(writer, stream)
            matrix = [float(x) for x in stream.get("/Matrix", [1, 0, 0, 1, 0, 0])]
            bbox = [float(x) for x in stream.get("/BBox", [0, 0, 0, 0])]
            corners = [(bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[0], bbox[3]), (bbox[2], bbox[3])]
            xs = [matrix[0] * x + matrix[2] * y + matrix[4] for x, y in corners]
            ys = [matrix[1] * x + matrix[3] * y + matrix[5] for x, y in corners]
            rect = [float(x) for x in annot["/Rect"]]
            rx0, ry0, rx1, ry1 = (
                min(rect[0], rect[2]),
                min(rect[1], rect[3]),
                max(rect[0], rect[2]),
                max(rect[1], rect[3]),
            )
            bw, bh = max(xs) - min(xs), max(ys) - min(ys)
            if bw <= 0 or bh <= 0:
                continue
            sx, sy = (rx1 - rx0) / bw, (ry1 - ry0) / bh
            tag = f"/CrFlat{drawn}"
            names[tag] = raw
            ops += f"q {sx:.5f} 0 0 {sy:.5f} {rx0 - min(xs) * sx:.4f} {ry0 - min(ys) * sy:.4f} cm {tag} Do Q\n".encode()
            drawn += 1
            done.add(id(annot))
        if ops:
            resources = page.get("/Resources")
            resources = resources.get_object() if resources is not None else page.get_inherited("/Resources")
            resources = DictionaryObject(resources) if resources is not None else DictionaryObject()
            page[NameObject("/Resources")] = resources
            xobjects = resources.get("/XObject")
            xobjects = DictionaryObject(xobjects.get_object()) if xobjects is not None else DictionaryObject()
            resources[NameObject("/XObject")] = xobjects
            for tag, ref in names.items():
                xobjects[NameObject(tag)] = ref
            before, after = DecodedStreamObject(), DecodedStreamObject()
            before.set_data(b"q\n")
            after.set_data(b"Q\n" + ops)
            current = page.raw_get("/Contents") if "/Contents" in page else ArrayObject()
            current_obj = current.get_object()
            parts = list(current_obj) if isinstance(current_obj, ArrayObject) else [current]
            page[NameObject("/Contents")] = ArrayObject(
                [_add_object(writer, before), *parts, _add_object(writer, after)]
            )
        if keep:
            page[NameObject("/Annots")] = keep
        else:
            del page["/Annots"]
    root = _root(writer)
    if "/AcroForm" in root:
        del root["/AcroForm"]
    return done


def _problem(name: str, value: Any, exc: _Reject) -> dict[str, Any]:
    problem: dict[str, Any] = {"field": name, "value": value, "message": f'field "{name}" {exc.message}'}
    if exc.allowed is not None:
        problem["allowed"] = exc.allowed
    return problem


def fill_pdf_form(
    data: bytes, values: dict[str, Any], flatten: bool = False, *, max_fields: int = 5000
) -> tuple[bytes, dict[str, Any]]:
    """Fill a PDF form. Every value is checked first; one that is not acceptable raises PdfFormError naming the
    field and what it takes, and nothing is written. Returns (the new PDF, a report): `filled` (each value
    re-read from the written file), `rejected` (values that did not take), `skipped` (fields not given a value),
    `diff`, and the page and field counts."""
    reader = open_reader(data)
    form = read_form(reader.trailer["/Root"], reader.pages, max_fields=max_fields)
    if form.xfa:
        raise PdfFormError(
            "this is an XFA form (Adobe LiveCycle). Its values live in XML that this tool cannot fill, and a "
            "viewer would show the XFA data, not the values written here. Ask for a non-XFA (AcroForm) version",
            reason="xfa",
        )
    if form.signed:
        raise PdfFormError(
            "filling this PDF would invalidate its digital signature, so it was not changed", reason="signed"
        )
    fillable = {n: f for n, f in form.fields.items() if f.kind}
    if not fillable:
        raise PdfFormError(
            "this PDF has no fillable form fields (no AcroForm). The blanks are only drawn on the page, "
            "so this tool cannot fill them",
            reason="no_form",
        )
    if not values:
        raise PdfFormError("give at least one field to fill", reason="no_values")

    problems: list[dict[str, Any]] = []
    plan: dict[str, Any] = {}
    for name, value in values.items():
        field = fillable.get(name)
        if field is None:
            near = difflib.get_close_matches(name, list(fillable), n=3, cutoff=0.5)
            hint = f"; the closest are {_listing(near)}" if near else "; call doc_outline (or form_fields) to list them"
            problems.append(
                {"field": name, "value": value, "message": f'there is no field named "{name}"{hint}', "allowed": near}
            )
            continue
        if field.kind == "text" and field.top_level and name in form.partial_names:
            problems.append(
                {
                    "field": name,
                    "value": value,
                    "message": f'field "{name}" shares its name with a field inside a group, so it cannot be filled safely',
                }
            )
            continue
        try:
            plan[name] = coerce(field, value)
        except _Reject as exc:
            problems.append(_problem(name, value, exc))
    if problems:
        lines = "; ".join(p["message"] for p in problems[:8])
        more = f" (and {len(problems) - 8} more)" if len(problems) > 8 else ""
        raise PdfFormError(
            f"{len(problems)} value{'s were' if len(problems) != 1 else ' was'} not acceptable and nothing was "
            f"written: {lines}{more}",
            reason="values",
            problems=problems,
        )

    before = {n: current_value(fillable[n]) for n in plan}
    writer = PdfWriter(clone_from=io.BytesIO(data))
    root = _root(writer)
    wform = read_form(root, writer.pages, max_fields=max_fields)
    acro = root["/AcroForm"].get_object()
    clipped: list[str] = []
    for name, stored in plan.items():
        field = wform.fields[name]
        if field.kind == "text":
            field.obj[NameObject("/V")] = TextStringObject(stored)
            if not _draw_field(writer, field, acro):
                clipped.append(name)
        elif field.kind in ("checkbox", "radio"):
            _set_button(field, stored)
        else:
            _set_choice(writer, field, acro, stored)
    # a value the form already held and no appearance: every widget with a value ends up drawn
    for field in wform.fields.values():
        if field.kind in ("text", "combo", "list") and current_value(field) not in (None, "", []):
            _draw_field(writer, field, acro, only_missing=True)
    written = io.BytesIO()
    writer.write(written)
    filled_bytes = written.getvalue()

    # re-read what was written: a value that did not take is reported, never assumed
    check = open_reader(filled_bytes)
    cform = read_form(check.trailer["/Root"], check.pages, max_fields=max_fields)
    filled: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for name, stored in plan.items():
        field = cform.fields.get(name)
        found = current_value(field) if field is not None else None
        wanted = _normalise(fillable[name], stored)
        took = _same(wanted, found)
        if took and field is not None and field.kind in ("checkbox", "radio") and stored:
            took = any(_plain(w.get("/AS")) == stored for w in field.widgets)
        entry = {"field": name, "value": _out(wanted)}
        if took:
            filled.append(entry)
        else:
            rejected.append({**entry, "found": _out(found)})
    diff = [
        f"{n}: {_shown(_out(before[n]))} -> {_shown(_out(_normalise(fillable[n], plan[n])))}"
        for n in plan
        if not _same(_normalise(fillable[n], plan[n]), before[n])
    ]
    flattened = 0
    out_bytes = filled_bytes
    if flatten:
        flat = PdfWriter(clone_from=io.BytesIO(filled_bytes))
        fform = read_form(_root(flat), flat.pages, max_fields=max_fields)
        drawn = _flatten(flat)
        flattened = len(drawn)
        missing = sorted(
            f.name
            for f in fform.fields.values()
            if f.kind != "signature"
            and _has_value(current_value(f))
            and any(_drawable(w) and id(w) not in drawn for w in f.widgets)
        )
        if missing:
            raise PdfFormError(
                f"flattening would lose the value of {_listing(missing)}: a widget has no appearance to draw. "
                "Nothing was written",
                reason="flatten_incomplete",
                problems=[{"field": n, "message": "its value has no appearance to draw"} for n in missing],
            )
        flat_bytes = io.BytesIO()
        flat.write(flat_bytes)
        out_bytes = flat_bytes.getvalue()
        after = open_reader(out_bytes)
        if read_form(after.trailer["/Root"], after.pages).fields:
            raise PdfFormError("the flattened PDF still has form fields; it was not delivered", reason="flatten")
    required_missing = sorted(
        n
        for n, f in cform.fields.items()
        if f.required and f.kind in ("text", "checkbox", "radio", "list", "combo") and not _has_value(current_value(f))
    )
    skipped = [
        n for n, f in fillable.items() if n not in plan and not f.read_only and f.kind not in ("signature", "button")
    ]
    report: dict[str, Any] = {
        "pages": len(reader.pages),
        "fields": len(fillable),
        "filled": filled,
        "rejected": rejected,
        "skipped": skipped,
        "flattened": bool(flatten),
        "required_missing": required_missing,
        "clipped": clipped,
        "diff": diff,
    }
    if flatten:
        report["widgets_drawn"] = flattened
    return out_bytes, report


def _has_value(value: Any) -> bool:
    return value not in (None, "", [], OFF)


def _same(wanted: Any, found: Any) -> bool:
    if isinstance(wanted, list) or isinstance(found, list):
        return sorted(wanted or []) == sorted(found or [])
    return (wanted or None) == (found or None)


def _out(value: Any) -> Any:
    return value if value is not None else ""
