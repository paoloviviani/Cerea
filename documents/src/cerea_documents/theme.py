"""The style of a created document: one neutral built-in set, plus the overrides in `spec.theme`.

With `theme.template` (a file the person uploaded) the template supplies the styles; only what the theme
names explicitly is applied on top (`Theme.explicit`)."""

from __future__ import annotations

from dataclasses import dataclass, field

from .spec import MONO, SERIF

DEFAULT_COLORS = {
    "text": "1F2933",
    "heading": "1F2933",
    "accent": "2F5597",
    "muted": "6B7280",
    "link": "2F5597",
    "table_header_fill": "2F5597",
    "table_header_text": "FFFFFF",
    "table_band": "F3F4F6",
    "border": "D1D5DB",
}
PALETTE = ("2F5597", "E4893B", "4C9F70", "C0504D", "8064A2", "4BACC6", "F2C14E", "7F7F7F")
HEADING_SIZES = {1: 22.0, 2: 16.0, 3: 13.0, 4: 11.5, 5: 11.0, 6: 11.0}


def hex6(value: str) -> str:
    return value.lstrip("#").upper()


@dataclass
class Theme:
    body_font: str = "Calibri"
    heading_font: str = "Calibri"
    body_size: float = 11.0
    heading_sizes: dict[int, float] = field(default_factory=lambda: dict(HEADING_SIZES))
    colors: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_COLORS))
    line_spacing: float = 1.15
    space_after: float = 6.0
    table_style: str = "banded"
    template: str | None = None
    slide_background: dict[str, object] | None = None  # pptx: the background of slides that name none
    explicit: set[str] = field(default_factory=set)

    def uses(self, key: str) -> bool:
        """Apply this setting to styles? Always for the built-in set; only if named when a template styles the file."""
        return self.template is None or key in self.explicit

    @property
    def palette(self) -> list[str]:
        return [self.colors["accent"], *PALETTE[1:]]

    def pdf_font(self, name: str) -> str:
        """The PDF's built-in fonts are DejaVu (embedded, full Unicode); pick the nearest of its three families."""
        return "DejaVuSerif" if name in SERIF else "DejaVuSansMono" if name in MONO else "DejaVuSans"


def resolve_theme(raw: dict[str, object] | None) -> Theme:
    t = Theme()
    raw = raw or {}
    if "template" in raw:
        t.template = str(raw["template"])
    if isinstance(raw.get("slide_background"), dict):
        t.slide_background = dict(raw["slide_background"])  # type: ignore[call-overload]
    for key in ("body_font", "heading_font"):
        if key in raw:
            setattr(t, key, str(raw[key]))
            t.explicit.add(key)
    if "body_size_pt" in raw:
        t.body_size = float(raw["body_size_pt"])  # type: ignore[arg-type]
        t.explicit.add("body_size")
    sizes = raw.get("heading_sizes_pt")
    if isinstance(sizes, dict):
        for k, v in sizes.items():
            t.heading_sizes[int(k[1:])] = float(v)
            t.explicit.add(f"heading_size_{k}")
    colors: dict[str, str] = {}
    given = raw.get("colors")
    if isinstance(given, dict):
        colors = {k: hex6(str(v)) for k, v in given.items()}
    if "accent" in raw:
        colors.setdefault("accent", hex6(str(raw["accent"])))
    if "accent" in colors:  # the accent also drives what the person did not colour separately
        for dependent in ("link", "table_header_fill"):
            colors.setdefault(dependent, colors["accent"])
    for k, v in colors.items():
        t.colors[k] = v
        t.explicit.add(f"color_{k}")
    if "line_spacing" in raw:
        t.line_spacing = float(raw["line_spacing"])  # type: ignore[arg-type]
        t.explicit.add("line_spacing")
    if "paragraph_spacing_pt" in raw:
        t.space_after = float(raw["paragraph_spacing_pt"])  # type: ignore[arg-type]
        t.explicit.add("space_after")
    if "table_style" in raw:
        t.table_style = str(raw["table_style"])
        t.explicit.add("table_style")
    return t
