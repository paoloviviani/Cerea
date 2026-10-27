"""The document spec (ADR 0103 section 2): one JSON schema family for creating Word, Excel, PowerPoint
and PDF files. Validation is all-or-none and runs before any file is built; every message names the
place in the spec and what would have been valid.

`block_schemas(fmt)` and `top_schema(fmt)` are also what `/v1/capabilities` publishes, so the chat's
tool text has this module as its single source."""

from __future__ import annotations

import re
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError, best_match

from .config import Limits
from .errors import InvalidRequest

CREATE_FORMATS = ("docx", "xlsx", "pptx", "pdf")
PAGE_SIZES = ("A4", "A3", "A5", "Letter", "Legal")
CHART_TYPES = ("bar", "column", "stacked", "line", "area", "pie", "doughnut", "scatter")
TABLE_STYLES = ("banded", "grid", "minimal", "plain")
ALIGN = ("left", "center", "right")
# Fonts commonly installed with Office; the file only names a font, so the viewer's machine supplies it.
FONTS = (
    "Arial", "Book Antiqua", "Calibri", "Calibri Light", "Cambria", "Candara", "Century Gothic", "Consolas",
    "Constantia", "Corbel", "Courier New", "Garamond", "Georgia", "Palatino Linotype", "Segoe UI", "Tahoma",
    "Times New Roman", "Trebuchet MS", "Verdana",
)  # fmt: skip
SERIF = {"Book Antiqua", "Cambria", "Constantia", "Garamond", "Georgia", "Palatino Linotype", "Times New Roman"}
MONO = {"Consolas", "Courier New"}
COLOR_RE = r"^#?[0-9A-Fa-f]{6}$"
LINK_RE = r"^(https?://|mailto:)[^\s]+$"
SHEET_BAD = re.compile(r"[\[\]:*?/\\]")

_COLOR = {"type": "string", "pattern": COLOR_RE, "description": "hex colour such as 1F3864"}
_STR = {"type": "string", "maxLength": 20_000}
_SHORT = {"type": "string", "maxLength": 500}
_CM = {"type": "number", "exclusiveMinimum": 0, "maximum": 100}
_ALIGN = {"enum": list(ALIGN)}
_CELLREF = r"^[A-Z]{1,3}[1-9][0-9]{0,6}$"
_RANGE = r"^[A-Z]{1,3}[1-9][0-9]{0,6}(:[A-Z]{1,3}[1-9][0-9]{0,6})?$"

RUN = {
    "type": "object",
    "properties": {
        "text": _STR,
        "bold": {"type": "boolean"},
        "italic": {"type": "boolean"},
        "underline": {"type": "boolean"},
        "code": {"type": "boolean"},
        "color": _COLOR,
        "link": {"type": "string", "pattern": LINK_RE, "maxLength": 2000},
    },
    "required": ["text"],
    "additionalProperties": False,
}
_RUNS = {"type": "array", "items": RUN, "maxItems": 500, "description": "formatted text; use instead of text"}
_SIZE_PT = {"type": "number", "minimum": 8, "maximum": 96}
SHAPE_RUN = {**RUN, "properties": {**dict(RUN["properties"]), "size_pt": _SIZE_PT}}  # type: ignore[call-overload]
_TEXT = {"text": _STR, "runs": _RUNS}

THEME = {
    "type": "object",
    "description": (
        "Overrides of the built-in neutral style; give only what the person asked for. "
        "`template` names a file the person uploaded in the chat to take styles from."
    ),
    "properties": {
        "template": {"type": "string", "maxLength": 300},
        "body_font": {"enum": list(FONTS)},
        "heading_font": {"enum": list(FONTS)},
        "body_size_pt": {"type": "number", "minimum": 8, "maximum": 18},
        "heading_sizes_pt": {
            "type": "object",
            "description": "h1-h6: Word/PDF headings; h1 is also the PowerPoint title size (36 there)",
            "properties": {f"h{i}": {"type": "number", "minimum": 8, "maximum": 60} for i in range(1, 7)},
            "additionalProperties": False,
        },
        "colors": {
            "type": "object",
            "properties": {
                k: _COLOR
                for k in ("text", "heading", "accent", "muted", "link", "table_header_fill", "table_header_text")
            }
            | {"table_band": _COLOR, "border": _COLOR},
            "additionalProperties": False,
        },
        "accent": _COLOR,
        "line_spacing": {"type": "number", "minimum": 1.0, "maximum": 2.5},
        "paragraph_spacing_pt": {"type": "number", "minimum": 0, "maximum": 36},
        "table_style": {"enum": list(TABLE_STYLES)},
    },
    "additionalProperties": False,
}

_ITEM = {
    "anyOf": [
        {"type": "string", "maxLength": 5000},
        {
            "type": "object",
            "properties": {**_TEXT, "children": {"type": "array", "items": {"$ref": "#/$defs/item"}}},
            "additionalProperties": False,
        },
    ]
}
_CELL_OBJ = {
    "type": "object",
    "properties": {
        "text": {"type": ["string", "number", "boolean", "null"]},
        "bold": {"type": "boolean"},
        "align": _ALIGN,
        "fill": _COLOR,
        "color": _COLOR,
    },
    "required": ["text"],
    "additionalProperties": False,
}
_CELL = {"anyOf": [{"type": ["string", "number", "boolean", "null"]}, _CELL_OBJ]}


