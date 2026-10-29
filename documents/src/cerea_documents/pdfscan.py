"""A scanned page, read for `doc_outline`: a page with no text layer whose content is one image that fills it.

A scan is tilted a little (the paper was not square on the glass), so the blank lines to write on slope, and text
placed with `place_text` has to follow them. This module estimates the tilt (`skew_deg`) and finds the horizontal
rules, in PDF page coordinates (the space of `place_text`: points, origin at the bottom left).

No OCR and no extra dependency: Pillow decodes and turns the image, numpy does the counting (it is already there
for matplotlib). The tilt is the angle at which the rows of dark pixels pile up most (a projection profile). The
rules are then read on the straightened image: a row of dark pixels that runs for a few centimetres, with clear
paper above it. Dotted and underscore lines are bridged; a printed word sitting on a line splits it, because the
ink above the line blocks that stretch.

Everything is budgeted (pages, pixels, rules, seconds) and nothing here ever raises into the outline: a page that
cannot be read just has no `skew_deg`.
"""

from __future__ import annotations

import math
import re
import time
from typing import Any

MAX_SCAN_PAGES = 4  # pages of a document analysed
SCAN_SECONDS = 8.0  # a safety net for the whole outline
MAX_PIXELS = 36_000_000  # a larger image is not decoded
WORK_SIDE = 2400  # the image is worked at this size at most (long side, pixels)
MAX_RULES_PER_PAGE = 80
MIN_RULE_PT = 24.0  # a rule shorter than this (about 8 mm) is not a line to write on
FILL = 0.8  # the image must cover this much of the page to make it a scan
MIN_TILT_SCORE = 1.02  # the best angle must beat the level one by this factor to be believed
_TOKEN = re.compile(rb"\s*(\[[^\]]*\]|/[^\s/\[\]()<>]*|\([^)]*\)|<<|>>|[^\s/\[\]()<>]+)")


def _placement(page: Any) -> tuple[list[float], str] | None:
    """(matrix of the unit square, image name) when the page's content draws exactly one image, else None."""
    try:
        data = page.get_contents().get_data()
    except Exception:
        return None
    stack: list[list[float]] = []
    ctm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    operands: list[bytes] = []
    drawn: list[tuple[list[float], str]] = []
    for match in _TOKEN.finditer(data[:2_000_000]):
        token = match.group(1)
        if token == b"q":
            stack.append(ctm)
        elif token == b"Q":
            ctm = stack.pop() if stack else [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        elif token == b"cm" and len(operands) >= 6:
            try:
                m = [float(v) for v in operands[-6:]]
            except ValueError:
                return None
            a, b, c, d, e, f = ctm
            ctm = [
                m[0] * a + m[1] * c,
                m[0] * b + m[1] * d,
                m[2] * a + m[3] * c,
                m[2] * b + m[3] * d,
                m[4] * a + m[5] * c + e,
                m[4] * b + m[5] * d + f,
            ]
            operands = []
        elif token == b"Do" and operands:
            drawn.append((ctm, operands[-1].decode("latin-1").lstrip("/")))
            operands = []
        elif token in (b"Tj", b"TJ", b"'", b'"'):
            return None  # text drawn on the page: not an image-only page
        elif token[:1].isalpha() or token in (b"*", b"'", b'"'):
            operands = []
        else:
            operands.append(token)
    return (drawn[0][0], drawn[0][1]) if len(drawn) == 1 else None


def _covers(matrix: list[float], box: tuple[float, float, float, float]) -> bool:
    a, b, c, d, e, f = matrix
    xs = [e, e + a, e + c, e + a + c]
    ys = [f, f + b, f + d, f + b + d]
    left, bottom, right, top = box
    width = min(max(xs), right) - max(min(xs), left)
    height = min(max(ys), top) - max(min(ys), bottom)
    return width > 0 and height > 0 and width * height >= FILL * (right - left) * (top - bottom)


def _load(page: Any, name: str) -> Any | None:
    """The page's image as an 8-bit grey Pillow image, or None."""
    try:
        resources = page["/Resources"].get_object()
        item = resources["/XObject"].get_object()["/" + name].get_object()
        if item.get("/Subtype") != "/Image":
            return None
        width, height = int(item["/Width"]), int(item["/Height"])
        if width < 100 or height < 100 or width * height > MAX_PIXELS:
            return None
        image = _decode(page, item)
        if image is None:
            return None
    except Exception:
        return None
    scale = WORK_SIDE / max(image.size)
    if scale < 1:
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))))
    return image


