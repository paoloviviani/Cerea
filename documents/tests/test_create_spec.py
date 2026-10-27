"""The spec is validated before anything is built: every refusal names the place and what would have been valid."""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import pytest

from cerea_documents import create, spec
from cerea_documents.config import Limits
from cerea_documents.errors import DocumentError, InvalidRequest

LIMITS = Limits()
P = {"type": "paragraph", "text": "x"}


def refused(fmt: str, doc: dict[str, Any], needle: str, limits: Limits = LIMITS) -> InvalidRequest:
    with pytest.raises(InvalidRequest) as ei:
        create.create({"format": fmt, "spec": doc}, None, {}, limits)
    assert needle in str(ei.value), f"{needle!r} not in {str(ei.value)!r}"
    assert ei.value.status == 422
    return ei.value


def test_unknown_block_type_lists_what_exists() -> None:
    err = refused("docx", {"blocks": [P, {"type": "banner", "text": "x"}]}, "blocks[1]: unknown block type 'banner'")
    assert "heading" in err.details["available"] and "chart" in err.details["available"]


def test_slides_do_not_take_headings() -> None:
    err = refused(
        "pptx",
        {"slides": [{"title": "t", "body": [{"type": "heading", "level": 1, "text": "x"}]}]},
        "unknown block type 'heading'",
    )
    assert "heading" not in err.details["available"]


def test_extra_property_names_the_allowed_ones() -> None:
    err = refused("docx", {"blocks": [{"type": "paragraph", "text": "x", "colour": "red"}]}, "blocks[0] (paragraph)")
    assert "Allowed properties" in str(err) and "align" in str(err)
    assert "text" in err.details["properties"]


def test_missing_required_and_wrong_types() -> None:
    refused("docx", {"blocks": [{"type": "heading", "text": "x"}]}, "'level' is a required property")
    refused("docx", {"blocks": [{"type": "heading", "level": 9, "text": "x"}]}, "blocks[0] (heading): level")
    refused("docx", {"blocks": [{"type": "table"}]}, "'rows' is a required property")
    refused("xlsx", {"sheets": []}, "spec: sheets")
    refused("docx", {}, "give `blocks` (or `markdown`)")
    refused("pdf", {"blocks": [P], "theme": {"template": "brand.docx"}}, "cannot take styles from a template")


def test_text_or_runs_but_not_both_or_neither() -> None:
    refused(
        "docx",
        {"blocks": [{"type": "paragraph", "text": "a", "runs": [{"text": "b"}]}]},
        "exactly one of `text` and `runs`",
    )
    refused("docx", {"blocks": [{"type": "paragraph"}]}, "exactly one of `text` and `runs`")
    refused("docx", {"blocks": [{"type": "list", "items": [{"children": ["x"]}]}]}, "exactly one of `text` and `runs`")


def test_markdown_and_blocks_are_alternatives() -> None:
    refused("docx", {"markdown": "# x", "blocks": [P]}, "`blocks` or `markdown`, not both")


def test_fonts_colours_and_links_are_checked() -> None:
    refused("docx", {"theme": {"body_font": "Comic Sans MS"}, "blocks": [P]}, "is not one of")
    refused("docx", {"theme": {"accent": "red"}, "blocks": [P]}, "does not match")
    refused(
        "docx",
        {"blocks": [{"type": "paragraph", "runs": [{"text": "x", "link": "javascript:alert(1)"}]}]},
        "does not match",
    )
    refused("docx", {"theme": {"body_size_pt": 400}, "blocks": [P]}, "body_size_pt")
    refused("docx", {"theme": {"unknown": 1}, "blocks": [P]}, "Allowed properties")


def test_table_shape_errors() -> None:
    refused(
        "docx",
        {"blocks": [{"type": "table", "header": ["a", "b"], "rows": [["1", "2"]], "widths": [1]}]},
        "`widths` has 1 entries but the table has 2 columns",
    )
    refused(
        "docx", {"blocks": [{"type": "table", "header": ["a"], "rows": [["1", "2"]]}]}, "more cells than the header"
    )
    refused("docx", {"blocks": [{"type": "table", "rows": []}]}, "no columns")


def test_chart_data_errors() -> None:
    base = {"type": "chart", "chart_type": "column", "categories": ["a", "b"], "series": [{"name": "s", "values": [1]}]}
    refused("docx", {"blocks": [base]}, "series 0 ('s') has 1 values but there are 2 categories")
    refused(
        "docx",
        {
            "blocks": [
                {
                    **base,
                    "chart_type": "pie",
                    "series": [{"name": "a", "values": [1, 2]}, {"name": "b", "values": [1, 2]}],
                }
            ]
        },
        "exactly one series",
    )
    refused(
        "docx",
        {"blocks": [{**base, "chart_type": "scatter", "series": [{"name": "s", "values": [1]}]}]},
        "needs `points`",
    )
    refused("docx", {"blocks": [{**base, "chart_type": "radar"}]}, "radar")
    refused("docx", {"blocks": [{**base, "series": [{"name": "s"}]}]}, "needs `values`")
    refused(
        "docx",
        {"blocks": [{**base, "categories": ["a", "b"], "series": [{"name": "s", "values": [1, 2]}]}]},
        "chart values",
        replace(LIMITS, max_chart_points=1),
    )