def _obj(props: dict[str, Any], required: list[str] | None = None, **extra: Any) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False, **extra}


def _block(kind: str, props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return _obj({"type": {"const": kind}, **props}, ["type", *(required or [])])


CHART_PROPS: dict[str, Any] = {
    "chart_type": {"enum": list(CHART_TYPES), "description": "stacked = stacked columns; scatter takes points"},
    "title": _SHORT,
    "categories": {"type": "array", "items": {"type": ["string", "number"]}, "maxItems": 5000},
    "series": {
        "type": "array",
        "minItems": 1,
        "maxItems": 20,
        "items": _obj(
            {
                "name": _SHORT,
                "values": {"type": "array", "items": {"type": "number"}, "maxItems": 5000},
                "points": {
                    "type": "array",
                    "items": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
                    "maxItems": 5000,
                    "description": "scatter only: [x, y] pairs",
                },
            },
            ["name"],
        ),
    },
    "x_title": _SHORT,
    "y_title": _SHORT,
    "legend": {"type": "boolean"},
    "render": {"enum": ["native", "image"], "description": "native = editable in Office; image = a PNG"},
}
_CHART_BOX = {"width_cm": _CM, "height_cm": _CM, "caption": _SHORT, "align": _ALIGN}

PROSE_BLOCKS: dict[str, dict[str, Any]] = {
    "heading": _block("heading", {"level": {"type": "integer", "minimum": 1, "maximum": 6}, **_TEXT}, ["level"]),
    "paragraph": _block("paragraph", {**_TEXT, "align": {"enum": [*ALIGN, "justify"]}}),
    "list": _block(
        "list",
        {"ordered": {"type": "boolean"}, "items": {"type": "array", "minItems": 1, "items": _ITEM}},
        ["items"],
    ),
    "table": _block(
        "table",
        {
            "header": {"type": "array", "items": {"type": "string", "maxLength": 1000}, "maxItems": 50},
            "rows": {"type": "array", "items": {"type": "array", "items": _CELL, "maxItems": 50}, "maxItems": 2000},
            "widths": {"type": "array", "items": {"type": "number", "exclusiveMinimum": 0}, "maxItems": 50},
            "align": {"type": "array", "items": _ALIGN, "maxItems": 50},
            "style": {"enum": list(TABLE_STYLES)},
            "caption": _SHORT,
        },
        ["rows"],
    ),
    "image": _block(
        "image",
        {"image": {"type": "string", "maxLength": 300}, "width_cm": _CM, "height_cm": _CM}
        | {"caption": _SHORT, "alt": _SHORT, "align": _ALIGN},
        ["image"],
    ),
    "chart": _block("chart", CHART_PROPS | _CHART_BOX, ["chart_type", "series"]),
    "page_break": _block("page_break", {}),
    "toc": _block("toc", {"title": _SHORT, "levels": {"type": "integer", "minimum": 1, "maximum": 6}}),
    "quote": _block("quote", {**_TEXT, "attribution": _SHORT}),
    "code": _block("code", {"text": {"type": "string", "maxLength": 50_000}, "language": _SHORT}, ["text"]),
}
SLIDE_BLOCK_NAMES = ("paragraph", "list", "table", "image", "chart", "quote", "code")
SLIDE_LAYOUTS = ("title", "title_content", "section", "two_content", "title_only", "blank")

_PLACED = {
    "x_cm": {"type": "number", "minimum": 0, "maximum": 200},
    "y_cm": {"type": "number", "minimum": 0, "maximum": 200},
}
BACKGROUND = {
    "anyOf": [
        _obj({"color": _COLOR}, ["color"]),
        _obj(
            {
                "gradient": {"type": "array", "items": _COLOR, "minItems": 2, "maxItems": 2},
                "angle": {"type": "number", "minimum": 0, "maximum": 360, "description": "degrees; 90 = downwards"},
            },
            ["gradient"],
        ),
        _obj({"image": {"type": "string", "maxLength": 300}, "fit": {"const": "cover"}}, ["image"]),
    ],
    "description": "slide background: a colour, a two-colour gradient or a picture cropped to cover the slide",
}
MAX_SHAPES = 40
SHAPE_KINDS = ("rect", "rounded_rect", "ellipse", "line", "arrow", "chevron", "text")
_SHAPE_CM = {"type": "number", "minimum": 0, "maximum": 100}
_SHAPE_POS_CM = {
    "type": "number",
    "minimum": -50,
    "maximum": 100,
    "description": "cm; negative only for a shape without text that bleeds off the slide",
}
SHAPE = _obj(
    {
        "kind": {"enum": list(SHAPE_KINDS)},
        "x_cm": _SHAPE_POS_CM,
        "y_cm": _SHAPE_POS_CM,
        "w_cm": _SHAPE_CM,
        "h_cm": _SHAPE_CM,
        "fill": {"anyOf": [_COLOR, {"const": "none"}]},
        "line": _obj({"color": _COLOR, "width_pt": {"type": "number", "minimum": 0.25, "maximum": 20}}),
        "radius": {"type": "number", "minimum": 0, "maximum": 50, "description": "cm, rounded_rect"},
        "text": _STR,
        "runs": {**_RUNS, "items": SHAPE_RUN, "description": "formatted text; use instead of text"},
        "color": _COLOR,
        "size_pt": {"type": "number", "minimum": 8, "maximum": 96},
        "align": _ALIGN,
        "valign": {"enum": ["top", "middle", "bottom"]},
        "layer": {"enum": ["back", "front"], "description": "default back: behind the title and body"},
    },
    ["kind", "x_cm", "y_cm", "w_cm", "h_cm"],
)
SLIDE = _obj(
    {
        "layout": {
            "type": "string",
            "maxLength": 200,
            "description": (
                f"one of {list(SLIDE_LAYOUTS)}, or (with theme.template) the name of a layout in the uploaded file"
            ),
        },
        "title": _SHORT,
        "subtitle": _SHORT,
        "body": {"type": "array", "items": {"type": "object"}, "maxItems": 50, "description": "blocks"},
        "body_right": {"type": "array", "items": {"type": "object"}, "maxItems": 50, "description": "two_content"},
        "notes": {"type": "string", "maxLength": 20_000},
        "background": BACKGROUND,
        "shapes": {
            "type": "array",
            "maxItems": MAX_SHAPES,
            "items": SHAPE,
            "description": "free shapes, in cm on the slide",
        },
        "images": {
            "type": "array",
            "maxItems": 20,
            "items": _obj(
                {
                    "image": {"type": "string", "maxLength": 300},
                    "fit": {"const": "placeholder"},
                    "width_cm": _CM,
                    "height_cm": _CM,
                    "alt": _SHORT,
                    **_PLACED,
                },
                ["image"],
            ),
        },
        "charts": {
            "type": "array",
            "maxItems": 10,
            "items": _obj({**CHART_PROPS, **_PLACED, "width_cm": _CM, "height_cm": _CM}, ["chart_type", "series"]),
        },
    }
)

_CELL_ENTRY = _obj(
    {
        "ref": {"type": "string", "pattern": _CELLREF},
        "value": {
            "type": ["string", "number", "boolean", "null"],
            "description": "a string starting with = is a formula",
        },
        "formula": {"type": "string", "maxLength": 8000},
        "date": {"type": "string", "maxLength": 40},
        "number_format": {"type": "string", "maxLength": 100},
        "bold": {"type": "boolean"},
        "italic": {"type": "boolean"},
        "fill": _COLOR,
        "color": _COLOR,
        "align": {"enum": [*ALIGN, "justify"]},
        "wrap": {"type": "boolean"},
        "style": {"type": "string", "maxLength": 100, "description": "a named style of the uploaded template"},
    },
    ["ref"],
)
_SHEET_CHART = _obj(
    {
        **{k: v for k, v in CHART_PROPS.items() if k not in ("categories", "series")},
        "data_range": {
            "type": "string",
            "pattern": _RANGE,
            "description": "cells plotted: first column = categories (x for scatter), first row = series names",
        },
        "anchor": {"type": "string", "pattern": _CELLREF},
        "width_cm": _CM,
        "height_cm": _CM,
    },
    ["chart_type", "data_range", "anchor"],
)
SHEET = _obj(
    {
        "name": {"type": "string", "minLength": 1, "maxLength": 31},
        "rows": {
            "type": "array",
            "maxItems": 5000,
            "items": {"type": "array", "items": _CELL, "maxItems": 200},
            "description": "plain rows of values from `start` (default A1); a string starting with = is a formula",
        },
        "start": {"type": "string", "pattern": _CELLREF},
        "header": {"type": "boolean", "description": "style the first row of `rows` as a header (bold, accent fill)"},
        "cells": {"type": "array", "maxItems": 20_000, "items": _CELL_ENTRY},
        "column_widths": {
            "type": "object",
            "description": 'column letter to width in characters, e.g. {"A": 24}',
            "propertyNames": {"pattern": r"^[A-Z]{1,3}$"},
            "additionalProperties": {"type": "number", "minimum": 1, "maximum": 255},
        },
        "freeze": {"type": "string", "pattern": _CELLREF},
        "autofilter": {"type": "string", "pattern": _RANGE},
        "merge": {"type": "array", "items": {"type": "string", "pattern": _RANGE}, "maxItems": 500},
        "tables": {
            "type": "array",
            "maxItems": 50,
            "items": _obj(
                {
                    "name": {"type": "string", "pattern": r"^[A-Za-z_][A-Za-z0-9_]{0,60}$"},
                    "range": {"type": "string", "pattern": _RANGE},
                },
                ["name", "range"],
            ),
        },
        "charts": {"type": "array", "maxItems": 20, "items": _SHEET_CHART},
        "images": {
            "type": "array",
            "maxItems": 20,
            "items": _obj(
                {
                    "image": {"type": "string", "maxLength": 300},
                    "at": {"type": "string", "pattern": _CELLREF},
                    "width_px": {"type": "integer", "minimum": 1, "maximum": 4000},
                    "height_px": {"type": "integer", "minimum": 1, "maximum": 4000},
                    "alt": _SHORT,
                },
                ["image", "at"],
            ),
        },
    },
    ["name"],
)

_HF = _obj(
    {
        "text": {"type": "string", "maxLength": 500, "description": "{page} and {pages} become the page fields"},
        "align": _ALIGN,
    },
    ["text"],
)
_MARGIN = {"type": "number", "minimum": 0.5, "maximum": 10}
PAGE = _obj(
    {
        "size": {"enum": list(PAGE_SIZES)},
        "orientation": {"enum": ["portrait", "landscape"]},
        "margins_cm": {
            "anyOf": [_MARGIN, _obj({k: _MARGIN for k in ("top", "bottom", "left", "right")})],
            "description": "one number for all sides, or {top, bottom, left, right}",
        },
    }
)
_COMMON = {
    "title": _SHORT,
    "language": {"type": "string", "pattern": r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$"},
    "theme": THEME,
}
TOP: dict[str, dict[str, Any]] = {
    "docx": _obj(
        {
            **_COMMON,
            "page": PAGE,
            "header": _HF,
            "footer": _HF,
            "blocks": {"type": "array", "items": {"type": "object"}, "maxItems": 3000},
            "markdown": {
                "type": "string",
                "maxLength": 500_000,
                "description": "alternative to blocks: prose with an optional front-matter",
            },
        }
    ),
    "xlsx": _obj(
        {**_COMMON, "sheets": {"type": "array", "minItems": 1, "maxItems": 50, "items": {"type": "object"}}}, ["sheets"]
    ),
    "pptx": _obj(
        {
            **_COMMON,
            "size": {"enum": ["16:9", "4:3"]},
            "slides": {"type": "array", "minItems": 1, "maxItems": 200, "items": {"type": "object"}},
        },
        ["slides"],
    ),
}
TOP["pptx"] = {
    **TOP["pptx"],
    "properties": {
        **TOP["pptx"]["properties"],
        "theme": {
            **THEME,
            "properties": {
                **dict(THEME["properties"]),  # type: ignore[call-overload]
                "slide_background": BACKGROUND,
                "heading_bold": {"type": "boolean", "description": "default true"},
                "slide_numbers": {"type": "boolean", "description": "not on slide 1"},
            },
        },
    },
}
TOP["pdf"] = TOP["docx"]
ENVELOPE: dict[str, Any] = _obj(
    {
        "format": {"enum": list(CREATE_FORMATS)},
        "spec": {"type": "object"},
        "file_name": {"type": "string", "maxLength": 200},
    },
    ["format", "spec"],
)
TEMPLATE_ENVELOPE: dict[str, Any] = _obj(
    {
        "format": {"enum": ["docx", "xlsx", "pptx"]},
        "values": {
            "type": "object",
            "minProperties": 1,
            "maxProperties": 500,
            "additionalProperties": {
                "anyOf": [
                    {"type": ["string", "number", "boolean", "null"]},
                    _obj(
                        {
                            "image": {"type": "string", "maxLength": 300},
                            "width_cm": _CM,
                            "height_cm": _CM,
                            "alt": _SHORT,
                        },
                        ["image"],
                    ),
                    {"type": "array", "items": {"type": ["string", "number", "boolean", "null"]}, "maxItems": 5000},
                ]
            },
        },
        "file_name": {"type": "string", "maxLength": 200},
    },
    ["values"],
)


def with_defs(schema: dict[str, Any]) -> dict[str, Any]:
    return {**schema, "$defs": {"item": _ITEM}}


def block_schemas(fmt: str) -> dict[str, dict[str, Any]]:
    """The block types a format accepts, as JSON schemas (what capabilities publishes)."""
    if fmt in ("docx", "pdf"):
        return {k: with_defs(v) for k, v in PROSE_BLOCKS.items()}
    if fmt == "pptx":
        return {k: with_defs(PROSE_BLOCKS[k]) for k in SLIDE_BLOCK_NAMES}
    return {}


def top_schema(fmt: str) -> dict[str, Any]:
    return TOP[fmt]


def create_schemas() -> dict[str, Any]:
    """Everything the chat needs to describe doc_create, per format."""
    out: dict[str, Any] = {}
    for fmt in CREATE_FORMATS:
        entry: dict[str, Any] = {"document": TOP[fmt], "blocks": block_schemas(fmt)}
        if fmt == "pptx":
            entry["slide"] = SLIDE
        if fmt == "xlsx":
            entry["sheet"] = SHEET
        out[fmt] = entry
    return out


# ---- validation ---------------------------------------------------------------------------------


def _check(schema: dict[str, Any], instance: Any, label: str, **details: Any) -> None:
    """Raise InvalidRequest for the best-matching error. A `label` that ends in ": " is a prefix as it is;
    any other label (`slides[3]`) is a place the error's own path continues from (`slides[3].shapes`)."""
    errors = list(Draft202012Validator(schema).iter_errors(instance))
    if not errors:
        return
    err = best_match(errors) or errors[0]
    extra: dict[str, Any] = {}
    if err.validator in ("additionalProperties", "required"):  # only here do the parent's keys help
        props = {k: v for k, v in (schema.get("properties") or {}).items() if k != "type"}
        extra = {"properties": sorted(props), "required": [r for r in schema.get("required", []) if r != "type"]}
    path = ".".join(str(p) for p in err.absolute_path)
    if label.endswith(": "):
        head = f"{label}{path}: " if path else label
    else:
        head = f"{label}.{path}: " if path else f"{label}: "
    raise InvalidRequest(f"{head}{friendly(err)}", reason="schema", details={**extra, **details})


_BOUND_WORDS = {"minimum": "less than the minimum", "maximum": "more than the maximum"}
_PER = {
    "shapes": "per slide",
    "body": "per slide",
    "body_right": "per slide",
    "images": "per slide",
    "charts": "per slide",
    "slides": "per deck",
    "sheets": "per workbook",
}
_ECHO = 60  # an instance longer than this (characters) is described, never repeated


def _what(value: Any) -> str:
    """A big value as a type and a size, so an error never repeats it."""
    if isinstance(value, list):
        return f"a list of {len(value)} items"
    if isinstance(value, dict):
        return f"an object with {len(value)} properties"
    if isinstance(value, str) and len(value) > _ECHO:
        return f"a text of {len(value)} characters"
    return repr(value)


def friendly(err: ValidationError) -> str:
    """The message of a schema error, short and without the offending value when that is big."""
    last = err.absolute_path[-1] if err.absolute_path else None
    if err.validator == "additionalProperties":
        schema = err.schema if isinstance(err.schema, dict) else {}
        allowed = sorted(schema.get("properties") or {})
        return f"{err.message} Allowed properties: {allowed}"
    if err.validator in ("maxItems", "minItems") and isinstance(err.instance, list):
        n = len(err.instance)
        noun = last if isinstance(last, str) else "items"
        noun = noun[:-1] if n == 1 and noun.endswith("s") else noun
        if err.validator == "maxItems":
            per = f" {_PER[last]}" if isinstance(last, str) and last in _PER else ""
            return f"{n} {noun}; {err.validator_value} at most{per}"
        return f"{n} {noun}; at least {err.validator_value} needed"
    if err.validator == "enum":
        return f"{_what(err.instance)} is not one of {err.validator_value}"
    if err.validator in _BOUND_WORDS and isinstance(err.schema, dict):
        lo, hi = err.schema.get("minimum"), err.schema.get("maximum")
        if lo is not None and hi is not None:
            span = f"{lo:g} to {hi:g}"
        else:
            span = f"{err.validator_value:g} or {'more' if err.validator == 'minimum' else 'less'}"
        return f"{err.instance:g} is {_BOUND_WORDS[err.validator]} ({err.validator_value:g}); allowed range {span}"
    # every other message (type, const, oneOf, maxLength, pattern, ...) repeats the instance with repr():
    # swap a list, an object or a long text for its type and size
    message = err.message
    if isinstance(err.instance, list | dict) or (isinstance(err.instance, str) and len(err.instance) > _ECHO):
        message = message.replace(repr(err.instance), _what(err.instance))
    return message


def depth_of(value: Any, limit: int) -> int:
    """Nesting depth of a JSON value, computed without recursion; stops once `limit` is passed."""
    deepest = 0
    stack: list[tuple[Any, int]] = [(value, 1)]
    while stack:
        v, d = stack.pop()
        if isinstance(v, dict | list):
            deepest = max(deepest, d)
            if deepest > limit:
                return deepest
            stack.extend((c, d + 1) for c in (v.values() if isinstance(v, dict) else v))
    return deepest


def check_depth(value: Any, limits: Limits) -> None:
    if depth_of(value, limits.max_spec_depth) > limits.max_spec_depth:
        raise InvalidRequest(
            f"the spec is nested more than {limits.max_spec_depth} levels deep; flatten it "
            "(lists may nest, but not without limit)",
            reason="too_deep",
        )


def validate_envelope(body: Any, limits: Limits, template: bool = False) -> None:
    if not isinstance(body, dict):
        raise InvalidRequest("the body must be a JSON object", reason="schema")
    check_depth(body, limits)
    _check(TEMPLATE_ENVELOPE if template else ENVELOPE, body, "invalid request body: ")


def has_text(b: dict[str, Any], where: str) -> None:
    if ("text" in b) == ("runs" in b):
        raise InvalidRequest(f"{where}: give exactly one of `text` and `runs`", reason="schema")


def _items(items: list[Any], where: str, depth: int, limits: Limits, count: list[int]) -> None:
    for i, it in enumerate(items):
        count[0] += 1
        if isinstance(it, dict):
            has_text(it, f"{where}[{i}]")
            if it.get("children"):
                if depth >= 6:
                    raise InvalidRequest(f"{where}[{i}]: lists nest at most 6 levels", reason="too_deep")
                _items(it["children"], f"{where}[{i}].children", depth + 1, limits, count)


def check_block(block: Any, allowed: dict[str, dict[str, Any]], where: str, limits: Limits, count: list[int]) -> None:
    if not isinstance(block, dict):
        raise InvalidRequest(
            f"{where}: a block is an object with a `type`; got {type(block).__name__}", reason="schema"
        )
    kind = block.get("type")
    if kind not in allowed:
        raise InvalidRequest(
            f"{where}: unknown block type {kind!r}; available here: {sorted(allowed)}",
            reason="unknown_block",
            details={"available": sorted(allowed)},
        )
    _check(allowed[kind], block, f"{where} ({kind}): ")
    count[0] += 1
    if kind in ("heading", "paragraph", "quote"):
        has_text(block, f"{where} ({kind})")
    elif kind == "list":
        _items(block["items"], f"{where}.items", 1, limits, count)
    elif kind == "table":
        _check_table(block, where, limits, count)
    elif kind == "chart":
        check_chart(block, f"{where} (chart)", limits)


def _check_table(b: dict[str, Any], where: str, limits: Limits, count: list[int]) -> None:
    cols = max([len(b.get("header") or []), *(len(r) for r in b["rows"])])
    if cols == 0:
        raise InvalidRequest(
            f"{where} (table): the table has no columns; give `header` or rows with cells", reason="schema"
        )
    for key in ("widths", "align"):
        if key in b and len(b[key]) != cols:
            raise InvalidRequest(
                f"{where} (table): `{key}` has {len(b[key])} entries but the table has {cols} columns", reason="schema"
            )
    if b.get("header") and any(len(r) > len(b["header"]) for r in b["rows"]):
        raise InvalidRequest(f"{where} (table): a row has more cells than the header has columns", reason="schema")
    count[1] += (len(b["rows"]) + 1) * cols
    if count[1] > limits.max_table_cells:
        raise InvalidRequest(
            f"the spec has more than {limits.max_table_cells} table cells in total", reason="too_large"
        )


def check_chart(c: dict[str, Any], where: str, limits: Limits) -> None:
    kind, series = c["chart_type"], c["series"]
    pts = 0
    for i, s in enumerate(series):
        if kind == "scatter":
            if "points" not in s:
                raise InvalidRequest(f"{where}: scatter series {i} needs `points` ([[x, y], ...])", reason="schema")
            pts += len(s["points"])
        else:
            if "values" not in s:
                raise InvalidRequest(f"{where}: series {i} needs `values` (one number per category)", reason="schema")
            if len(s["values"]) != len(c.get("categories") or []):
                raise InvalidRequest(
                    f"{where}: series {i} ({s['name']!r}) has {len(s['values'])} values but there are "
                    f"{len(c.get('categories') or [])} categories; they must match",
                    reason="schema",
                )
            pts += len(s["values"])
    if kind in ("pie", "doughnut") and len(series) != 1:
        raise InvalidRequest(f"{where}: a {kind} chart takes exactly one series; got {len(series)}", reason="schema")
    if pts > limits.max_chart_points:
        raise InvalidRequest(f"{where}: more than {limits.max_chart_points} chart values", reason="too_large")


def validate_spec(fmt: str, spec: dict[str, Any], limits: Limits) -> dict[str, Any]:
    """Validate `spec` for `fmt` (Markdown expanded first) and return the spec to build from.
    Raises InvalidRequest on the first problem; nothing is built before this passes."""
    check_depth(spec, limits)
    _check(TOP[fmt], spec, "spec: ")
    count = [0, 0]  # blocks, table cells
    if fmt in ("docx", "pdf"):
        spec = expand_markdown(spec)
        if "blocks" not in spec:
            raise InvalidRequest("spec: give `blocks` (or `markdown`)", reason="schema")
        allowed = block_schemas(fmt)
        for i, b in enumerate(spec["blocks"]):
            check_block(b, allowed, f"blocks[{i}]", limits, count)
    elif fmt == "xlsx":
        _check_sheets(spec["sheets"], limits)
    else:
        _check_slides(spec["slides"], limits, count)
    if count[0] > limits.max_blocks:
        raise InvalidRequest(f"the spec has more than {limits.max_blocks} blocks and items", reason="too_large")
    theme = spec.get("theme") or {}
    if "template" in theme and fmt == "pdf":
        raise InvalidRequest(
            "spec.theme.template: a PDF cannot take styles from a template file; use docx for that", reason="schema"
        )
    return spec


def _check_slides(slides: list[Any], limits: Limits, count: list[int]) -> None:
    if len(slides) > limits.max_slides:
        raise InvalidRequest(f"more than {limits.max_slides} slides", reason="too_large")
    allowed = block_schemas("pptx")
    for i, s in enumerate(slides):
        _check(SLIDE, s, f"slides[{i}]")
        for key in ("body", "body_right"):
            for j, b in enumerate(s.get(key) or []):
                check_block(b, allowed, f"slides[{i}].{key}[{j}]", limits, count)
        for j, c in enumerate(s.get("charts") or []):
            check_chart(c, f"slides[{i}].charts[{j}]", limits)
        for j, im in enumerate(s.get("images") or []):
            if im.get("fit") and any(k in im for k in ("x_cm", "y_cm", "width_cm", "height_cm")):
                raise InvalidRequest(
                    f"slides[{i}].images[{j}]: `fit` and an explicit box are alternatives", reason="schema"
                )
        _check_shapes(s.get("shapes") or [], f"slides[{i}]")
        count[0] += 1


def _check_shapes(shapes: list[dict[str, Any]], where: str) -> None:
    """What a shape may carry depends on its kind (its place on the slide is checked when the slide size is known)."""
    for j, sh in enumerate(shapes):
        at, kind = f"{where}.shapes[{j}]", sh["kind"]
        if kind in ("line", "arrow"):
            if not (sh["w_cm"] or sh["h_cm"]):
                raise InvalidRequest(f"{at}: a {kind} needs w_cm or h_cm above 0 (it runs from x, y)", reason="schema")
            if any(k in sh for k in ("fill", "text", "runs", "radius")):
                raise InvalidRequest(f"{at}: a {kind} takes `line` only (no fill, text or radius)", reason="schema")
        elif not (sh["w_cm"] and sh["h_cm"]):
            raise InvalidRequest(f"{at}: a {kind} needs w_cm and h_cm above 0", reason="schema")
        if kind == "text" and sh.get("fill", "none") != "none":
            raise InvalidRequest(f"{at}: a text box has no fill; use a rect to give it one", reason="schema")
        if "radius" in sh and kind != "rounded_rect":
            raise InvalidRequest(f"{at}: `radius` is for rounded_rect only", reason="schema")
        if "text" in sh and "runs" in sh:
            raise InvalidRequest(f"{at}: give one of `text` and `runs`", reason="schema")


def col_to_n(col: str) -> int:
    n = 0
    for ch in col:
        n = n * 26 + ord(ch) - 64
    return n


def split_ref(ref: str) -> tuple[int, int]:
    m = re.match(r"^([A-Z]{1,3})([0-9]+)$", ref)
    if not m:
        raise InvalidRequest(f"{ref!r} is not a cell reference such as B7", reason="schema")
    c, r = col_to_n(m.group(1)), int(m.group(2))
    if c > 16384 or r > 1_048_576:
        raise InvalidRequest(f"{ref} is outside the sheet (columns end at XFD, rows at 1048576)", reason="schema")
    return c, r


def _check_sheets(sheets: list[Any], limits: Limits) -> None:
    seen: set[str] = set()
    total = 0
    for i, sh in enumerate(sheets):
        _check(SHEET, sh, f"sheets[{i}]")
        name = sh["name"]
        if SHEET_BAD.search(name) or name.lower() in seen or name.startswith("'") or name.endswith("'"):
            raise InvalidRequest(
                f"sheets[{i}]: sheet name {name!r} is invalid or repeated (no []:*?/\\ , at most 31 characters, unique)",
                reason="schema",
            )
        seen.add(name.lower())
        total += sum(len(r) for r in sh.get("rows") or []) + len(sh.get("cells") or [])
        for ref in [*(c["ref"] for c in sh.get("cells") or []), sh.get("start", "A1"), sh.get("freeze", "A1")]:
            split_ref(ref)
        for c in sh.get("cells") or []:
            if sum(k in c for k in ("value", "formula", "date")) > 1:
                raise InvalidRequest(
                    f"sheets[{i}] cell {c['ref']}: give only one of value, formula and date", reason="schema"
                )
        for ch in sh.get("charts") or []:
            if ch["chart_type"] in ("pie", "doughnut") and ":" in ch["data_range"]:
                split_ref(ch["data_range"].split(":")[0])
        names = [t["name"].lower() for t in sh.get("tables") or []]
        if len(set(names)) != len(names):
            raise InvalidRequest(f"sheets[{i}]: table names must be unique", reason="schema")
    if total > limits.max_sheet_cells:
        raise InvalidRequest(f"the workbook spec has more than {limits.max_sheet_cells} cells", reason="too_large")


# ---- Markdown shorthand -------------------------------------------------------------------------

_INLINE = re.compile(
    r"(\*\*\*(?P<bi>[^*]+?)\*\*\*|\*\*(?P<b>[^*]+?)\*\*|(?<![\w*])\*(?P<i>[^*\s][^*]*?)\*(?![\w*])"
    r"|(?<!\w)_(?P<i2>[^_\s][^_]*?)_(?!\w)|`(?P<c>[^`]+)`|\[(?P<lt>[^\]]+)\]\((?P<lu>[^)\s]+)\))"
)
_HTML = re.compile(r"</?[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?/?>|<!--")
_ROW = re.compile(r"^\s*\|.*\|\s*$")
_SEP = re.compile(r"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$")
_LIST = re.compile(r"^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$")


def inline_runs(text: str) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    pos = 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            runs.append({"text": text[pos : m.start()]})
        if m.group("bi"):
            runs.append({"text": m.group("bi"), "bold": True, "italic": True})
        elif m.group("b"):
            runs.append({"text": m.group("b"), "bold": True})
        elif m.group("i") or m.group("i2"):
            runs.append({"text": m.group("i") or m.group("i2"), "italic": True})
        elif m.group("c"):
            runs.append({"text": m.group("c"), "code": True})
        else:
            url = m.group("lu")
            if not re.match(LINK_RE, url):
                raise InvalidRequest(
                    f"markdown link {url!r}: only http, https and mailto links are accepted", reason="markdown"
                )
            runs.append({"text": m.group("lt"), "link": url})
        pos = m.end()
    if pos < len(text):
        runs.append({"text": text[pos:]})
    return runs or [{"text": ""}]


def _text_fields(text: str) -> dict[str, Any]:
    runs = inline_runs(text)
    return {"text": runs[0]["text"]} if len(runs) == 1 and set(runs[0]) == {"text"} else {"runs": runs}


def _front_matter(lines: list[str]) -> tuple[dict[str, Any], list[str]]:
    if not lines or lines[0].strip() != "---":
        return {}, lines
    for end in range(1, min(len(lines), 30)):
        if lines[end].strip() == "---":
            meta: dict[str, Any] = {}
            for ln in lines[1:end]:
                if not ln.strip():
                    continue
                k, sep, v = ln.partition(":")
                if not sep:
                    raise InvalidRequest(f"markdown front-matter line {ln!r} is not `key: value`", reason="markdown")
                meta[k.strip().lower()] = v.strip().strip("\"'")
            return meta, lines[end + 1 :]
    return {}, lines


def _table(rows: list[str]) -> dict[str, Any]:
    def cells(line: str) -> list[str]:
        return [c.strip() for c in line.strip().strip("|").split("|")]

    head, sep, body = cells(rows[0]), cells(rows[1]), [cells(r) for r in rows[2:]]
    align = ["center" if s.startswith(":") and s.endswith(":") else "right" if s.endswith(":") else "left" for s in sep]
    n = len(head)
    block: dict[str, Any] = {
        "type": "table",
        "header": head,
        "rows": [(r + [""] * n)[:n] for r in body],
    }
    if any(a != "left" for a in align[:n]) and len(align) >= n:
        block["align"] = align[:n]
    return block


def markdown_blocks(text: str) -> tuple[dict[str, Any], list[dict[str, Any]], list[str]]:
    """Markdown to (front-matter, blocks, notes). No raw HTML: it is refused, not passed through."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    meta, lines = _front_matter(lines)
    blocks: list[dict[str, Any]] = []
    notes: list[str] = []
    para: list[str] = []
    i = 0

    def flush() -> None:
        if para:
            blocks.append({"type": "paragraph", **_text_fields(" ".join(s.strip() for s in para))})
            para.clear()

    while i < len(lines):
        ln = lines[i]
        stripped = ln.strip()
        if stripped.startswith("```"):
            flush()
            lang, code = stripped[3:].strip(), []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            if i >= len(lines):
                raise InvalidRequest("markdown: a ``` code fence is never closed", reason="markdown")
            blocks.append({"type": "code", "text": "\n".join(code), **({"language": lang} if lang else {})})
            i += 1
            continue
        if _HTML.search(ln):
            raise InvalidRequest(
                f"markdown line {i + 1}: raw HTML is not accepted ({stripped[:60]!r}); use Markdown or `blocks`",
                reason="markdown",
            )
        if not stripped:
            flush()
        elif stripped == "\\newpage":
            flush()
            blocks.append({"type": "page_break"})
        elif stripped.upper() == "[TOC]":
            flush()
            blocks.append({"type": "toc"})
        elif re.match(r"^#{1,6}\s", stripped):
            flush()
            level = len(stripped) - len(stripped.lstrip("#"))
            blocks.append(
                {"type": "heading", "level": level, **_text_fields(stripped[level:].strip().rstrip("#").strip())}
            )
        elif re.match(r"^(-{3,}|\*{3,}|_{3,})$", stripped):
            flush()
            notes.append("a horizontal rule in the Markdown was dropped; use \\newpage for a page break")
        elif (m := re.match(r"^!\[([^\]]*)\]\(([^)\s]+)\)$", stripped)) is not None:
            flush()
            blocks.append({"type": "image", "image": m.group(2), **({"alt": m.group(1)} if m.group(1) else {})})
        elif stripped.startswith(">"):
            flush()
            quote = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote.append(lines[i].strip().lstrip(">").strip())
                i += 1
            blocks.append({"type": "quote", **_text_fields(" ".join(q for q in quote if q))})
            continue
        elif _ROW.match(ln) and i + 1 < len(lines) and _SEP.match(lines[i + 1]) and "-" in lines[i + 1]:
            flush()
            rows = [ln, lines[i + 1]]
            i += 2
            while i < len(lines) and _ROW.match(lines[i]):
                rows.append(lines[i])
                i += 1
            blocks.append(_table(rows))
            continue
        elif _LIST.match(ln):
            flush()
            i = _list(lines, i, blocks)
            continue
        else:
            para.append(ln)
        i += 1
    flush()
    return meta, blocks, notes


def _list(lines: list[str], i: int, blocks: list[dict[str, Any]]) -> int:
    """Consume consecutive list lines starting at `i` (one list, nesting by indentation)."""
    first = _LIST.match(lines[i])
    assert first is not None
    ordered = first.group(2)[0].isdigit()
    root: list[Any] = []
    stack: list[tuple[int, list[Any]]] = [(len(first.group(1)), root)]
    while i < len(lines):
        m = _LIST.match(lines[i])
        if not m:
            break
        indent = len(m.group(1).expandtabs(4))
        if indent < stack[0][0]:
            indent = stack[0][0]
        while len(stack) > 1 and indent < stack[-1][0]:
            stack.pop()
        item = _text_fields(m.group(3))
        if indent > stack[-1][0]:
            parent_list = stack[-1][1]
            if not parent_list:
                parent_list.append({"text": ""})
            last = parent_list[-1]
            if isinstance(last, str):
                last = parent_list[-1] = {"text": last}
            children: list[Any] = last.setdefault("children", [])
            stack.append((indent, children))
        stack[-1][1].append(item["text"] if set(item) == {"text"} else item)
        i += 1
    blocks.append({"type": "list", "ordered": ordered, "items": root})
    return i


_MD_META = {"title", "language", "page_size", "orientation", "header", "footer", "footer_text"}


def expand_markdown(spec: dict[str, Any]) -> dict[str, Any]:
    """Replace `markdown` by the equivalent `blocks` (and front-matter settings). Explicit spec
    fields win over the front-matter."""
    if "markdown" not in spec:
        return spec
    if "blocks" in spec:
        raise InvalidRequest("spec: give `blocks` or `markdown`, not both", reason="schema")
    meta, blocks, notes = markdown_blocks(spec["markdown"])
    unknown = sorted(set(meta) - _MD_META)
    if unknown:
        raise InvalidRequest(
            f"markdown front-matter: unknown keys {unknown}; allowed: {sorted(_MD_META)}", reason="markdown"
        )
    out = {k: v for k, v in spec.items() if k != "markdown"}
    out["blocks"] = blocks
    if notes:
        out["_notes"] = sorted(set(notes))
    for key in ("title", "language"):
        if key in meta:
            out.setdefault(key, meta[key])
    page = dict(out.get("page") or {})
    if "page_size" in meta:
        page.setdefault("size", meta["page_size"])
    if "orientation" in meta:
        page.setdefault("orientation", meta["orientation"])
    if page:
        out["page"] = page
    for key, target in (("header", "header"), ("footer", "footer"), ("footer_text", "footer")):
        if key in meta:
            out.setdefault(target, {"text": meta[key]})
    return out