def _decode(page: Any, item: Any) -> Any | None:
    """The image as an 8-bit grey Pillow image, never decoding more than MAX_PIXELS pixels: the size the PDF
    declares is not the size the pixel data has, so the data's own header is checked before anything is decoded.
    A JPEG is decoded already reduced (Pillow's draft mode)."""
    import io
    import warnings

    from PIL import Image

    saved = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            if item.get("/Filter") == "/DCTDecode":
                picture = Image.open(io.BytesIO(item.get_data()))
                if picture.width * picture.height > MAX_PIXELS:
                    return None
                picture.draft("L", (WORK_SIDE, WORK_SIDE))
            else:
                pictures = page.images
                if len(pictures) != 1:
                    return None
                picture = pictures[0].image
                if picture.width * picture.height > MAX_PIXELS:
                    return None
            return picture.convert("L")
    except (Image.DecompressionBombError, Image.DecompressionBombWarning, OSError, ValueError):
        return None
    finally:
        Image.MAX_IMAGE_PIXELS = saved


def _threshold(grey: Any) -> Any:
    """Dark pixels (ink) as a boolean array: Otsu's threshold over the histogram."""
    import numpy as np

    hist = np.bincount(grey.ravel(), minlength=256).astype(float)
    total = hist.sum()
    levels = np.arange(256)
    weight = np.cumsum(hist)
    mean = np.cumsum(hist * levels)
    between = np.zeros(256)
    valid = (weight > 0) & (weight < total)
    w0 = weight[valid]
    m0 = mean[valid] / w0
    m1 = (mean[-1] - mean[valid]) / (total - w0)
    between[valid] = w0 * (total - w0) * (m0 - m1) ** 2
    cut = int(np.argmax(between))
    cut = min(cut, 200)  # a pale scan must not turn the paper into ink
    return grey <= cut


def _score(xs: Any, ys: Any, tilt: float) -> float:
    """How strongly the ink piles up in rows when the page is turned by `tilt` radians (counter-clockwise)."""
    import numpy as np

    rows = np.rint(ys + xs * math.tan(tilt)).astype(np.int64)
    rows -= rows.min()
    counts = np.bincount(rows, minlength=1).astype(float)
    return float((counts * counts).sum())


def estimate_skew(ink: Any, deadline: float) -> float | None:
    """The angle (degrees, counter-clockwise: positive when lines rise to the right) that straightens the ink, to
    about a tenth of a degree, within +-5; None when the page has too little ink or no angle stands out."""
    import numpy as np

    ys, xs = np.nonzero(ink)
    if len(xs) < 500:
        return None
    if len(xs) > 400_000:
        pick = np.random.default_rng(1).choice(len(xs), 400_000, replace=False)
        xs, ys = xs[pick], ys[pick]
    xs, ys = xs.astype(float), ys.astype(float)
    best, best_score = 0.0, -1.0
    for step in range(-20, 21):  # 0.25 degree steps
        if time.monotonic() > deadline:
            return None
        angle = step * 0.25
        score = _score(xs, ys, math.radians(angle))
        if score > best_score:
            best, best_score = angle, score
    fine, fine_score = best, best_score
    for step in range(-13, 14):  # 0.02 degree steps around it
        angle = best + step * 0.02
        score = _score(xs, ys, math.radians(angle))
        if score > fine_score:
            fine, fine_score = angle, score
    level = _score(xs, ys, 0.0)
    if fine_score < level * MIN_TILT_SCORE and abs(fine) > 0.05:
        return 0.0 if abs(fine) < 0.3 else None
    return round(fine, 2)