def test_workbook_errors() -> None:
    sheet = {"name": "S", "rows": [["a"]]}
    refused("xlsx", {"sheets": [{"name": "a/b"}]}, "invalid or repeated")
    refused("xlsx", {"sheets": [{"name": "x" * 40}]}, "name")
    refused("xlsx", {"sheets": [sheet, {**sheet, "name": "s"}]}, "invalid or repeated")
    refused(
        "xlsx",
        {"sheets": [{**sheet, "cells": [{"ref": "A1", "value": 1, "formula": "=1"}]}]},
        "only one of value, formula and date",
    )
    refused("xlsx", {"sheets": [{**sheet, "cells": [{"ref": "ZZZZ1", "value": 1}]}]}, "ref")
    refused("xlsx", {"sheets": [{**sheet, "cells": [{"ref": "XFE1", "value": 1}]}]}, "outside the sheet")
    refused("xlsx", {"sheets": [{**sheet, "cells": [{"ref": "A1", "date": "31/01/2026"}]}]}, "ISO 8601")
    refused(
        "xlsx", {"sheets": [{**sheet, "rows": [[1], [2]], "tables": [{"name": "T", "range": "A1:A2"}]}]}, "header text"
    )
    refused(
        "xlsx",
        {"sheets": [{**sheet, "rows": [["h", "h"], [1, 2]], "tables": [{"name": "T", "range": "A1:B2"}]}]},
        "unique, non-empty header",
    )
    refused("xlsx", {"sheets": [{**sheet, "rows": [["=cmd|' /C calc'!A0"]]}]}, "external file or a command")
    refused("xlsx", {"sheets": [{**sheet, "rows": [["='C:\\\\x\\\\[a.xlsx]S'!A1"]]}]}, "external file or a command")
    refused(
        "xlsx",
        {"sheets": [{**sheet, "cells": [{"ref": "A1", "style": "Fancy", "value": 1}]}]},
        "named style 'Fancy' is not in the workbook",
    )
    refused(
        "xlsx",
        {"sheets": [{**sheet, "charts": [{"chart_type": "column", "data_range": "A1:A1", "anchor": "C1"}]}]},
        "category column",
    )


def test_deck_errors() -> None:
    refused("pptx", {"slides": [{"title": "t", "layout": "carousel"}]}, "unknown layout 'carousel'")
    refused(
        "pptx",
        {"slides": [{"title": "t", "images": [{"image": "a", "fit": "placeholder", "x_cm": 1}]}]},
        "alternatives",
    )
    refused("pptx", {"slides": [{"title": "t", "layout": "Custom"}]}, "Named layouts need `theme.template`")
    refused("pptx", {"slides": [{"title": "x"}] * 3}, "more than 2 slides", replace(LIMITS, max_slides=2))


def test_template_and_file_must_agree() -> None:
    refused("docx", {"theme": {"template": "brand.docx"}, "blocks": [P]}, "no template file came with the request")
    with pytest.raises(InvalidRequest, match="spec.theme.template is not set"):
        create.create({"format": "docx", "spec": {"blocks": [P]}}, b"PK", {}, LIMITS)


# ---- hostile specs ------------------------------------------------------------------------------


def nested(depth: int) -> dict[str, Any]:
    item: Any = "leaf"
    for _ in range(depth):
        item = {"text": "x", "children": [item]}
    return {"blocks": [{"type": "list", "items": [item]}]}


def test_deep_nesting_is_refused_before_building() -> None:
    err = refused("docx", nested(30), "nested more than 24 levels deep")
    assert err.reason == "too_deep"
    refused("docx", nested(8), "lists nest at most 6 levels")
    # far deeper than Python's own recursion limit: still a clean refusal, no crash
    deep: Any = {}
    cur = deep
    for _ in range(100_000):
        cur["a"] = {}
        cur = cur["a"]
    assert spec.depth_of(deep, 24) == 25
    refused("docx", {"blocks": [deep]}, "nested more than")


def test_oversized_specs() -> None:
    many = {"blocks": [P] * 50}
    refused("docx", many, "more than 10 blocks", replace(LIMITS, max_blocks=10))
    table = {"type": "table", "header": ["a", "b"], "rows": [["1", "2"]] * 100}
    refused("docx", {"blocks": [table]}, "table cells in total", replace(LIMITS, max_table_cells=50))
    refused(
        "xlsx",
        {"sheets": [{"name": "S", "rows": [[1] * 10] * 100}]},
        "more than 50 cells",
        replace(LIMITS, max_sheet_cells=50),
    )
    refused("docx", {"blocks": [{"type": "paragraph", "text": "x" * 25_000}]}, "is too long")
    refused("docx", {"blocks": [P] * 3001}, "blocks")


def test_the_envelope_is_validated_too() -> None:
    for body, needle in (
        ({"format": "rtf", "spec": {}}, "is not one of"),
        ({"format": "docx"}, "'spec' is a required property"),
        ({"format": "docx", "spec": {}, "extra": 1}, "Allowed properties"),
        ({"format": "docx", "spec": "text"}, "is not of type 'object'"),
    ):
        with pytest.raises(DocumentError) as ei:
            spec.validate_envelope(body, LIMITS)
        assert needle in str(ei.value)
    with pytest.raises(InvalidRequest, match="nested more than"):
        spec.validate_envelope({"format": "docx", "spec": json.loads("[" * 1 + "]")} | {"x": nested(40)}, LIMITS)


def test_failure_builds_nothing() -> None:
    """All or none: one bad block anywhere means the call fails and no file is produced."""
    with pytest.raises(InvalidRequest):
        create.create({"format": "docx", "spec": {"blocks": [P, P, {"type": "list", "items": []}]}}, None, {}, LIMITS)


def test_a_range_error_names_the_field_value_and_range_and_not_the_parents_keys() -> None:
    err = refused(
        "docx", {"blocks": [{"type": "heading", "level": 9, "text": "x"}]}, "level: 9 is more than the maximum"
    )
    assert "allowed range" in str(err)
    assert "properties" not in err.details and "required" not in err.details
