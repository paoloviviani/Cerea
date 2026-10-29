"""place_text with `rotate` and `along`: text that follows a line that is not level (a scanned, tilted page)."""

from __future__ import annotations

import io
import math
from typing import Any

import pytest
from pypdf import PdfReader

from cerea_documents import core
from cerea_documents.config import Limits
from cerea_documents.errors import PatchError

from .pdf_fixtures import make_plain_pdf

LIMITS = Limits()


def place(items: list[dict[str, Any]], data: bytes | None = None) -> tuple[dict[str, Any], bytes]:
    return core.edit(
        data or make_plain_pdf(), "pdf", {"operations": [{"op": "place_text", "items": items}]}, {}, LIMITS
    )


def drawn(data: bytes, text: str) -> tuple[float, float, float]:
    """(x, y, angle in degrees) of the text as a text extractor reports it: its matrix and position."""
    found: list[tuple[float, float, float]] = []

    def visit(t: str, cm: list[float], tm: list[float], _font: Any, _size: float) -> None:
        if t.strip() == text:
            x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
            y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
            found.append((x, y, math.degrees(math.atan2(tm[1] * cm[0] + tm[0] * cm[1], tm[0] * cm[0] - tm[1] * cm[1]))))

    PdfReader(io.BytesIO(data)).pages[0].extract_text(visitor_text=visit)
    assert found, text
    return found[0]


def test_an_item_along_a_sloping_line_starts_on_it_and_follows_its_direction() -> None:
    # a line rising 1.1 degrees from (100, 400) toward (500, 407.7)
    x2, y2 = 500.0, 400.0 + 400.0 * math.tan(math.radians(1.1))
    result, data = place([{"page": 1, "text": "Rossi Marco", "along": [100, 400, x2, y2]}])
    x, y, angle = drawn(data, "Rossi Marco")
    assert (round(x, 1), round(y, 1)) == (100.0, 400.0)
    assert angle == pytest.approx(1.1, abs=0.05)
    assert result["operations"][0]["result"]["not_found"] == []  # found at its position after saving
    assert result["operations"][0]["result"]["placed"][0]["angle"] == pytest.approx(1.1, abs=0.01)
    assert result["verify"]["ok"]


def test_rotate_turns_the_text_counter_clockwise() -> None:
    _, data = place([{"page": 1, "text": "Up", "x": 300, "y": 300, "rotate": 90}])
    x, y, angle = drawn(data, "Up")
    assert (round(x), round(y)) == (300, 300)
    assert angle == pytest.approx(90, abs=0.01)


def test_fit_shrinks_text_to_the_line_and_refuses_what_cannot_fit() -> None:
    long = "Via Giuseppe Garibaldi 123"
    result, _ = place([{"page": 1, "text": long, "size": 12, "along": [100, 400, 200, 401], "fit": True}])
    assert result["operations"][0]["result"]["placed"][0]["size"] < 12
    with pytest.raises(PatchError) as err:
        place([{"page": 1, "text": long, "along": [100, 400, 130, 400], "fit": True}])
    assert "does not fit" in str(err.value)


def test_a_turned_box_that_leaves_the_page_is_refused() -> None:
    with pytest.raises(PatchError) as err:
        place([{"page": 1, "text": "Too long to turn here", "x": 20, "y": 30, "rotate": 90, "size": 40}])
    assert "leave the page" in str(err.value)
    with pytest.raises(PatchError):
        place([{"page": 1, "text": "x", "along": [10, 10, 10, 10]}])  # no direction
    with pytest.raises(PatchError):
        place([{"page": 1, "text": "x", "x": 1, "y": 1, "along": [10, 10, 50, 10]}])  # both ways


def test_fit_without_along_is_refused_not_ignored() -> None:
    with pytest.raises(PatchError) as err:
        place([{"page": 1, "text": "x", "x": 10, "y": 10, "fit": True}])
    assert "give along" in str(err.value)