def _runs(flags: Any) -> list[tuple[int, int]]:
    """[start, end) of each run of True in a 1-D boolean array."""
    import numpy as np

    padded = np.concatenate(([False], flags, [False]))
    change = np.flatnonzero(padded[1:] != padded[:-1])
    return [(int(change[i]), int(change[i + 1])) for i in range(0, len(change), 2)]


def find_rules(straight: Any, px_per_pt: float, deadline: float) -> list[tuple[float, float, float]]:
    """(x_start, x_end, y) in the straightened image's pixels for each rule: a row of ink at least MIN_RULE_PT
    long (dots and dashes bridged) with clear paper just above it."""
    import numpy as np

    height, width = straight.shape
    bridge = max(3, round(2.2 * px_per_pt))  # the gap between dots or dashes that still makes one line
    min_len = max(20, round(MIN_RULE_PT * px_per_pt))
    air = max(4, round(2.4 * px_per_pt))  # the paper that must be clear above a rule: a printed word is not
    # horizontal dilation by `bridge` for every row: ink within reach of ink
    cs = np.concatenate((np.zeros((height, 1), dtype=np.int32), np.cumsum(straight, axis=1, dtype=np.int32)), axis=1)
    lo = np.clip(np.arange(width) - bridge, 0, width)
    hi = np.clip(np.arange(width) + bridge + 1, 0, width)
    near = (cs[:, hi] - cs[:, lo]) > 0
    # a rule's row needs ink at least a third of the way along it (a dotted line has gaps, a word has holes too)
    found: list[tuple[int, int, int]] = []  # (row, start, end)
    for y in range(height):
        if y % 64 == 0 and time.monotonic() > deadline:
            break
        if near[y].sum() < min_len:
            continue
        for start, end in _runs(near[y]):
            if end - start < min_len:
                continue
            cols = np.flatnonzero(straight[y, start:end])
            if len(cols) == 0:
                continue
            start, end = start + int(cols[0]), start + int(cols[-1]) + 1  # the dilation's margin is not line
            if end - start < min_len or len(cols) < 0.28 * (end - start):
                continue
            found.append((y, start, end))
    # rows of one rule (a line is a few pixels thick) become one: the middle row of each stack
    rules: list[list[int]] = []  # [first row, last row, start, end]
    for y, start, end in found:
        for rule in reversed(rules[-24:]):
            if y - rule[1] <= 1 and min(end, rule[3]) - max(start, rule[2]) > 0.5 * (end - start):
                rule[1] = y
                rule[2] = min(rule[2], start)
                rule[3] = max(rule[3], end)
                break
        else:
            rules.append([y, y, start, end])
    # clear paper above and below: the columns with ink in the bands next to the rule are blocked; what is left clear is the rule
    out: list[tuple[float, float, float]] = []
    for first, last, start, end in rules:
        if last - first + 1 > 1.7 * px_per_pt + 3:  # thicker than a printed line (a letter's body, a bar, a photo)
            continue
        band = straight[max(first - air - 1, 0) : max(first - 1, 0), start:end]
        above = band.any(axis=0) if band.size else np.zeros(end - start, dtype=bool)
        # and below it: the top of a printed letter has paper above it too, but ink under it
        under = straight[last + 2 : last + 2 + air, start:end]
        if under.size:
            above = above | under.any(axis=0)
        # a speck of noise does not block: only a stretch of ink at least a pixel or two wide, twice over
        for s, e in _runs(~above):
            if e - s >= min_len:
                out.append((float(start + s), float(start + e), (first + last) / 2.0))
    return out


def analyse_page(page: Any, box: tuple[float, float, float, float], deadline: float) -> dict[str, Any] | None:
    """{skew_deg, rules} for an image-only page, or None when the page is not one (or cannot be read)."""
    try:
        placed = _placement(page)
        if placed is None or not _covers(placed[0], box):
            return None
        image = _load(page, placed[1])
        if image is None:
            return None
        import numpy as np
        from PIL import Image

        grey = np.asarray(image, dtype=np.uint8)
        ink = _threshold(grey)
        skew_img = estimate_skew(ink, deadline)
        if skew_img is None:
            return {"image_only": True}
        a, b, c, d, e, f = placed[0]
        w_px, h_px = image.size

        # image pixel (x, y) -> page point: the unit square, with row 0 at the top
        def to_page(px: float, py: float) -> tuple[float, float]:
            s, t = px / w_px, 1.0 - py / h_px
            return a * s + c * t + e, b * s + d * t + f

        # the tilt as it is on the page: the direction of a level image row, mapped through the placement
        ox, oy = to_page(0, 0)
        theta = math.radians(skew_img)
        dx, dy = to_page(math.cos(theta), -math.sin(theta))
        skew_page = math.degrees(math.atan2(dy - oy, dx - ox))
        if skew_page > 180 - 45:
            skew_page -= 180
        if skew_page < -(180 - 45):
            skew_page += 180
        # a scan placed turned by 90 degrees has its lines up and down on the page: not handled
        if abs(skew_page) > 45:
            return {"image_only": True}
        result: dict[str, Any] = {"image_only": True, "skew_deg": round(skew_page, 2), "rules": []}
        # straighten: turn the image clockwise by the tilt (Pillow turns counter-clockwise for positive angles)
        straight_img = Image.fromarray((ink * 255).astype(np.uint8)).rotate(
            -skew_img, resample=Image.Resampling.BILINEAR, center=(w_px / 2, h_px / 2), fillcolor=0
        )
        straight = np.asarray(straight_img) > 127
        px_per_pt = w_px / max(math.hypot(a, b), 1e-6)
        found = find_rules(straight, px_per_pt, deadline)
        cx, cy = w_px / 2, h_px / 2
        cos, sin = math.cos(theta), math.sin(theta)

        def back(px: float, py: float) -> tuple[float, float]:
            """A straightened pixel -> the original image's pixel: turn counter-clockwise by the tilt about the centre."""
            u, v = px - cx, py - cy
            return cx + u * cos + v * sin, cy - u * sin + v * cos

        rules = []
        for x1, x2, y in found:
            p1, p2 = to_page(*back(x1, y)), to_page(*back(x2, y))
            rules.append({"x1": round(p1[0], 1), "y1": round(p1[1], 1), "x2": round(p2[0], 1), "y2": round(p2[1], 1)})
        rules.sort(key=lambda r: (-(r["y1"] + r["y2"]), r["x1"]))
        if len(rules) > MAX_RULES_PER_PAGE:
            result["rules_truncated"] = len(rules) - MAX_RULES_PER_PAGE
        result["rules"] = rules[:MAX_RULES_PER_PAGE]
        return result
    except Exception:
        return None


def _box(page: Any) -> tuple[float, float, float, float] | None:
    try:
        crop = page.cropbox
        return float(crop.left), float(crop.bottom), float(crop.right), float(crop.top)
    except Exception:
        return None


def analyse(reader: Any, pages: list[int], seconds: float = SCAN_SECONDS) -> dict[int, dict[str, Any]]:
    """{page number: analysis} for the image-only ones among `pages` (1-based, no text layer)."""
    deadline = time.monotonic() + seconds
    out: dict[int, dict[str, Any]] = {}
    for number in pages[:MAX_SCAN_PAGES]:
        if time.monotonic() > deadline:
            break
        page = reader.pages[number - 1] if 1 <= number <= len(reader.pages) else None
        box = _box(page) if page is not None else None
        found = analyse_page(page, box, deadline) if box is not None else None
        if found is not None:
            out[number] = found
    return out
